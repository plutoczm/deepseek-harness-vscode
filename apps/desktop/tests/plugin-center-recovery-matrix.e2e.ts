import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initProfile, readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import {
  COMPATIBILITY_ACTIONS,
  type ArtifactVerificationResult,
  type CatalogVersionPreflight,
  type CompatibilityAction,
  type CompatibilityRequest,
  type PluginOperationBoundary,
  type PluginRuntimeEvidence,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import type { HostGeneration, HostSupervisor } from '../src/host-supervisor.ts'
import { PluginArtifactDownloader } from '../src/plugin-center/artifact-downloader.ts'
import { BUNDLED_CATALOG } from '../src/plugin-center/catalog-fixture.ts'
import type { CatalogPreflightSelection } from '../src/plugin-center/catalog-client.ts'
import {
  PluginOperationController,
  type PluginOperationFaultPoint,
  type PluginOperationRunner,
} from '../src/plugin-center/operation-controller.ts'
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
import { PluginRecoveryController } from '../src/plugin-center/recovery-controller.ts'
import { PluginRuntimeVerifier } from '../src/plugin-center/runtime-verifier.ts'
import { createTrustedInstallRunner } from '../src/plugin-center/trusted-install-executor.ts'
import { createTrustedManagementRunner } from '../src/plugin-center/trusted-management-executor.ts'

const roots: string[] = []

function baseCandidate(): CatalogVersionPreflight {
  const value = BUNDLED_CATALOG.preflights.find(candidate => candidate.pluginId === 'fixture.workspace-tools')
  if (value === undefined) throw new Error('reviewed workspace-tools fixture is missing')
  return value
}

const BASE_CANDIDATE = baseCandidate()

const PACKAGE_NAME = BASE_CANDIDATE.packageName
const PLUGIN_ID = BASE_CANDIDATE.pluginId
const CURRENT_VERSION = BASE_CANDIDATE.version
const TARGET_VERSION = '0.1.0-rc.6'
const AUTHORITY_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'cordis.patch.yml',
  'node_modules/.modules.yaml',
] as const

type MatrixFaultPoint = Pick<PluginOperationFaultPoint, 'phase' | 'boundary'>

const MUTATION_FAULT_POINTS = [
  { phase: 'stopping-host', boundary: 'before-side-effect' },
  { phase: 'stopping-host', boundary: 'after-side-effect' },
  { phase: 'installing', boundary: 'before-side-effect' },
  { phase: 'installing', boundary: 'after-side-effect' },
  { phase: 'validating-profile', boundary: 'observation' },
  { phase: 'starting-host', boundary: 'before-side-effect' },
  { phase: 'starting-host', boundary: 'after-side-effect' },
  { phase: 'reloading', boundary: 'before-side-effect' },
  { phase: 'reloading', boundary: 'after-side-effect' },
  { phase: 'health-checking', boundary: 'observation' },
  { phase: 'verifying-runtime', boundary: 'observation' },
] as const satisfies readonly MatrixFaultPoint[]

const MATRIX_CASES = COMPATIBILITY_ACTIONS.flatMap(action => MUTATION_FAULT_POINTS.map(point => ({
  action,
  ...point,
})))

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function clock(): () => Date {
  let second = 0
  return () => new Date(`2026-08-15T07:00:${String(second++).padStart(2, '0')}.000Z`)
}

function candidate(version: string): CatalogVersionPreflight {
  return {
    ...BASE_CANDIDATE,
    version,
    artifacts: BASE_CANDIDATE.artifacts.map(artifact => ({
      ...artifact,
      url: `https://cdn.deepseek.com/plugins/${PLUGIN_ID}/${version}/${artifact.platform}.tgz`,
    })),
  }
}

async function writeBundle(profile: string, version: string): Promise<void> {
  const directory = join(profile, 'node_modules', ...PACKAGE_NAME.split('/'))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({
    name: PACKAGE_NAME,
    version,
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      pluginCenter: {
        expectedEntries: BASE_CANDIDATE.expectedEntries,
        expectedClientModules: BASE_CANDIDATE.expectedClientModules,
        expectedSkillIds: BASE_CANDIDATE.expectedSkillIds,
        ownedData: [{ path: 'cache', label: 'Fixture cache' }],
      },
    },
  }, null, 2)}\n`)
  await writeFile(join(directory, 'cordis.patch.yml'), '- id: fixture.workspace-tools\n  disabled: false\n')
}

async function removeBundle(profile: string): Promise<void> {
  await rm(join(profile, 'node_modules', ...PACKAGE_NAME.split('/')), { recursive: true, force: true })
}

async function packagePresent(profile: string): Promise<boolean> {
  try {
    await readFile(join(profile, 'node_modules', ...PACKAGE_NAME.split('/'), 'package.json'))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readAuthority(profile: string): Promise<Readonly<Record<string, string>>> {
  const entries = await Promise.all(AUTHORITY_PATHS.map(async path => [
    path,
    await readFile(join(profile, ...path.split('/')), 'utf8'),
  ] as const))
  return Object.fromEntries(entries)
}

function inventoryFetcher(profile: string): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.endsWith('/api/pluginInventory/list')) return new Response('ready', { status: 200 })
    if (typeof init?.body !== 'string') throw new Error('runtime inventory request body must be JSON text')
    const request = JSON.parse(init.body) as { rpcId: string }
    const manifest = readProfileManifest('test', profile)
    const active = PACKAGE_NAME in (manifest.dependencies ?? {})
      && (manifest.dsh?.profile?.bundles ?? []).includes(PACKAGE_NAME)
    return new Response(JSON.stringify({
      type: 'server-response',
      rpcId: request.rpcId,
      result: {
        ok: true,
        value: {
          entries: [
            { entryId: 'unrelated.runtime', enabled: true, fiberPhase: 'active' },
            ...(active ? [{ entryId: 'include:fixture.workspace-tools', enabled: true, fiberPhase: 'active' }] : []),
          ],
          clientModules: [
            '@fixture/unrelated-client',
            ...(active ? BASE_CANDIDATE.expectedClientModules : []),
          ],
          skillIds: ['unrelated-skill'],
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

interface MatrixHarness {
  readonly profile: string
  readonly journal: PluginOperationJournal
  readonly controller: PluginOperationController
  readonly runtimeVerifier: PluginRuntimeVerifier
  readonly host: HostSupervisor
  readonly priorAuthority: Readonly<Record<string, string>>
  readonly priorPackagePresent: boolean
  readonly priorRuntime: PluginRuntimeEvidence
  faultInjected(): boolean
  runnerFailure(): unknown
}

async function createHarness(
  action: CompatibilityAction,
  targetPoint: MatrixFaultPoint,
): Promise<MatrixHarness> {
  const root = join(tmpdir(), `dsh-plugin-real-recovery-${process.pid}-${String(roots.length)}`)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  roots.push(root)
  const home = join(root, 'dsh-home')
  const profile = join(home, 'profiles', 'web')
  initProfile(profile, [])
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\nfixture: ${action === 'install' ? 'none' : CURRENT_VERSION}\n`)
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(profile, 'node_modules', '.modules.yaml'), `fixture: ${action === 'install' ? 'none' : CURRENT_VERSION}\n`)

  const priorPackagePresent = action !== 'install'
  const priorEnabled = priorPackagePresent && action !== 'enable'
  if (priorPackagePresent) await writeBundle(profile, CURRENT_VERSION)
  const manifest = readProfileManifest('test', profile)
  manifest.dependencies = priorPackagePresent ? { [PACKAGE_NAME]: CURRENT_VERSION } : {}
  manifest.dsh = {
    ...manifest.dsh,
    profile: {
      bundles: priorEnabled ? [PACKAGE_NAME] : [],
      disabledBundles: priorPackagePresent && !priorEnabled ? [PACKAGE_NAME] : [],
    },
  }
  await writeFile(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const currentCandidate = candidate(CURRENT_VERSION)
  const targetCandidate = candidate(TARGET_VERSION)
  const candidates = [currentCandidate, targetCandidate]
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
    os: 'darwin',
    architecture: 'arm64',
    catalogEtag: value.etag,
    catalogFreshness: value.freshness,
    candidates: value.candidates,
    systemComponents: { packageNames: [], entryIds: [] },
    activeOperation: false,
  })
  const compatibility = new PluginCompatibilityService({
    resolvePreflight: async request => selection(request),
  }, readFingerprint)

  const processAdapter: PackageManagerProcessAdapter = {
    run: async (invocation: PackageManagerInvocation) => {
      const command = invocation.args[1]
      if (command === 'add') {
        const nextVersion = action === 'update' ? TARGET_VERSION : CURRENT_VERSION
        const current = readProfileManifest('test', profile)
        current.dependencies = { ...current.dependencies, [PACKAGE_NAME]: nextVersion }
        await writeFile(join(profile, 'package.json'), `${JSON.stringify(current, null, 2)}\n`)
        await writeFile(join(profile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\nfixture: ${nextVersion}\n`)
        await writeFile(join(profile, 'node_modules', '.modules.yaml'), `fixture: ${nextVersion}\n`)
        await writeBundle(profile, nextVersion)
      } else if (command === 'remove') {
        const current = readProfileManifest('test', profile)
        delete current.dependencies?.[PACKAGE_NAME]
        await writeFile(join(profile, 'package.json'), `${JSON.stringify(current, null, 2)}\n`)
        await writeFile(join(profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nfixture: none\n")
        await writeFile(join(profile, 'node_modules', '.modules.yaml'), 'fixture: none\n')
        await removeBundle(profile)
      } else if (command === 'install') {
        const restored = readProfileManifest('test', profile)
        const restoredVersion = restored.dependencies?.[PACKAGE_NAME]
        if (restoredVersion === undefined) await removeBundle(profile)
        else await writeBundle(profile, restoredVersion)
      } else {
        throw new Error(`unexpected package-manager command: ${String(command)}`)
      }
      return { code: 0, signal: null, stdout: 'done', stderr: '' }
    },
  }

  let generationSequence = 1
  let generation: HostGeneration | undefined = { id: generationSequence, origin: 'http://127.0.0.1:4301' }
  const host: HostSupervisor = {
    get current() { return generation },
    start: async () => generation?.origin ?? 'http://127.0.0.1:4301',
    restart: async (_reason, beforeStart) => {
      generation = undefined
      await beforeStart?.()
      generationSequence += 1
      generation = {
        id: generationSequence,
        origin: `http://127.0.0.1:${String(4300 + generationSequence)}`,
      }
      return generation
    },
    shutdown: async () => { generation = undefined },
  }

  const nextTime = clock()
  const runtimeVerifier = new PluginRuntimeVerifier(inventoryFetcher(profile), () => `rpc-${String(generationSequence)}`)
  const snapshotStore = new ProfileSnapshotStore(profile, join(root, 'snapshots'), nextTime)
  const packageManager = {
    executable: '/runtime/node',
    packageManagerEntry: '/runtime/pnpm.cjs',
    profileDirectory: profile,
    storeDirectory: join(root, 'store'),
    homeDirectory: home,
    electronRunAsNode: false,
    platform: 'darwin' as const,
    processAdapter,
  }
  const artifactBytes = await readFile(new URL(
    '../resources/plugin-center/fixtures/deepseek-ai-dsh-plugin-center-fixture-0.1.0-rc.5.tgz',
    import.meta.url,
  ))
  const downloader = new PluginArtifactDownloader(join(root, 'operations'), async () => new Response(artifactBytes, {
    status: 200,
    headers: { 'content-length': String(artifactBytes.byteLength) },
  }))
  const shared = {
    compatibility,
    platform: 'darwin-arm64' as const,
    downloader,
    profileLock: new ProfileMutationLock(profile),
    snapshotStore,
    packageManager,
    profileDirectory: profile,
    installAnchor: join(root, 'package.json'),
    host,
    reloadHost: async (_origin: string) => {},
    runtimeVerifier,
    postFingerprint: readFingerprint,
  }
  const installRunner = createTrustedInstallRunner(shared)
  const managementRunner = createTrustedManagementRunner({
    ...shared,
    verifyArtifact: async input => ({
      verified: true,
      reasons: [],
      observedPackageName: input.candidate.packageName,
      observedVersion: input.candidate.version,
      observedBundlePatch: input.candidate.bundlePatch,
      entryCount: 1,
      unpackedBytes: 1,
    } satisfies ArtifactVerificationResult),
    ownedDataAuthorityStore: new PluginOwnedDataAuthorityStore(join(root, 'owned-data-authority')),
  })
  const trustedRunner: PluginOperationRunner = action === 'install' ? installRunner : managementRunner
  let runnerFailure: unknown
  const runner: PluginOperationRunner = async (...args) => {
    try { return await trustedRunner(...args) } catch (error) {
      runnerFailure = error
      throw error
    }
  }
  const journal = new PluginOperationJournal(join(root, 'journal'))
  const recovery = new PluginRecoveryController({
    journal,
    snapshotStore,
    profileLock: new ProfileMutationLock(profile),
    packageManager,
    host,
    runtimeVerifier,
    reloadHost: async (_origin: string) => {},
    now: nextTime,
  })
  let injected = false
  const controller = new PluginOperationController(
    journal,
    runner,
    () => snapshotStore.identity(),
    async (failureCode) => { await recovery.recoverOpen(failureCode) },
    nextTime,
    () => `matrix-${action}-${targetPoint.phase}-${targetPoint.boundary}`,
    (point) => {
      if (injected || point.phase !== targetPoint.phase || point.boundary !== targetPoint.boundary) return
      injected = true
      throw new Error(`injected ${point.phase}/${point.boundary}`)
    },
  )
  await controller.initialize()
  const currentOrigin = host.current?.origin
  if (currentOrigin === undefined) throw new Error('matrix prior Host is unavailable')
  const priorRuntime = await runtimeVerifier.readEvidence(currentOrigin)

  return {
    profile,
    journal,
    controller,
    runtimeVerifier,
    host,
    priorAuthority: await readAuthority(profile),
    priorPackagePresent,
    priorRuntime,
    faultInjected: () => injected,
    runnerFailure: () => runnerFailure,
  }
}

async function runMatrixCase(
  action: CompatibilityAction,
  phase: MatrixFaultPoint['phase'],
  boundary: PluginOperationBoundary,
): Promise<void> {
  const value = await createHarness(action, { phase, boundary })
  const version = action === 'update' ? TARGET_VERSION : CURRENT_VERSION
  const request = {
    pluginId: PLUGIN_ID,
    version,
    idempotencyKey: `${action}:${phase}:${boundary}`,
  }
  const started = action === 'install'
    ? await value.controller.start(request)
    : await value.controller.manage({ ...request, action })
  expect(started.kind).toBe('started')
  await value.controller.whenSettled()

  const record = await value.journal.read()
  expect(
    value.faultInjected(),
    `operation recovered before the selected fault point: ${String(value.runnerFailure())}; cause: ${String((value.runnerFailure() as Error | undefined)?.cause)}; ${JSON.stringify(record?.phaseHistory)}`,
  ).toBe(true)
  expect(await readAuthority(value.profile)).toEqual(value.priorAuthority)
  expect(await packagePresent(value.profile)).toBe(value.priorPackagePresent)
  const currentOrigin = value.host.current?.origin
  if (currentOrigin === undefined) throw new Error('matrix recovered Host is unavailable')
  await expect(value.runtimeVerifier.readEvidence(currentOrigin)).resolves.toEqual(value.priorRuntime)
  expect(record).toMatchObject({
    header: { action },
    operation: { phase: 'rolled-back' },
    terminalResult: 'rolled-back',
    commitMarker: null,
  })
  expect(record?.phaseHistory.some(entry => entry.phase === phase && entry.boundary === boundary)).toBe(true)
  expect(record?.phaseHistory.some(entry => entry.phase === 'recovery-verifying-runtime')).toBe(true)
  expect(record?.phaseHistory.some(entry => entry.phase === 'rolled-back')).toBe(true)
}

describe('Plugin Center real-executor recovery matrix', () => {
  it.each(MATRIX_CASES)(
    'restores $action at $phase/$boundary',
    async ({ action, phase, boundary }) => { await runMatrixCase(action, phase, boundary) },
  )
})
