import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginTransactionJournalRecord } from '@deepseek-ai/dsh-plugin-center-contracts'
import {
  PluginOperationJournal,
} from '../src/plugin-center/operation-journal.ts'

const roots: string[] = []
const OPERATION_ID = 'operation-1'
const STARTED_AT = '2026-08-15T01:00:00.000Z'

async function temporaryRoot(): Promise<string> {
  const root = join(tmpdir(), `dsh-plugin-journal-${process.pid}-${String(roots.length)}`)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function runtimeEvidence() {
  return {
    entries: [{ entryId: 'include:fixture.workspace-tools', enabled: true, fiberPhase: 'active' }],
    clientModules: ['@fixture/dsh-workspace-tools-client'],
    skillIds: [],
  }
}

function fingerprint() {
  return {
    desktopVersion: '0.1.0-rc.5',
    dshVersion: '0.1.0-rc.5',
    nodeVersion: '22.22.0',
    platform: 'darwin-arm64' as const,
    catalogEtag: 'fixture-v1',
    catalogFreshness: 'fresh' as const,
    profileRevision: 7,
    installedPlugins: [],
    protectedPackageNames: ['@deepseek-ai/dsh-base'],
    protectedEntryIds: ['agent-loop'],
    activeOperation: false,
  }
}

function initialRecord(): PluginTransactionJournalRecord {
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
    hostGeneration: null,
    failureCode: null,
  }
  return {
    schemaVersion: 2,
    header: {
      operationId: OPERATION_ID,
      idempotencyKey: operation.idempotencyKey,
      profileIdentity: { profileName: 'web', rootSha256: 'a'.repeat(64) },
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
}

function numberedInitial(index: number): PluginTransactionJournalRecord {
  const record = initialRecord()
  const operationId = `operation-${String(index)}`
  const idempotencyKey = `install:fixture.workspace-tools:${String(index)}`
  const startedAt = `2026-08-15T01:00:${String(index * 2).padStart(2, '0')}.000Z`
  return {
    ...record,
    header: { ...record.header, operationId, idempotencyKey, startedAt },
    operation: { ...record.operation, operationId, idempotencyKey, startedAt, updatedAt: startedAt },
    phaseHistory: [{ ...record.phaseHistory[0]!, at: startedAt }],
  }
}

function rolledBack(record: PluginTransactionJournalRecord, index: number): PluginTransactionJournalRecord {
  const at = `2026-08-15T01:00:${String(index * 2 + 1).padStart(2, '0')}.000Z`
  return {
    ...record,
    operation: { ...record.operation, phase: 'rolled-back', updatedAt: at, failureCode: 'internal' },
    phaseHistory: [...record.phaseHistory, {
      sequence: 1,
      phase: 'rolled-back',
      boundary: 'observation',
      at,
      operationFailureCode: 'internal',
      recoveryReasonCode: null,
    }],
    terminalResult: 'rolled-back',
    recoveryAttempt: 1,
  }
}

function withFoundation(record: PluginTransactionJournalRecord): PluginTransactionJournalRecord {
  return {
    ...record,
    priorFingerprint: fingerprint(),
    priorSnapshot: {
      snapshotId: OPERATION_ID,
      snapshotSha256: 'b'.repeat(64),
      runtimeEvidence: runtimeEvidence(),
    },
  }
}

function appendPhase(
  record: PluginTransactionJournalRecord,
  phase: 'installing' | 'verifying-runtime' | 'committed',
  at: string,
): PluginTransactionJournalRecord {
  const operation = {
    ...record.operation,
    phase,
    updatedAt: at,
  }
  return {
    ...record,
    operation,
    phaseHistory: [...record.phaseHistory, {
      sequence: record.phaseHistory.length,
      phase,
      boundary: phase === 'installing' ? 'before-side-effect' as const : 'observation' as const,
      at,
      operationFailureCode: null,
      recoveryReasonCode: null,
    }],
  }
}

describe('Plugin Center transaction journal', () => {
  it('replays an append-only history and accepts only an explicit verified commit marker', async () => {
    const root = await temporaryRoot()
    const journal = new PluginOperationJournal(join(root, 'journal'))
    const initial = initialRecord()
    await journal.write(initial)
    const foundation = withFoundation(initial)
    await journal.write(foundation)
    const installing = appendPhase(foundation, 'installing', '2026-08-15T01:00:01.000Z')
    await journal.write(installing)
    const verified = appendPhase(installing, 'verifying-runtime', '2026-08-15T01:00:02.000Z')
    await journal.write(verified)
    const committedPhase = appendPhase(verified, 'committed', '2026-08-15T01:00:03.000Z')
    const committed: PluginTransactionJournalRecord = {
      ...committedPhase,
      commitMarker: {
        committedAt: '2026-08-15T01:00:03.000Z',
        fingerprintSha256: 'c'.repeat(64),
        runtimeEvidence: runtimeEvidence(),
      },
      terminalResult: 'committed',
    }
    await journal.write(committed)

    await expect(journal.read()).resolves.toEqual(committed)
    expect(JSON.parse(await readFile(journal.filename, 'utf8'))).toEqual(committed)
    await expect(journal.write(committed)).resolves.toBeUndefined()

    const nextInitial = initialRecord()
    const next: PluginTransactionJournalRecord = {
      ...nextInitial,
      header: {
        ...nextInitial.header,
        operationId: 'operation-2',
        idempotencyKey: 'install:fixture.workspace-tools:2',
      },
      operation: {
        ...nextInitial.operation,
        operationId: 'operation-2',
        idempotencyKey: 'install:fixture.workspace-tools:2',
      },
    }
    await journal.write(next)
    await expect(journal.read()).resolves.toEqual(next)
    expect(JSON.parse(await readFile(join(root, 'journal/history/operation-1.json'), 'utf8')))
      .toEqual(committed)
  })

  it('rejects immutable-header drift, history rewrites, and terminal reopening', async () => {
    const root = await temporaryRoot()
    const journal = new PluginOperationJournal(join(root, 'journal'))
    const initial = initialRecord()
    await journal.write(initial)

    await expect(journal.write({
      ...initial,
      header: { ...initial.header, pluginId: 'fixture.other' },
      operation: { ...initial.operation, pluginId: 'fixture.other' },
    })).rejects.toThrow('header is immutable')

    const foundation = withFoundation(initial)
    await journal.write(foundation)
    const installing = appendPhase(foundation, 'installing', '2026-08-15T01:00:01.000Z')
    await journal.write(installing)
    await expect(journal.write({
      ...installing,
      operation: { ...installing.operation, updatedAt: STARTED_AT, phase: 'preflight' },
      phaseHistory: installing.phaseHistory.slice(0, 1),
    })).rejects.toThrow('phase history is append-only')
  })

  it('classifies unsupported versions and corrupt JSON without guessing recovery state', async () => {
    const root = await temporaryRoot()
    const directory = join(root, 'journal')
    const journal = new PluginOperationJournal(directory)
    await mkdir(directory)
    await writeFile(journal.filename, '{"schemaVersion":1}\n')
    await expect(journal.read()).rejects.toMatchObject({
      reasonCode: 'unsupported-journal-version',
    })

    await writeFile(journal.filename, '{broken')
    await expect(journal.read()).rejects.toMatchObject({
      reasonCode: 'journal-invalid',
    })
  })

  it('requires the first durable write to be the empty preflight observation', async () => {
    const root = await temporaryRoot()
    const journal = new PluginOperationJournal(join(root, 'journal'))
    const invalid = appendPhase(withFoundation(initialRecord()), 'installing', '2026-08-15T01:00:01.000Z')

    await expect(journal.write(invalid)).rejects.toThrow('begin with one empty preflight observation')
    await expect(journal.read()).resolves.toBeNull()
  })

  it('keeps only twenty verified closed journal records while preserving the current record', async () => {
    const root = await temporaryRoot()
    const directory = join(root, 'journal')
    const journal = new PluginOperationJournal(directory)
    for (let index = 0; index < 23; index += 1) {
      const initial = numberedInitial(index)
      await journal.write(initial)
      await journal.write(rolledBack(initial, index))
    }

    const history = (await readdir(join(directory, 'history'))).sort()
    expect(history).toHaveLength(20)
    expect(history).not.toContain('operation-0.json')
    expect(history).not.toContain('operation-1.json')
    expect(history).toContain('operation-21.json')
    await expect(journal.read()).resolves.toMatchObject({
      header: { operationId: 'operation-22' },
      terminalResult: 'rolled-back',
    })
  })
})
