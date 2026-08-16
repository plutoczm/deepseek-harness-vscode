import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CompatibilityFingerprint,
  PluginOperationPhase,
  PluginProfileIdentity,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import { PluginOperationController } from '../src/plugin-center/operation-controller.ts'
import { PluginOperationJournal } from '../src/plugin-center/operation-journal.ts'
import { ProfileMutationBusyError, ProfileMutationLock } from '../src/plugin-center/profile-lock.ts'
import { ProfileSnapshotStore } from '../src/plugin-center/profile-snapshot-store.ts'

const roots: string[] = []
const PROFILE_IDENTITY: PluginProfileIdentity = { profileName: 'web', rootSha256: 'a'.repeat(64) }

function runtimeEvidence() {
  return { entries: [], clientModules: [], skillIds: [] }
}

async function temporaryRoot(): Promise<string> {
  const root = join(tmpdir(), `dsh-plugin-operation-${process.pid}-${String(roots.length)}`)
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

function clock(): () => Date {
  let second = 0
  return () => new Date(`2026-08-15T01:00:${String(second++).padStart(2, '0')}.000Z`)
}

describe('Plugin Center operation ownership', () => {
  it('normalizes installed management actions into the same durable operation owner', async () => {
    const root = await temporaryRoot()
    const journal = new PluginOperationJournal(join(root, 'journal'))
    const observedActions: string[] = []
    const controller = new PluginOperationController(journal, async (request, controls) => {
      observedActions.push(request.action)
      await controls.transition('snapshotting')
      await controls.recordFoundation(fingerprint(), {
        snapshotId: 'operation-manage',
        snapshotSha256: 'b'.repeat(64),
        profileIdentity: PROFILE_IDENTITY,
        runtimeEvidence: runtimeEvidence(),
      })
      await controls.transition('verifying-runtime', 2)
      return { hostGeneration: 2, fingerprint: fingerprint(), runtimeEvidence: runtimeEvidence() }
    }, () => PROFILE_IDENTITY, async () => {}, clock(), () => 'operation-manage')
    await controller.initialize()

    await expect(controller.manage({
      pluginId: 'fixture.workspace-tools',
      version: '1.0.0',
      action: 'disable',
      idempotencyKey: 'disable:fixture.workspace-tools:1',
    })).resolves.toMatchObject({
      kind: 'started',
      operation: { action: 'disable', operationId: 'operation-manage' },
    })
    await controller.whenSettled()
    expect(observedActions).toEqual(['disable'])
    expect(controller.getOperation()).toMatchObject({ action: 'disable', phase: 'committed' })
    await expect(controller.manage({
      pluginId: 'fixture.workspace-tools',
      version: '1.0.0',
      action: 'install',
      idempotencyKey: 'bad-action',
    })).rejects.toThrow()
  })

  it('joins one idempotency key, returns busy for another, and publishes phases durably', async () => {
    const root = await temporaryRoot()
    const journal = new PluginOperationJournal(join(root, 'journal'))
    const continueRun = Promise.withResolvers<undefined>()
    const phases: PluginOperationPhase[] = []
    const controller = new PluginOperationController(journal, async (_request, controls) => {
      await controls.transition('downloading')
      await controls.transition('snapshotting')
      await controls.recordFoundation(fingerprint(), {
        snapshotId: 'operation-1',
        snapshotSha256: 'b'.repeat(64),
        profileIdentity: PROFILE_IDENTITY,
        runtimeEvidence: runtimeEvidence(),
      })
      await continueRun.promise
      await controls.transition('installing', 1)
      await controls.transition('verifying-runtime', 2)
      return { hostGeneration: 2, fingerprint: fingerprint(), runtimeEvidence: runtimeEvidence() }
    }, () => PROFILE_IDENTITY, async () => {}, clock(), () => 'operation-1')
    await controller.initialize()
    controller.subscribe(operation => phases.push(operation.phase))

    const request = {
      pluginId: 'fixture.workspace-tools',
      version: '1.0.0',
      idempotencyKey: 'install:fixture.workspace-tools:1',
    }
    const started = await controller.start(request)
    const joined = await controller.start(request)
    const busy = await controller.start({
      ...request,
      pluginId: 'fixture.skill-pack',
      idempotencyKey: 'install:fixture.skill-pack:1',
    })

    expect(started).toMatchObject({ kind: 'started', operation: { operationId: 'operation-1' } })
    expect(joined).toMatchObject({ kind: 'joined', operation: { operationId: 'operation-1' } })
    expect(busy).toEqual({ kind: 'busy', activeOperationId: 'operation-1' })
    expect(controller.active).toBe(true)

    continueRun.resolve(undefined)
    await controller.whenSettled()
    expect(controller.getOperation()).toMatchObject({ phase: 'committed', hostGeneration: 2, failureCode: null })
    expect(phases).toEqual([
      'preflight', 'downloading', 'snapshotting', 'installing', 'verifying-runtime', 'committed',
    ])

    const durable = await journal.read()
    expect(durable).toMatchObject({
      operation: { phase: 'committed', operationId: 'operation-1' },
      priorFingerprint: { profileRevision: 7 },
      priorSnapshot: { snapshotId: 'operation-1' },
    })
    const rehydrated = new PluginOperationController(
      journal,
      async () => ({ hostGeneration: 3, fingerprint: fingerprint(), runtimeEvidence: runtimeEvidence() }),
      () => PROFILE_IDENTITY,
      async () => {},
    )
    await rehydrated.initialize()
    expect(rehydrated.getOperation()).toEqual(controller.getOperation())
  })

  it('rejects renderer mutation authority before creating a journal', async () => {
    const root = await temporaryRoot()
    const journal = new PluginOperationJournal(join(root, 'journal'))
    const controller = new PluginOperationController(
      journal,
      async () => ({ hostGeneration: 1, fingerprint: fingerprint(), runtimeEvidence: runtimeEvidence() }),
      () => PROFILE_IDENTITY,
      async () => {},
    )
    await controller.initialize()

    await expect(controller.start({
      pluginId: 'fixture.workspace-tools',
      version: '1.0.0',
      idempotencyKey: 'install:1',
      packageName: '@evil/package',
      command: 'pnpm add @evil/package',
      path: '/tmp/evil.tgz',
      registry: 'https://evil.example',
      env: { PATH: '/tmp' },
    })).rejects.toThrow()
    await expect(journal.read()).resolves.toBeNull()
  })

  it('holds one cross-process Profile lock and never removes a replacement owner', async () => {
    const root = await temporaryRoot()
    const lock = new ProfileMutationLock(join(root, 'profile'))
    const first = await lock.acquire('operation-1')
    await expect(lock.acquire('operation-2')).rejects.toBeInstanceOf(ProfileMutationBusyError)
    await first.release()

    const second = await lock.acquire('operation-2')
    const displaced = `${second.path}.old`
    await rename(second.path, displaced)
    await writeFile(second.path, '{"nonce":"replacement"}\n', { mode: 0o600 })
    await second.release()
    await expect(readFile(second.path, 'utf8')).resolves.toContain('replacement')
    await rm(second.path)
    await rm(displaced)
  })

  it('reclaims only a dead lock for the same durable recovery operation', async () => {
    const root = await temporaryRoot()
    const lock = new ProfileMutationLock(join(root, 'profile'))
    const deadPid = 2_147_483_647
    const content = (operationId: string, pid: number, nonce: string) => `${JSON.stringify({
      schemaVersion: 1,
      operationId,
      pid,
      nonce,
    })}\n`

    await mkdir(join(root, 'profile'), { recursive: true })
    await writeFile(lock.path, content('operation-1', process.pid, 'live-owner'))
    await expect(lock.acquireRecovery('operation-1')).rejects.toBeInstanceOf(ProfileMutationBusyError)

    await writeFile(lock.path, content('operation-2', deadPid, 'different-owner'))
    await expect(lock.acquireRecovery('operation-1')).rejects.toBeInstanceOf(ProfileMutationBusyError)

    await writeFile(lock.path, content('operation-1', deadPid, 'dead-owner'))
    await writeFile(lock.recoveryPath, content('operation-1', deadPid, 'dead-recovery-owner'))
    const recovered = await lock.acquireRecovery('operation-1')
    await expect(readFile(recovered.path, 'utf8')).resolves.toContain(`"pid":${String(process.pid)}`)
    await expect(stat(lock.recoveryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await recovered.release()
    await expect(stat(lock.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('captures all install-owned Profile files before mutation in a private snapshot', async () => {
    const root = await temporaryRoot()
    const profile = join(root, 'profile')
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await writeFile(join(profile, 'package.json'), '{"dependencies":{}}\n')
    await writeFile(join(profile, 'cordis.patch.yml'), '- base\n')
    await chmod(join(profile, 'package.json'), 0o644)
    const store = new ProfileSnapshotStore(profile, join(root, 'snapshots'), clock())
    const snapshot = await store.capture('operation-1', '@fixture/dsh-workspace-tools')

    expect(snapshot.targetPackageExisted).toBe(false)
    expect(snapshot.files.map(file => [file.path, file.contentBase64 !== null])).toEqual([
      ['package.json', true],
      ['pnpm-lock.yaml', false],
      ['cordis.patch.yml', true],
      ['node_modules/.modules.yaml', false],
    ])
    const filename = join(root, 'snapshots/operation-1/profile-snapshot.json')
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual(snapshot)
    if (process.platform !== 'win32') expect((await stat(filename)).mode & 0o777).toBe(0o600)
  })
})
