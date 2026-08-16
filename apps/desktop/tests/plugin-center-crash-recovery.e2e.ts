import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginRecoverySnapshot,
  PluginTransactionJournalRecord,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import { PluginOperationJournal } from '../src/plugin-center/operation-journal.ts'
import type { PluginRecoveryController } from '../src/plugin-center/recovery-controller.ts'
import { preparePluginCenterStartup } from '../src/plugin-center/startup-recovery.ts'

const roots: string[] = []
const STARTED_AT = '2026-08-15T01:00:00.000Z'

async function temporaryRoot(): Promise<string> {
  const root = join(tmpdir(), `dsh-plugin-startup-recovery-${process.pid}-${String(roots.length)}`)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function initialRecord(): PluginTransactionJournalRecord {
  const operation = {
    schemaVersion: 1 as const,
    operationId: 'operation-1',
    idempotencyKey: 'install:fixture.workspace-tools:1',
    profileName: 'web' as const,
    action: 'install' as const,
    pluginId: 'fixture.workspace-tools',
    version: '1.0.0',
    phase: 'preflight' as const,
    startedAt: STARTED_AT,
    updatedAt: STARTED_AT,
    hostGeneration: null,
    failureCode: null,
  }
  return {
    schemaVersion: 2,
    header: {
      operationId: operation.operationId,
      idempotencyKey: operation.idempotencyKey,
      profileIdentity: { profileName: 'web', rootSha256: 'a'.repeat(64) },
      action: operation.action,
      pluginId: operation.pluginId,
      version: operation.version,
      startedAt: operation.startedAt,
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
}

function foundation(record: PluginTransactionJournalRecord): PluginTransactionJournalRecord {
  return {
    ...record,
    priorFingerprint: {
      desktopVersion: '0.1.0-rc.5',
      dshVersion: '0.1.0-rc.5',
      nodeVersion: '22.22.0',
      platform: 'darwin-arm64',
      catalogEtag: 'fixture-v1',
      catalogFreshness: 'fresh',
      profileRevision: 1,
      installedPlugins: [],
      protectedPackageNames: ['@deepseek-ai/dsh-base'],
      protectedEntryIds: ['agent-loop'],
      activeOperation: false,
    },
    priorSnapshot: {
      snapshotId: 'operation-1',
      snapshotSha256: 'b'.repeat(64),
      runtimeEvidence: { entries: [], clientModules: [], skillIds: [] },
    },
  }
}

function appendRecovery(
  record: PluginTransactionJournalRecord,
  phase: 'recovery-restoring-profile' | 'rolled-back' | 'recovery-failed',
  terminalResult: 'rolled-back' | 'recovery-failed' | null,
  reason: 'profile-restore-failed' | null = null,
): PluginTransactionJournalRecord {
  const at = `2026-08-15T01:00:0${String(record.phaseHistory.length)}.000Z`
  return {
    ...record,
    operation: {
      ...record.operation,
      phase,
      updatedAt: at,
      failureCode: 'internal',
    },
    phaseHistory: [...record.phaseHistory, {
      sequence: record.phaseHistory.length,
      phase,
      boundary: phase === 'recovery-restoring-profile' ? 'before-side-effect' : 'observation',
      at,
      operationFailureCode: 'internal',
      recoveryReasonCode: reason,
    }],
    terminalResult,
    recoveryAttempt: 1,
    recoveryReasonCode: reason,
  }
}

function snapshot(phase: 'rolled-back' | 'recovery-failed'): PluginRecoverySnapshot {
  return {
    schemaVersion: 1,
    operationId: 'operation-1',
    phase,
    recoveryPhase: null,
    operationFailureCode: 'internal',
    recoveryReasonCode: phase === 'recovery-failed' ? 'profile-restore-failed' : null,
    attempt: 1,
    updatedAt: '2026-08-15T01:00:03.000Z',
    canRetry: phase === 'recovery-failed',
    canExportDiagnostics: true,
  }
}

describe('Plugin Center crash startup ownership', () => {
  it('startup replay completes an open journal before normal Host start', async () => {
    const root = await temporaryRoot()
    const journal = new PluginOperationJournal(join(root, 'journal'))
    await journal.write(initialRecord())
    const events: string[] = []
    const recovery = {
      recoverOpen: vi.fn(async () => {
        events.push('recover')
        const current = await journal.read()
        if (current === null) throw new Error('missing fixture journal')
        await journal.write({
          ...current,
          operation: {
            ...current.operation,
            phase: 'rolled-back',
            updatedAt: '2026-08-15T01:00:01.000Z',
            failureCode: 'internal',
          },
          phaseHistory: [...current.phaseHistory, {
            sequence: 1,
            phase: 'rolled-back',
            boundary: 'observation',
            at: '2026-08-15T01:00:01.000Z',
            operationFailureCode: 'internal',
            recoveryReasonCode: null,
          }],
          terminalResult: 'rolled-back',
          recoveryAttempt: 1,
        })
        return snapshot('rolled-back')
      }),
      getSnapshot: vi.fn(async () => snapshot('rolled-back')),
    } as unknown as PluginRecoveryController

    await expect(preparePluginCenterStartup({
      journal,
      recovery,
      startNormalHost: async () => { events.push('normal-host') },
    })).resolves.toMatchObject({ mode: 'normal', recovery: { phase: 'rolled-back' } })
    expect(events).toEqual(['recover', 'normal-host'])
  })

  it('startup replay resumes after a second interruption inside recovery', async () => {
    const root = await temporaryRoot()
    const journal = new PluginOperationJournal(join(root, 'journal'))
    const initial = initialRecord()
    await journal.write(initial)
    const withFoundation = foundation(initial)
    await journal.write(withFoundation)
    await journal.write(appendRecovery(withFoundation, 'recovery-restoring-profile', null))
    const events: string[] = []
    const recovery = {
      recoverOpen: vi.fn(async () => {
        events.push('resume-recovery')
        const current = await journal.read()
        if (current === null) throw new Error('missing fixture journal')
        await journal.write(appendRecovery(current, 'rolled-back', 'rolled-back'))
        return snapshot('rolled-back')
      }),
      getSnapshot: vi.fn(async () => snapshot('rolled-back')),
    } as unknown as PluginRecoveryController

    await expect(preparePluginCenterStartup({
      journal,
      recovery,
      startNormalHost: async () => { events.push('normal-host') },
    })).resolves.toMatchObject({ mode: 'normal' })
    expect(events).toEqual(['resume-recovery', 'normal-host'])
    await expect(journal.read()).resolves.toMatchObject({ terminalResult: 'rolled-back' })
  })

  it('startup replay keeps normal Host closed after a durable recovery failure', async () => {
    const root = await temporaryRoot()
    const journal = new PluginOperationJournal(join(root, 'journal'))
    const initial = initialRecord()
    await journal.write(initial)
    const withFoundation = foundation(initial)
    await journal.write(withFoundation)
    await journal.write(appendRecovery(withFoundation, 'recovery-failed', 'recovery-failed', 'profile-restore-failed'))
    const startNormalHost = vi.fn(async () => {})
    const recoverOpen = vi.fn()
    const recovery = {
      recoverOpen,
      getSnapshot: vi.fn(async () => snapshot('recovery-failed')),
    } as unknown as PluginRecoveryController

    await expect(preparePluginCenterStartup({ journal, recovery, startNormalHost })).resolves.toMatchObject({
      mode: 'recovery-failed',
      recovery: { canRetry: true },
    })
    expect(recoverOpen).not.toHaveBeenCalled()
    expect(startNormalHost).not.toHaveBeenCalled()
  })

  it('keeps normal Host closed when a future journal version cannot be decoded', async () => {
    const root = await temporaryRoot()
    const directory = join(root, 'journal')
    const journal = new PluginOperationJournal(directory)
    await mkdir(directory)
    await writeFile(journal.filename, '{"schemaVersion":999,"private":"must-not-project"}\n')
    const startNormalHost = vi.fn(async () => {})
    const recoverOpen = vi.fn()
    const recovery = {
      recoverOpen,
      getSnapshot: vi.fn(async () => ({
        schemaVersion: 1,
        operationId: 'unreadable-journal',
        phase: 'recovery-failed',
        recoveryPhase: null,
        operationFailureCode: 'internal',
        recoveryReasonCode: 'unsupported-journal-version',
        attempt: 1,
        updatedAt: '2026-08-15T01:00:03.000Z',
        canRetry: true,
        canExportDiagnostics: true,
      })),
    } as unknown as PluginRecoveryController

    await expect(preparePluginCenterStartup({ journal, recovery, startNormalHost })).resolves.toMatchObject({
      mode: 'recovery-failed',
      recovery: {
        operationId: 'unreadable-journal',
        recoveryReasonCode: 'unsupported-journal-version',
      },
    })
    expect(recoverOpen).not.toHaveBeenCalled()
    expect(startNormalHost).not.toHaveBeenCalled()
  })
})
