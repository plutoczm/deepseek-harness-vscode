import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CompatibilityFingerprint,
  PluginRuntimeEvidence,
  PluginTransactionJournalRecord,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import type { HostGeneration, HostSupervisor } from '../src/host-supervisor.ts'
import type { PackageManagerProcessAdapter } from '../src/plugin-center/package-manager.ts'
import { PluginOperationJournal } from '../src/plugin-center/operation-journal.ts'
import { ProfileMutationLock } from '../src/plugin-center/profile-lock.ts'
import {
  blocksNormalPluginStartup,
  PluginRecoveryController,
} from '../src/plugin-center/recovery-controller.ts'
import { ProfileSnapshotStore } from '../src/plugin-center/profile-snapshot-store.ts'
import { PluginRuntimeVerifier } from '../src/plugin-center/runtime-verifier.ts'

const roots: string[] = []
const OPERATION_ID = 'operation-1'
const STARTED_AT = '2026-08-15T01:00:00.000Z'

async function temporaryRoot(): Promise<string> {
  const root = join(tmpdir(), `dsh-plugin-recovery-${process.pid}-${String(roots.length)}`)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function fingerprint(): CompatibilityFingerprint {
  return {
    desktopVersion: '0.1.0-rc.5',
    dshVersion: '0.1.0-rc.5',
    nodeVersion: '22.22.0',
    platform: 'darwin-arm64',
    catalogEtag: 'fixture-v1',
    catalogFreshness: 'fresh',
    profileRevision: 7,
    installedPlugins: [],
    protectedPackageNames: ['@deepseek-ai/dsh-base'],
    protectedEntryIds: ['agent-loop'],
    activeOperation: false,
  }
}

function priorRuntime(): PluginRuntimeEvidence {
  return {
    entries: [{ entryId: 'include:base', enabled: true, fiberPhase: 'active' }],
    clientModules: ['@deepseek-ai/dsh-web-client'],
    skillIds: ['base.skill'],
  }
}

function clock(start = 10): () => Date {
  let second = start
  return () => new Date(`2026-08-15T01:00:${String(second++).padStart(2, '0')}.000Z`)
}

async function seedOpenJournal(input: {
  journal: PluginOperationJournal
  snapshotStore: ProfileSnapshotStore
  runtimeEvidence: PluginRuntimeEvidence
}): Promise<void> {
  const snapshot = await input.snapshotStore.capture(OPERATION_ID, '@fixture/dsh-workspace-tools')
  const operation = {
    schemaVersion: 1 as const,
    operationId: OPERATION_ID,
    idempotencyKey: 'install:fixture.workspace-tools:1',
    profileName: 'web' as const,
    action: 'install' as const,
    pluginId: 'fixture.workspace-tools',
    version: '1.0.0',
    phase: 'preflight' as const,
    startedAt: STARTED_AT,
    updatedAt: STARTED_AT,
    hostGeneration: 1,
    failureCode: null,
  }
  const initial: PluginTransactionJournalRecord = {
    schemaVersion: 2,
    header: {
      operationId: OPERATION_ID,
      idempotencyKey: operation.idempotencyKey,
      profileIdentity: snapshot.profileIdentity,
      action: 'install',
      pluginId: operation.pluginId,
      version: operation.version,
      startedAt: STARTED_AT,
    },
    operation,
    priorFingerprint: null,
    priorSnapshot: null,
    phaseHistory: [{
      sequence: 0,
      phase: 'preflight',
      boundary: 'observation',
      at: STARTED_AT,
      operationFailureCode: null,
      recoveryReasonCode: null,
    }],
    commitMarker: null,
    terminalResult: null,
    recoveryAttempt: 0,
    recoveryReasonCode: null,
  }
  await input.journal.write(initial)
  const foundation: PluginTransactionJournalRecord = {
    ...initial,
    priorFingerprint: fingerprint(),
    priorSnapshot: {
      snapshotId: snapshot.snapshotId,
      snapshotSha256: snapshot.snapshotSha256,
      runtimeEvidence: input.runtimeEvidence,
    },
  }
  await input.journal.write(foundation)
  await input.journal.write({
    ...foundation,
    operation: {
      ...operation,
      phase: 'installing',
      updatedAt: '2026-08-15T01:00:01.000Z',
    },
    phaseHistory: [...foundation.phaseHistory, {
      sequence: 1,
      phase: 'installing',
      boundary: 'before-side-effect',
      at: '2026-08-15T01:00:01.000Z',
      operationFailureCode: null,
      recoveryReasonCode: null,
    }],
  })
}

function host(restarts: string[]): HostSupervisor {
  let generation: HostGeneration | undefined = { id: 1, origin: 'http://127.0.0.1:4101' }
  return {
    get current() { return generation },
    start: async () => generation?.origin ?? 'http://127.0.0.1:4102',
    restart: async (reason, beforeStart) => {
      restarts.push(reason)
      generation = undefined
      await beforeStart?.()
      generation = { id: 2 + restarts.length, origin: `http://127.0.0.1:${String(4101 + restarts.length)}` }
      return generation
    },
    shutdown: async () => { generation = undefined },
  }
}

function runtimeFetcher(evidence: () => PluginRuntimeEvidence): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.endsWith('/api/pluginInventory/list')) return new Response('ready', { status: 200 })
    if (typeof init?.body !== 'string') throw new Error('runtime inventory request body must be JSON')
    const request = JSON.parse(init.body) as { rpcId: string }
    return new Response(JSON.stringify({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: true, value: evidence() },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

describe('Plugin Center recovery controller', () => {
  it('restores idempotent prior runtime and converges repeated recovery without another mutation', async () => {
    const root = await temporaryRoot()
    const profile = join(root, 'profile')
    await mkdir(join(profile, 'node_modules/@fixture/dsh-workspace-tools'), { recursive: true })
    const packageBefore = '{"dependencies":{"base":"1.0.0"}}\n'
    await writeFile(join(profile, 'package.json'), packageBefore)
    await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    await writeFile(join(profile, 'cordis.patch.yml'), '- base\n')
    await writeFile(join(profile, 'node_modules/.modules.yaml'), 'layoutVersion: 5\n')
    await rm(join(profile, 'node_modules/@fixture/dsh-workspace-tools'), { recursive: true })
    const snapshotStore = new ProfileSnapshotStore(profile, join(root, 'snapshots'), () => new Date(STARTED_AT))
    const journal = new PluginOperationJournal(join(root, 'journal'))
    await seedOpenJournal({ journal, snapshotStore, runtimeEvidence: priorRuntime() })

    await writeFile(join(profile, 'package.json'), '{"dependencies":{"broken":"9.9.9"}}\n')
    await writeFile(join(profile, 'pnpm-lock.yaml'), 'broken lock\n')
    await writeFile(join(profile, 'cordis.patch.yml'), '- broken\n')
    await mkdir(join(profile, 'node_modules/@fixture/dsh-workspace-tools'), { recursive: true })
    const profileLock = new ProfileMutationLock(profile)
    const staleLock = (nonce: string) => `${JSON.stringify({
      schemaVersion: 1,
      operationId: OPERATION_ID,
      pid: 2_147_483_647,
      nonce,
    })}\n`
    await writeFile(profileLock.path, staleLock('interrupted-mutation'))
    await writeFile(profileLock.recoveryPath, staleLock('interrupted-recovery'))
    const invocations: string[][] = []
    const processAdapter: PackageManagerProcessAdapter = {
      run: async (invocation) => {
        invocations.push([...invocation.args])
        await rm(join(profile, 'node_modules/@fixture/dsh-workspace-tools'), { recursive: true, force: true })
        return { code: 0, signal: null, stdout: 'restored', stderr: '' }
      },
    }
    const restarts: string[] = []
    const reloads: string[] = []
    const recovery = new PluginRecoveryController({
      journal,
      snapshotStore,
      profileLock,
      packageManager: {
        executable: '/runtime/node',
        packageManagerEntry: '/runtime/pnpm.cjs',
        profileDirectory: profile,
        storeDirectory: join(root, 'store'),
        homeDirectory: root,
        electronRunAsNode: false,
        processAdapter,
      },
      host: host(restarts),
      runtimeVerifier: new PluginRuntimeVerifier(runtimeFetcher(priorRuntime), () => 'rpc-recovery'),
      reloadHost: async (origin) => { reloads.push(origin) },
      now: clock(),
    })

    await expect(recovery.recoverOpen('package-mutation-failed')).resolves.toMatchObject({
      phase: 'rolled-back',
      operationFailureCode: 'package-mutation-failed',
      attempt: 1,
    })
    await expect(readFile(join(profile, 'package.json'), 'utf8')).resolves.toBe(packageBefore)
    await expect(readFile(join(profile, 'pnpm-lock.yaml'), 'utf8')).resolves.toBe('lockfileVersion: 9\n')
    await expect(readFile(join(profile, 'cordis.patch.yml'), 'utf8')).resolves.toBe('- base\n')
    await expect(journal.read()).resolves.toMatchObject({
      terminalResult: 'rolled-back',
      operation: { phase: 'rolled-back' },
      recoveryAttempt: 1,
    })
    expect(blocksNormalPluginStartup(await journal.read())).toBe(false)
    expect(invocations).toHaveLength(1)
    expect(invocations[0]).toContain('--frozen-lockfile')
    expect(restarts).toHaveLength(1)
    expect(reloads).toHaveLength(1)
    await expect(readFile(profileLock.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(profileLock.recoveryPath)).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(recovery.recoverOpen()).resolves.toMatchObject({ phase: 'rolled-back', attempt: 1 })
    expect(invocations).toHaveLength(1)
    expect(restarts).toHaveLength(1)
  })

  it('holds startup on prior-runtime mismatch and retries the same operation idempotently', async () => {
    const root = await temporaryRoot()
    const profile = join(root, 'profile')
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await writeFile(join(profile, 'package.json'), '{"dependencies":{}}\n')
    const snapshotStore = new ProfileSnapshotStore(profile, join(root, 'snapshots'), () => new Date(STARTED_AT))
    const journal = new PluginOperationJournal(join(root, 'journal'))
    await seedOpenJournal({ journal, snapshotStore, runtimeEvidence: priorRuntime() })
    await writeFile(join(profile, 'package.json'), '{"dependencies":{"broken":"9.9.9"}}\n')
    let healthy = false
    const runPackageManager = vi.fn(async () => ({ code: 0, signal: null, stdout: '', stderr: '' }))
    const processAdapter: PackageManagerProcessAdapter = { run: runPackageManager }
    const reloadHost = vi.fn(async () => {})
    const recovery = new PluginRecoveryController({
      journal,
      snapshotStore,
      profileLock: new ProfileMutationLock(profile),
      packageManager: {
        executable: '/runtime/node',
        packageManagerEntry: '/runtime/pnpm.cjs',
        profileDirectory: profile,
        storeDirectory: join(root, 'store'),
        homeDirectory: root,
        electronRunAsNode: false,
        processAdapter,
      },
      host: host([]),
      runtimeVerifier: new PluginRuntimeVerifier(
        runtimeFetcher(() => healthy ? priorRuntime() : { entries: [], clientModules: [], skillIds: [] }),
        () => 'rpc-recovery',
      ),
      reloadHost,
      now: clock(),
    })

    await expect(recovery.recoverOpen('internal')).resolves.toMatchObject({
      phase: 'recovery-failed',
      recoveryReasonCode: 'runtime-verification-failed',
      attempt: 1,
      canRetry: true,
    })
    const failed = await journal.read()
    expect(blocksNormalPluginStartup(failed)).toBe(true)
    expect(failed).toMatchObject({ terminalResult: 'recovery-failed', recoveryAttempt: 1 })
    expect(reloadHost).not.toHaveBeenCalled()

    healthy = true
    await expect(recovery.retry(OPERATION_ID)).resolves.toMatchObject({
      phase: 'rolled-back',
      attempt: 2,
    })
    await expect(journal.read()).resolves.toMatchObject({
      header: { operationId: OPERATION_ID },
      terminalResult: 'rolled-back',
      recoveryAttempt: 2,
    })
    expect(runPackageManager).toHaveBeenCalledTimes(2)
    expect(reloadHost).toHaveBeenCalledTimes(1)
  })
})
