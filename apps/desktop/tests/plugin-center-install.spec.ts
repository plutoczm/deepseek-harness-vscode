import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import type { CompatibilityRequest } from '@deepseek-ai/dsh-plugin-center-contracts'
import type { CatalogPreflightSelection } from '../src/plugin-center/catalog-client.ts'
import type { HostGeneration, HostSupervisor } from '../src/host-supervisor.ts'
import { PluginArtifactDownloader } from '../src/plugin-center/artifact-downloader.ts'
import { BUNDLED_CATALOG } from '../src/plugin-center/catalog-fixture.ts'
import { PluginOperationController } from '../src/plugin-center/operation-controller.ts'
import { PluginOperationJournal } from '../src/plugin-center/operation-journal.ts'
import type {
  PackageManagerInvocation,
  PackageManagerProcessAdapter,
} from '../src/plugin-center/package-manager.ts'
import { PluginCompatibilityService } from '../src/plugin-center/preflight-service.ts'
import { readProfileCompatibilityFingerprint } from '../src/plugin-center/profile-compatibility.ts'
import { ProfileMutationLock } from '../src/plugin-center/profile-lock.ts'
import { ProfileSnapshotStore } from '../src/plugin-center/profile-snapshot-store.ts'
import { PluginRuntimeVerifier } from '../src/plugin-center/runtime-verifier.ts'
import { createTrustedInstallRunner } from '../src/plugin-center/trusted-install-executor.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = join(tmpdir(), `dsh-trusted-install-${process.pid}-${String(roots.length)}`)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function clock(): () => Date {
  let second = 0
  return () => new Date(`2026-08-15T05:00:${String(second++).padStart(2, '0')}.000Z`)
}

describe('trusted Plugin Center installation', () => {
  it('runs one ordered install transaction and commits only after joined runtime evidence', async () => {
    const root = await temporaryRoot()
    const home = join(root, 'dsh-home')
    const profile = join(home, 'profiles', 'web')
    const operations = join(root, 'operations')
    const candidate = BUNDLED_CATALOG.preflights.find(value => value.pluginId === 'fixture.workspace-tools')
    if (candidate === undefined) throw new Error('reviewed workspace-tools fixture is missing')
    initProfile(profile, [])

    const selection = (): CatalogPreflightSelection => ({
      candidate,
      candidates: [candidate],
      etag: BUNDLED_CATALOG.etag,
      freshness: 'fresh',
    })
    const readFingerprint = (current: CatalogPreflightSelection) => readProfileCompatibilityFingerprint({
      homeDirectory: home,
      profileName: 'web',
      desktopVersion: '0.1.0-rc.5',
      dshVersion: '0.1.0-rc.5',
      nodeVersion: '22.22.0',
      os: 'darwin',
      architecture: 'arm64',
      catalogEtag: current.etag,
      catalogFreshness: current.freshness,
      candidates: current.candidates,
      systemComponents: { packageNames: [], entryIds: [] },
      activeOperation: false,
    })
    const compatibility = new PluginCompatibilityService({
      resolvePreflight: async (_request: CompatibilityRequest) => selection(),
    }, readFingerprint)

    const artifactBytes = await readFile(new URL(
      '../resources/plugin-center/fixtures/deepseek-ai-dsh-plugin-center-fixture-0.1.0-rc.5.tgz',
      import.meta.url,
    ))
    const downloadFetcher = (async () => new Response(artifactBytes, {
      status: 200,
      headers: { 'content-length': String(artifactBytes.byteLength) },
    })) as typeof fetch

    const invocations: PackageManagerInvocation[] = []
    const processAdapter: PackageManagerProcessAdapter = {
      run: async (invocation) => {
        invocations.push(invocation)
        const packageDirectory = join(profile, 'node_modules', '@deepseek-ai', 'dsh-plugin-center-fixture')
        await mkdir(packageDirectory, { recursive: true })
        await copyFile(
          new URL('../../../packages/examples/plugin-center-fixture/package.json', import.meta.url),
          join(packageDirectory, 'package.json'),
        )
        await copyFile(
          new URL('../../../packages/examples/plugin-center-fixture/cordis.patch.yml', import.meta.url),
          join(packageDirectory, 'cordis.patch.yml'),
        )
        const manifestPath = join(profile, 'package.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          dependencies: Record<string, string>
        }
        manifest.dependencies[candidate.packageName] = candidate.version
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
        return { code: 0, signal: null, stdout: 'installed', stderr: '' }
      },
    }

    const hostEvents: string[] = []
    let generation: HostGeneration | undefined = { id: 1, origin: 'http://127.0.0.1:4101' }
    const host: HostSupervisor = {
      get current() { return generation },
      start: async () => generation?.origin ?? 'http://127.0.0.1:4101',
      restart: async (reason, beforeStart) => {
        hostEvents.push(`stop:${reason}`)
        generation = undefined
        await beforeStart?.()
        generation = { id: 2, origin: 'http://127.0.0.1:4102' }
        hostEvents.push('start:2')
        return generation
      },
      shutdown: async () => { generation = undefined },
    }

    const runtimeRequests: string[] = []
    const runtimeFetcher: typeof fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      runtimeRequests.push(url)
      if (!url.endsWith('/api/pluginInventory/list')) return new Response('ready', { status: 200 })
      if (typeof init?.body !== 'string') throw new Error('runtime inventory request body must be JSON text')
      const request = JSON.parse(init.body) as { rpcId: string }
      const installed = url.startsWith('http://127.0.0.1:4102')
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            entries: installed
              ? [{ entryId: 'include:fixture.workspace-tools', enabled: true, fiberPhase: 'active' }]
              : [],
            clientModules: installed ? ['@deepseek-ai/dsh-plugin-center-fixture'] : [],
            skillIds: [],
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const reloads: string[] = []
    const snapshotStore = new ProfileSnapshotStore(profile, join(root, 'snapshots'), clock())
    const trustedRunner = createTrustedInstallRunner({
      compatibility,
      platform: 'darwin-arm64',
      downloader: new PluginArtifactDownloader(operations, downloadFetcher),
      profileLock: new ProfileMutationLock(profile),
      snapshotStore,
      packageManager: {
        executable: '/runtime/node',
        packageManagerEntry: '/runtime/pnpm.cjs',
        profileDirectory: profile,
        storeDirectory: join(root, 'store'),
        homeDirectory: home,
        electronRunAsNode: false,
        platform: 'darwin',
        processAdapter,
      },
      profileDirectory: profile,
      installAnchor: join(root, 'package.json'),
      host,
      reloadHost: async (origin) => { reloads.push(origin) },
      runtimeVerifier: new PluginRuntimeVerifier(runtimeFetcher, () => 'rpc-install-1'),
      postFingerprint: readFingerprint,
    })
    let runnerFailure: unknown
    const runner: typeof trustedRunner = async (...args) => {
      try {
        return await trustedRunner(...args)
      } catch (error) {
        runnerFailure = error
        throw error
      }
    }
    const journal = new PluginOperationJournal(join(root, 'journal'))
    const controller = new PluginOperationController(
      journal,
      runner,
      () => snapshotStore.identity(),
      async () => {},
      clock(),
      () => 'operation-1',
    )
    const phases: string[] = []
    await controller.initialize()
    controller.subscribe(operation => phases.push(operation.phase))

    await expect(controller.start({
      pluginId: candidate.pluginId,
      version: candidate.version,
      idempotencyKey: 'install:fixture.workspace-tools:0.1.0-rc.5',
    })).resolves.toMatchObject({ kind: 'started', operation: { operationId: 'operation-1' } })
    await controller.whenSettled()
    if (runnerFailure !== undefined) throw runnerFailure

    expect(controller.getOperation()).toMatchObject({
      phase: 'committed',
      hostGeneration: 2,
      failureCode: null,
    })
    expect(phases).toEqual([
      'preflight',
      'downloading',
      'verifying-artifact',
      'snapshotting',
      'stopping-host',
      'installing',
      'validating-profile',
      'starting-host',
      'reloading',
      'health-checking',
      'verifying-runtime',
      'committed',
    ])
    expect(await journal.read()).toMatchObject({
      priorFingerprint: { installedPlugins: [] },
      priorSnapshot: { snapshotId: 'operation-1' },
    })
    expect(JSON.parse(await readFile(join(root, 'snapshots/operation-1/profile-snapshot.json'), 'utf8')))
      .toMatchObject({ targetPackageExisted: false })
    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')))
      .toMatchObject({
        dependencies: { [candidate.packageName]: candidate.version },
        dsh: { profile: { bundles: [candidate.packageName] } },
      })
    expect(invocations).toHaveLength(1)
    expect(invocations[0]).toMatchObject({ shell: false, cwd: profile })
    expect(invocations[0]?.args.at(-1)).toBe(join(operations, 'operation-1', 'artifact.tgz'))
    expect(hostEvents).toEqual([`stop:install ${candidate.pluginId}@${candidate.version}`, 'start:2'])
    expect(reloads).toEqual(['http://127.0.0.1:4102'])
    expect(runtimeRequests).toEqual([
      'http://127.0.0.1:4101/api/pluginInventory/list',
      'http://127.0.0.1:4102/',
      'http://127.0.0.1:4102/api/pluginInventory/list',
    ])

    const released = await new ProfileMutationLock(profile).acquire('operation-after-commit')
    await released.release()
  })
})
