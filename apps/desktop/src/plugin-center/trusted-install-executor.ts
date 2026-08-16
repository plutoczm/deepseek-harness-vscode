/** Successful trusted-install transaction from exact preflight through runtime evidence. */

import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import type {
  CompatibilityFingerprint,
  SupportedPluginPlatform,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import type { HostSupervisor } from '../host-supervisor.ts'
import { verifyPluginArtifact } from './artifact-verifier.ts'
import type { PluginArtifactDownloader } from './artifact-downloader.ts'
import {
  PluginOperationFailure,
  type PluginOperationControls,
  type PluginOperationRunner,
} from './operation-controller.ts'
import {
  installTrustedPackage,
  type TrustedPackageManagerOptions,
} from './package-manager.ts'
import type { PluginCompatibilityService } from './preflight-service.ts'
import type { ProfileMutationLock } from './profile-lock.ts'
import type { ProfileSnapshotStore } from './profile-snapshot-store.ts'
import { reconcileAndValidateInstalledBundle } from './profile-installation.ts'
import type { PluginRuntimeVerifier } from './runtime-verifier.ts'

/** Complete Desktop-owned dependencies of one trusted installation. */
export interface TrustedInstallExecutorOptions {
  readonly compatibility: PluginCompatibilityService
  readonly platform: SupportedPluginPlatform
  readonly downloader: PluginArtifactDownloader
  readonly profileLock: ProfileMutationLock
  readonly snapshotStore: ProfileSnapshotStore
  readonly packageManager: TrustedPackageManagerOptions
  readonly profileDirectory: string
  readonly installAnchor: string
  readonly host: HostSupervisor
  readonly reloadHost: (origin: string) => Promise<void>
  readonly runtimeVerifier: PluginRuntimeVerifier
  readonly postFingerprint: (
    selection: Awaited<ReturnType<PluginCompatibilityService['resolve']>>['selection'],
  ) => CompatibilityFingerprint | Promise<CompatibilityFingerprint>
}

function failure(
  code: ConstructorParameters<typeof PluginOperationFailure>[0],
  message: string,
  cause: unknown,
): PluginOperationFailure {
  return new PluginOperationFailure(code, message, { cause })
}

async function transitionOrThrow(
  controls: PluginOperationControls,
  phase: Parameters<PluginOperationControls['transition']>[0],
  generation?: number | null,
): Promise<void> {
  await controls.transition(phase, generation)
}

/** Build the controller runner that commits only after all joined evidence passes. */
export function createTrustedInstallRunner(options: TrustedInstallExecutorOptions): PluginOperationRunner {
  return async (request, controls: PluginOperationControls) => {
    if (request.action !== 'install') {
      throw new PluginOperationFailure('preflight-denied', 'trusted install runner accepts install actions only')
    }
    const resolved = await options.compatibility.resolve({
      pluginId: request.pluginId,
      version: request.version,
      action: 'install',
    })
    const candidate = resolved.candidate
    if (candidate === null || !resolved.decision.allowed) {
      throw new PluginOperationFailure('preflight-denied', 'trusted installation preflight denied the exact target')
    }

    await transitionOrThrow(controls, 'downloading')
    let artifact: Awaited<ReturnType<PluginArtifactDownloader['download']>>
    try {
      artifact = await options.downloader.download(candidate, options.platform, controls.operationId)
    } catch (error) {
      throw failure('download-failed', 'validated plugin artifact could not be downloaded', error)
    }

    await transitionOrThrow(controls, 'verifying-artifact')
    const verification = await verifyPluginArtifact({
      bytes: artifact.bytes,
      candidate,
      platform: options.platform,
    })
    if (!verification.verified) {
      throw new PluginOperationFailure('artifact-invalid', 'validated plugin artifact failed verification')
    }

    let lock: Awaited<ReturnType<ProfileMutationLock['acquire']>>
    try {
      lock = await options.profileLock.acquire(controls.operationId)
    } catch (error) {
      throw failure('profile-busy', 'selected Profile already has a mutation owner', error)
    }
    try {
      await transitionOrThrow(controls, 'snapshotting')
      let before: ReturnType<typeof readProfileManifest>
      let snapshot: Awaited<ReturnType<ProfileSnapshotStore['capture']>>
      try {
        const currentGeneration = options.host.current
        if (currentGeneration === undefined) throw new Error('current Host is unavailable before snapshotting')
        const priorRuntimeEvidence = await options.runtimeVerifier.readEvidence(currentGeneration.origin)
        before = readProfileManifest('desktop', options.profileDirectory)
        snapshot = await options.snapshotStore.capture(controls.operationId, candidate.packageName)
        await controls.recordFoundation(resolved.fingerprint, {
          snapshotId: snapshot.snapshotId,
          snapshotSha256: snapshot.snapshotSha256,
          profileIdentity: snapshot.profileIdentity,
          runtimeEvidence: priorRuntimeEvidence,
        })
      } catch (error) {
        throw failure('snapshot-failed', 'selected Profile could not be snapshotted before mutation', error)
      }

      const oldGeneration = options.host.current?.id ?? null
      let targetFingerprint: CompatibilityFingerprint | undefined
      await transitionOrThrow(controls, 'stopping-host', oldGeneration)
      let generation: Awaited<ReturnType<HostSupervisor['restart']>>
      try {
        generation = await options.host.restart(`install ${candidate.pluginId}@${candidate.version}`, async () => {
          await controls.completeSideEffect('stopping-host', oldGeneration)
          await transitionOrThrow(controls, 'installing', oldGeneration)
          try {
            await installTrustedPackage(options.packageManager, {
              packageName: candidate.packageName,
              version: candidate.version,
              artifactPath: artifact.path,
            })
          } catch (error) {
            throw failure('package-mutation-failed', 'fixed package mutation failed', error)
          }
          await controls.completeSideEffect('installing', oldGeneration)

          await transitionOrThrow(controls, 'validating-profile', oldGeneration)
          try {
            await reconcileAndValidateInstalledBundle({
              before,
              profileDirectory: options.profileDirectory,
              installAnchor: options.installAnchor,
              candidate,
            })
            targetFingerprint = await options.postFingerprint(resolved.selection)
            const installed = targetFingerprint.installedPlugins.find(plugin => plugin.pluginId === candidate.pluginId)
            if (installed?.version !== candidate.version || !installed.enabled
              || installed.packageName !== candidate.packageName) {
              throw new Error('installed Profile projection does not expose the exact active Bundle')
            }
          } catch (error) {
            if (error instanceof PluginOperationFailure) throw error
            throw failure('profile-invalid', 'mutated Profile failed exact-version validation', error)
          }
          await transitionOrThrow(controls, 'starting-host', oldGeneration)
        })
      } catch (error) {
        if (error instanceof PluginOperationFailure) throw error
        throw failure('host-restart-failed', 'replacement Host generation could not start', error)
      }
      await controls.completeSideEffect('starting-host', generation.id)

      await transitionOrThrow(controls, 'reloading', generation.id)
      try {
        await options.reloadHost(generation.origin)
      } catch (error) {
        throw failure('host-restart-failed', 'Desktop window could not reconnect to the replacement Host', error)
      }
      await controls.completeSideEffect('reloading', generation.id)
      await transitionOrThrow(controls, 'health-checking', generation.id)
      try {
        await options.runtimeVerifier.verifyHealth(generation.origin)
      } catch (error) {
        throw failure('host-restart-failed', 'replacement Host failed loopback health verification', error)
      }
      await transitionOrThrow(controls, 'verifying-runtime', generation.id)
      let runtimeEvidence: Awaited<ReturnType<PluginRuntimeVerifier['verifyActivation']>>
      try {
        runtimeEvidence = await options.runtimeVerifier.verifyActivation(generation.origin, candidate)
      } catch (error) {
        throw failure('runtime-evidence-missing', 'declared runtime activation evidence is incomplete', error)
      }
      if (targetFingerprint === undefined) {
        throw new PluginOperationFailure('internal', 'target fingerprint was not retained through Host restart')
      }
      return {
        hostGeneration: generation.id,
        fingerprint: targetFingerprint,
        runtimeEvidence,
      }
    } finally {
      await lock.release()
    }
  }
}
