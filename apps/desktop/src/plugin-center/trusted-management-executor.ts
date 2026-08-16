/** Trusted installed-plugin mutations using the same journal, snapshot, and recovery owner as install. */

import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  readProfileManifest,
  setProfileBundleEnabled,
} from '@deepseek-ai/dsh-app-boot'
import type {
  CatalogVersionPreflight,
  CompatibilityFingerprint,
  PluginMutationRequest,
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
  removeTrustedPackage,
  type TrustedPackageManagerOptions,
} from './package-manager.ts'
import type { PluginCompatibilityService } from './preflight-service.ts'
import type { ProfileMutationLock } from './profile-lock.ts'
import type { ProfileSnapshotStore } from './profile-snapshot-store.ts'
import {
  reconcileAndValidateInstalledBundle,
  reconcileAndValidateUninstalledBundle,
} from './profile-installation.ts'
import { readInstalledOwnedDataAuthority } from './installed-projection.ts'
import type { PluginOwnedDataAuthorityStore } from './owned-data.ts'
import type { PluginRuntimeVerifier } from './runtime-verifier.ts'

/** Complete Desktop-owned dependencies for installed-item management. */
export interface TrustedManagementExecutorOptions {
  readonly compatibility: PluginCompatibilityService
  readonly platform: SupportedPluginPlatform
  readonly downloader: PluginArtifactDownloader
  readonly verifyArtifact?: typeof verifyPluginArtifact
  readonly profileLock: ProfileMutationLock
  readonly snapshotStore: ProfileSnapshotStore
  readonly ownedDataAuthorityStore: PluginOwnedDataAuthorityStore
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

async function transition(
  controls: PluginOperationControls,
  phase: Parameters<PluginOperationControls['transition']>[0],
  generation?: number | null,
): Promise<void> {
  await controls.transition(phase, generation)
}

function requireManagedRequest(request: PluginMutationRequest): asserts request is PluginMutationRequest & {
  readonly action: 'update' | 'enable' | 'disable' | 'uninstall'
} {
  if (request.action === 'install') {
    throw new PluginOperationFailure('preflight-denied', 'management runner does not accept install actions')
  }
}

/** Build a runner that commits only after Profile intent and joined runtime evidence agree. */
export function createTrustedManagementRunner(options: TrustedManagementExecutorOptions): PluginOperationRunner {
  return async (request, controls) => {
    requireManagedRequest(request)
    const resolved = await options.compatibility.resolve({
      pluginId: request.pluginId,
      version: request.version,
      action: request.action,
    })
    const candidate = resolved.candidate
    const installedBefore = resolved.fingerprint.installedPlugins.find(plugin => plugin.pluginId === request.pluginId)
    if (candidate === null || installedBefore === undefined || !resolved.decision.allowed) {
      throw new PluginOperationFailure('preflight-denied', 'installed plugin action failed exact compatibility checks')
    }

    let replacedCandidate: CatalogVersionPreflight | undefined
    if (request.action === 'update') {
      const prior = await options.compatibility.resolve({
        pluginId: request.pluginId,
        version: installedBefore.version,
        action: installedBefore.enabled ? 'disable' : 'enable',
      })
      if (prior.candidate === null || prior.candidate.packageName !== candidate.packageName) {
        throw new PluginOperationFailure('preflight-denied', 'installed exact version has no matching catalog authority')
      }
      replacedCandidate = prior.candidate
    }

    await transition(controls, 'downloading')
    let artifact: Awaited<ReturnType<PluginArtifactDownloader['download']>> | undefined
    if (request.action === 'update') {
      try {
        artifact = await options.downloader.download(candidate, options.platform, controls.operationId)
      } catch (error) {
        throw failure('download-failed', 'validated update artifact could not be downloaded', error)
      }
    }

    await transition(controls, 'verifying-artifact')
    if (request.action === 'update') {
      if (artifact === undefined) throw new PluginOperationFailure('internal', 'update artifact was not retained')
      const verification = await (options.verifyArtifact ?? verifyPluginArtifact)({
        bytes: artifact.bytes,
        candidate,
        platform: options.platform,
      })
      if (!verification.verified) {
        throw new PluginOperationFailure('artifact-invalid', 'validated update artifact failed verification')
      }
    }

    let lock: Awaited<ReturnType<ProfileMutationLock['acquire']>>
    try {
      lock = await options.profileLock.acquire(controls.operationId)
    } catch (error) {
      throw failure('profile-busy', 'selected Profile already has a mutation owner', error)
    }

    try {
      await transition(controls, 'snapshotting')
      const currentGeneration = options.host.current
      if (currentGeneration === undefined) {
        throw new PluginOperationFailure('snapshot-failed', 'current Host is unavailable before snapshotting')
      }
      let priorRuntime: Awaited<ReturnType<PluginRuntimeVerifier['readEvidence']>>
      let before: ReturnType<typeof readProfileManifest>
      try {
        priorRuntime = await options.runtimeVerifier.readEvidence(currentGeneration.origin)
        before = readProfileManifest('desktop', options.profileDirectory)
        const snapshot = await options.snapshotStore.capture(controls.operationId, candidate.packageName)
        if (request.action === 'uninstall') {
          const authority = readInstalledOwnedDataAuthority({
            profileDirectory: options.profileDirectory,
            installAnchor: options.installAnchor,
            packageName: candidate.packageName,
            version: installedBefore.version,
          })
          await options.ownedDataAuthorityStore.capture({
            operationId: controls.operationId,
            pluginId: candidate.pluginId,
            packageName: candidate.packageName,
            version: authority.version,
            declarations: authority.declarations,
          })
        }
        await controls.recordFoundation(resolved.fingerprint, {
          snapshotId: snapshot.snapshotId,
          snapshotSha256: snapshot.snapshotSha256,
          profileIdentity: snapshot.profileIdentity,
          runtimeEvidence: priorRuntime,
        })
      } catch (error) {
        if (error instanceof PluginOperationFailure) throw error
        throw failure('snapshot-failed', 'selected Profile could not be snapshotted before mutation', error)
      }

      const oldGeneration = currentGeneration.id
      let targetFingerprint: CompatibilityFingerprint | undefined
      await transition(controls, 'stopping-host', oldGeneration)
      let generation: Awaited<ReturnType<HostSupervisor['restart']>>
      try {
        generation = await options.host.restart(
          `${request.action} ${candidate.pluginId}@${candidate.version}`,
          async () => {
            await controls.completeSideEffect('stopping-host', oldGeneration)
            await transition(controls, 'installing', oldGeneration)
            try {
              if (request.action === 'enable' || request.action === 'disable') {
                const next = setProfileBundleEnabled(before, candidate.packageName, request.action === 'enable')
                await writeFileAtomic(
                  join(options.profileDirectory, 'package.json'),
                  `${JSON.stringify(next, null, 2)}\n`,
                  { mode: 0o600, dirMode: 0o700 },
                )
              } else if (request.action === 'update') {
                if (artifact === undefined) throw new Error('verified update artifact is unavailable')
                await installTrustedPackage(options.packageManager, {
                  packageName: candidate.packageName,
                  version: candidate.version,
                  artifactPath: artifact.path,
                })
              } else {
                await removeTrustedPackage(options.packageManager, { packageName: candidate.packageName })
              }
            } catch (error) {
              throw failure('package-mutation-failed', 'fixed installed-plugin mutation failed', error)
            }
            await controls.completeSideEffect('installing', oldGeneration)

            await transition(controls, 'validating-profile', oldGeneration)
            try {
              if (request.action === 'update') {
                await reconcileAndValidateInstalledBundle({
                  before,
                  profileDirectory: options.profileDirectory,
                  installAnchor: options.installAnchor,
                  candidate,
                  expectedEnabled: installedBefore.enabled,
                })
              } else if (request.action === 'uninstall') {
                await reconcileAndValidateUninstalledBundle({
                  before,
                  profileDirectory: options.profileDirectory,
                  installAnchor: options.installAnchor,
                  packageName: candidate.packageName,
                })
              }
              targetFingerprint = await options.postFingerprint(resolved.selection)
              const observed = targetFingerprint.installedPlugins.find(plugin => plugin.pluginId === candidate.pluginId)
              if (request.action === 'uninstall') {
                if (observed !== undefined) throw new Error('removed plugin remains in the Profile projection')
              } else {
                const expectedVersion = request.action === 'update' ? candidate.version : installedBefore.version
                const expectedEnabled = request.action === 'enable'
                  ? true
                  : request.action === 'disable'
                    ? false
                    : installedBefore.enabled
                if (observed?.packageName !== candidate.packageName
                  || observed.version !== expectedVersion
                  || observed.enabled !== expectedEnabled) {
                  throw new Error('Profile projection does not expose the exact requested installed state')
                }
              }
            } catch (error) {
              if (error instanceof PluginOperationFailure) throw error
              throw failure('profile-invalid', 'mutated Profile failed installed-state validation', error)
            }
            await transition(controls, 'starting-host', oldGeneration)
          },
        )
      } catch (error) {
        if (error instanceof PluginOperationFailure) throw error
        throw failure('host-restart-failed', 'replacement Host generation could not start', error)
      }
      await controls.completeSideEffect('starting-host', generation.id)

      await transition(controls, 'reloading', generation.id)
      try {
        await options.reloadHost(generation.origin)
      } catch (error) {
        throw failure('host-restart-failed', 'Desktop window could not reconnect to the replacement Host', error)
      }
      await controls.completeSideEffect('reloading', generation.id)
      await transition(controls, 'health-checking', generation.id)
      try {
        await options.runtimeVerifier.verifyHealth(generation.origin)
      } catch (error) {
        throw failure('host-restart-failed', 'replacement Host failed loopback health verification', error)
      }
      await transition(controls, 'verifying-runtime', generation.id)
      let runtimeEvidence: Awaited<ReturnType<PluginRuntimeVerifier['readEvidence']>>
      try {
        const targetEnabled = request.action === 'enable'
          || (request.action === 'update' && installedBefore.enabled)
        runtimeEvidence = targetEnabled
          ? await options.runtimeVerifier.verifyActivationTransition(
            generation.origin,
            candidate,
            priorRuntime,
            replacedCandidate,
          )
          : await options.runtimeVerifier.verifyDeactivation(
            generation.origin,
            candidate,
            priorRuntime,
            replacedCandidate,
          )
      } catch (error) {
        throw failure('runtime-evidence-missing', 'installed plugin runtime transition evidence is incomplete', error)
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
