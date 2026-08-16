import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initProfile, readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import type {
  ArtifactVerificationResult,
  CatalogVersionPreflight,
  CompatibilityRequest,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import type { HostGeneration, HostSupervisor } from '../src/host-supervisor.ts'
import { PluginArtifactDownloader } from '../src/plugin-center/artifact-downloader.ts'
import { BUNDLED_CATALOG } from '../src/plugin-center/catalog-fixture.ts'
import type { CatalogPreflightSelection } from '../src/plugin-center/catalog-client.ts'
import { PluginOperationController } from '../src/plugin-center/operation-controller.ts'
import { PluginOperationJournal } from '../src/plugin-center/operation-journal.ts'
import { PluginOwnedDataAuthorityStore } from '../src/plugin-center/owned-data.ts'
import type {
  PackageManagerInvocation,
  PackageManagerProcessAdapter,
} from '../src/plugin-center/package-manager.ts'
import { PluginCompatibilityService } from '../src/plugin-center/preflight-service.ts'
import { readProfileCompatibilityFingerprint } from '../src/plugin-center/profile-compatibility.ts'
import { ProfileMutationLock } from '../src/plugin-center/profile-lock.ts'
import { ProfileSnapshotStore } from '../src/plugin-center/profile-snapshot-store.ts'
import { PluginRuntimeVerifier } from '../src/plugin-center/runtime-verifier.ts'
import { createTrustedManagementRunner } from '../src/plugin-center/trusted-management-executor.ts'

const roots: string[] = []
const PACKAGE_NAME = '@fixture/managed-bundle'
const PLUGIN_ID = 'fixture.managed'
const ENTRY_ID = 'fixture.managed'
const CLIENT_MODULE = '@fixture/managed-client'
const CURRENT_VERSION = '0.1.0-rc.5'
const TARGET_VERSION = '0.1.0-rc.6'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function clock(): () => Date {
  let second = 0
  return () => new Date(`2026-08-15T06:00:${String(second++).padStart(2, '0')}.000Z`)
}

function candidate(version: string): CatalogVersionPreflight {
  const source = BUNDLED_CATALOG.preflights.find(value => value.pluginId === 'fixture.workspace-tools')!
  return {
    ...source,
    pluginId: PLUGIN_ID,
    version,
    packageName: PACKAGE_NAME,
    expectedEntries: [ENTRY_ID],
    expectedClientModules: [CLIENT_MODULE],
    expectedSkillIds: [],
    artifacts: source.artifacts.map(artifact => ({
      ...artifact,
      url: `https://cdn.deepseek.com/plugins/${PLUGIN_ID}/${version}/${artifact.platform}.tgz`,
    })),
  }
}

async function writeBundle(profile: string, version: string): Promise<void> {
  const directory = join(profile, 'node_modules', '@fixture', 'managed-bundle')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({
    name: PACKAGE_NAME,
    version,
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      pluginCenter: {
        expectedEntries: [ENTRY_ID],
        expectedClientModules: [CLIENT_MODULE],
        expectedSkillIds: [],
        ownedData: [{ path: 'cache', label: 'Managed cache' }],
      },
    },
  }, null, 2)}\n`)
  await writeFile(join(directory, 'cordis.patch.yml'), `- id: ${ENTRY_ID}\n  disabled: false\n`)
}

interface ManagementHarness {
  readonly profile: string
  readonly configPath: string
  readonly controller: PluginOperationController
  readonly invocations: PackageManagerInvocation[]
  readonly reloads: readonly string[]
  run(input: { readonly action: 'update' | 'enable' | 'disable' | 'uninstall'; readonly version: string }): Promise<void>
}

async function harness(
  initiallyEnabled: boolean,
  platform: 'darwin' | 'win32' = 'darwin',
  includeRestartScopedPresetEntry = false,
): Promise<ManagementHarness> {
  const root = join(tmpdir(), `dsh-plugin-management-${process.pid}-${String(roots.length)}`)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  roots.push(root)
  const home = join(root, 'dsh-home')
  const profile = join(home, 'profiles', 'web')
  const configPath = join(home, 'config', 'plugins', `${PLUGIN_ID}.json`)
  initProfile(profile, [])
  await writeBundle(profile, CURRENT_VERSION)
  const manifest = readProfileManifest('test', profile)
  manifest.dependencies = { [PACKAGE_NAME]: CURRENT_VERSION }
  manifest.dsh = {
    ...manifest.dsh,
    profile: {
      bundles: initiallyEnabled ? [PACKAGE_NAME] : [],
      disabledBundles: initiallyEnabled ? [] : [PACKAGE_NAME],
    },
  }
  await writeFile(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await mkdir(join(home, 'config', 'plugins'), { recursive: true })
  await writeFile(configPath, '{"retained":true}\n')

  const candidates = [candidate(CURRENT_VERSION), candidate(TARGET_VERSION)]
  const selection = (request: CompatibilityRequest): CatalogPreflightSelection => ({
    candidate: candidates.find(value => value.pluginId === request.pluginId && value.version === request.version) ?? null,
    candidates,
    etag: BUNDLED_CATALOG.etag,
    freshness: 'fresh',
  })
  const readFingerprint = (value: CatalogPreflightSelection) => readProfileCompatibilityFingerprint({
    homeDirectory: home,
    profileName: 'web',
    desktopVersion: '0.1.0-rc.5',
    dshVersion: '0.1.0-rc.5',
    nodeVersion: '22.22.0',
    os: platform,
    architecture: platform === 'win32' ? 'x64' : 'arm64',
    catalogEtag: value.etag,
    catalogFreshness: value.freshness,
    candidates: value.candidates,
    systemComponents: { packageNames: [], entryIds: [] },
    activeOperation: false,
  })
  const compatibility = new PluginCompatibilityService({
    resolvePreflight: async request => selection(request),
  }, readFingerprint)

  const artifactBytes = await readFile(new URL(
    '../resources/plugin-center/fixtures/deepseek-ai-dsh-plugin-center-fixture-0.1.0-rc.5.tgz',
    import.meta.url,
  ))
  const downloader = new PluginArtifactDownloader(join(root, 'operations'), async () => new Response(artifactBytes, {
    status: 200,
    headers: { 'content-length': String(artifactBytes.byteLength) },
  }))
  const invocations: PackageManagerInvocation[] = []
  let generation: HostGeneration | undefined = { id: 1, origin: 'http://127.0.0.1:4201' }
  const processAdapter: PackageManagerProcessAdapter = {
    run: async (invocation) => {
      if (platform === 'win32' && generation !== undefined) {
        throw new Error('Windows package mutation began while the Host still owned loaded files')
      }
      invocations.push(invocation)
      const current = readProfileManifest('test', profile)
      if (invocation.args[1] === 'remove') {
        delete current.dependencies?.[PACKAGE_NAME]
        await writeFile(join(profile, 'package.json'), `${JSON.stringify(current, null, 2)}\n`)
        await rm(join(profile, 'node_modules', '@fixture', 'managed-bundle'), { recursive: true, force: true })
      } else if (invocation.args[1] === 'add') {
        current.dependencies = { ...current.dependencies, [PACKAGE_NAME]: TARGET_VERSION }
        await writeFile(join(profile, 'package.json'), `${JSON.stringify(current, null, 2)}\n`)
        await writeBundle(profile, TARGET_VERSION)
      }
      return { code: 0, signal: null, stdout: 'done', stderr: '' }
    },
  }
  const host: HostSupervisor = {
    get current() { return generation },
    start: async () => generation?.origin ?? 'http://127.0.0.1:4201',
    restart: async (_reason, beforeStart) => {
      const nextId = (generation?.id ?? 1) + 1
      generation = undefined
      await beforeStart?.()
      generation = { id: nextId, origin: `http://127.0.0.1:${String(4200 + nextId)}` }
      return generation
    },
    shutdown: async () => { generation = undefined },
  }

  const runtimeFetcher: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.endsWith('/api/pluginInventory/list')) return new Response('ready', { status: 200 })
    if (typeof init?.body !== 'string') throw new Error('runtime inventory request body must be JSON text')
    const request = JSON.parse(init.body) as { rpcId: string }
    const current = readProfileManifest('test', profile)
    const active = PACKAGE_NAME in (current.dependencies ?? {})
      && (current.dsh?.profile?.bundles ?? []).includes(PACKAGE_NAME)
    return new Response(JSON.stringify({
      type: 'server-response',
      rpcId: request.rpcId,
      result: {
        ok: true,
        value: {
          entries: [
            { entryId: 'unrelated.runtime', enabled: true, fiberPhase: 'active' },
            ...(includeRestartScopedPresetEntry && generation?.id === 1
              ? [{ entryId: 'include:agent-presets:tool-bash', enabled: true, fiberPhase: 'active' }]
              : []),
            ...(active ? [{ entryId: `include:${ENTRY_ID}`, enabled: true, fiberPhase: 'active' }] : []),
          ],
          clientModules: ['@fixture/unrelated-client', ...(active ? [CLIENT_MODULE] : [])],
          skillIds: ['unrelated-skill'],
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const runtimeVerifier = new PluginRuntimeVerifier(runtimeFetcher, () => `rpc-${String(generation?.id ?? 0)}`)
  const snapshotStore = new ProfileSnapshotStore(profile, join(root, 'snapshots'), clock())
  const reloads: string[] = []
  const trustedRunner = createTrustedManagementRunner({
    compatibility,
    platform: platform === 'win32' ? 'win32-x64' : 'darwin-arm64',
    downloader,
    verifyArtifact: async input => ({
      verified: true,
      reasons: [],
      observedPackageName: input.candidate.packageName,
      observedVersion: input.candidate.version,
      observedBundlePatch: input.candidate.bundlePatch,
      entryCount: 1,
      unpackedBytes: 1,
    } satisfies ArtifactVerificationResult),
    profileLock: new ProfileMutationLock(profile),
    snapshotStore,
    ownedDataAuthorityStore: new PluginOwnedDataAuthorityStore(join(root, 'owned-data-authority')),
    packageManager: {
      executable: '/runtime/node',
      packageManagerEntry: '/runtime/pnpm.cjs',
      profileDirectory: profile,
      storeDirectory: join(root, 'store'),
      homeDirectory: home,
      electronRunAsNode: false,
      platform,
      processAdapter,
    },
    profileDirectory: profile,
    installAnchor: join(root, 'package.json'),
    host,
    reloadHost: async (origin) => { reloads.push(origin) },
    runtimeVerifier,
    postFingerprint: readFingerprint,
  })
  let runnerFailure: unknown
  const journal = new PluginOperationJournal(join(root, 'journal'))
  let operationSequence = 0
  const controller = new PluginOperationController(
    journal,
    async (...args) => {
      try { return await trustedRunner(...args) } catch (error) {
        runnerFailure = error
        throw error
      }
    },
    () => snapshotStore.identity(),
    async () => {},
    clock(),
    () => `management-${String(++operationSequence)}`,
  )
  await controller.initialize()

  return {
    profile,
    configPath,
    controller,
    invocations,
    reloads,
    async run(input) {
      runnerFailure = undefined
      const result = await controller.manage({
        pluginId: PLUGIN_ID,
        version: input.version,
        action: input.action,
        idempotencyKey: `${input.action}:${input.version}:${String(operationSequence + 1)}`,
      })
      expect(result.kind).toBe('started')
      await controller.whenSettled()
      if (runnerFailure !== undefined) throw runnerFailure
      expect(controller.getOperation()).toMatchObject({ action: input.action, phase: 'committed' })
    },
  }
}

describe('installed Plugin Center management', () => {
  it('disables and enables without deleting the package, then uninstalls while retaining configuration', async () => {
    const value = await harness(true)
    await value.run({ action: 'disable', version: CURRENT_VERSION })
    expect(value.reloads).toHaveLength(1)
    expect(readProfileManifest('test', value.profile)).toMatchObject({
      dependencies: { [PACKAGE_NAME]: CURRENT_VERSION },
      dsh: { profile: { bundles: [], disabledBundles: [PACKAGE_NAME] } },
    })
    expect(value.invocations).toEqual([])

    await value.run({ action: 'enable', version: CURRENT_VERSION })
    expect(value.reloads).toHaveLength(2)
    expect(readProfileManifest('test', value.profile)).toMatchObject({
      dependencies: { [PACKAGE_NAME]: CURRENT_VERSION },
      dsh: { profile: { bundles: [PACKAGE_NAME], disabledBundles: [] } },
    })

    await value.run({ action: 'uninstall', version: CURRENT_VERSION })
    expect(value.reloads).toHaveLength(3)
    const after = readProfileManifest('test', value.profile)
    expect(after.dependencies).not.toHaveProperty(PACKAGE_NAME)
    expect(after.dsh?.profile).toMatchObject({ bundles: [], disabledBundles: [] })
    expect(value.invocations.at(-1)?.args).toContain('remove')
    await expect(readFile(value.configPath, 'utf8')).resolves.toBe('{"retained":true}\n')
  })

  it.each([true, false])('updates one exact version and preserves enabled intent=%s', async (enabled) => {
    const value = await harness(enabled)
    await value.run({ action: 'update', version: TARGET_VERSION })
    const after = readProfileManifest('test', value.profile)
    expect(after.dependencies).toMatchObject({ [PACKAGE_NAME]: TARGET_VERSION })
    expect(after.dsh?.profile).toMatchObject(enabled
      ? { bundles: [PACKAGE_NAME], disabledBundles: [] }
      : { bundles: [], disabledBundles: [PACKAGE_NAME] })
    expect(value.invocations.at(-1)?.args).toContain('add')
    await expect(readFile(value.configPath, 'utf8')).resolves.toBe('{"retained":true}\n')
  })

  it('stops the Host before Windows package update and uninstall mutations', async () => {
    const updated = await harness(true, 'win32')
    await updated.run({ action: 'update', version: TARGET_VERSION })
    expect(updated.invocations.at(-1)?.args).toContain('add')

    const removed = await harness(true, 'win32')
    await removed.run({ action: 'uninstall', version: CURRENT_VERSION })
    expect(removed.invocations.at(-1)?.args).toContain('remove')
  })

  it('uninstalls when a live preset instance disappears with the replaced Host', async () => {
    const value = await harness(true, 'darwin', true)

    await value.run({ action: 'uninstall', version: CURRENT_VERSION })

    expect(readProfileManifest('test', value.profile).dependencies).not.toHaveProperty(PACKAGE_NAME)
  })
})
