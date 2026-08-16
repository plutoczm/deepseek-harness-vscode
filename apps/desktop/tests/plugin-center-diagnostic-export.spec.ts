import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginTransactionJournalRecord } from '@deepseek-ai/dsh-plugin-center-contracts'
import { PluginRecoveryDiagnosticExporter } from '../src/plugin-center/diagnostic-export.ts'
import { PluginOperationJournal } from '../src/plugin-center/operation-journal.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = join(tmpdir(), `dsh-plugin-diagnostic-${process.pid}-${String(roots.length)}`)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function initialRecord(): PluginTransactionJournalRecord {
  const at = '2026-08-15T01:00:00.000Z'
  const operation = {
    schemaVersion: 1 as const,
    operationId: 'operation-1',
    idempotencyKey: 'install:fixture.workspace-tools:1',
    profileName: 'web' as const,
    action: 'install' as const,
    pluginId: 'fixture.workspace-tools',
    version: '1.0.0',
    phase: 'preflight' as const,
    startedAt: at,
    updatedAt: at,
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
      startedAt: at,
    },
    operation,
    priorFingerprint: null,
    priorSnapshot: null,
    phaseHistory: [{
      sequence: 0,
      phase: 'preflight',
      boundary: 'observation',
      at,
      operationFailureCode: null,
      recoveryReasonCode: null,
    }],
    commitMarker: null,
    terminalResult: null,
    recoveryAttempt: 0,
    recoveryReasonCode: null,
  }
}

describe('Plugin Center recovery diagnostic export', () => {
  it('exports only whitelisted recovery facts without path, token, or content canaries', async () => {
    const root = await temporaryRoot()
    const journal = new PluginOperationJournal(join(root, 'journal'))
    const initial = initialRecord()
    await journal.write(initial)
    const foundation: PluginTransactionJournalRecord = {
      ...initial,
      priorFingerprint: {
        desktopVersion: '0.1.0-rc.5',
        dshVersion: '0.1.0-rc.5',
        nodeVersion: '22.22.0',
        platform: 'darwin-arm64',
        catalogEtag: 'token-canary-never-export',
        catalogFreshness: 'fresh',
        profileRevision: 1,
        installedPlugins: [],
        protectedPackageNames: ['@deepseek-ai/dsh-base'],
        protectedEntryIds: ['content-canary-never-export'],
        activeOperation: false,
      },
      priorSnapshot: {
        snapshotId: 'operation-1',
        snapshotSha256: 'b'.repeat(64),
        runtimeEvidence: {
          entries: [],
          clientModules: ['path-canary-never-export'],
          skillIds: [],
        },
      },
    }
    await journal.write(foundation)
    const failedAt = '2026-08-15T01:00:01.000Z'
    await journal.write({
      ...foundation,
      operation: {
        ...foundation.operation,
        phase: 'recovery-failed',
        updatedAt: failedAt,
        failureCode: 'internal',
      },
      phaseHistory: [...foundation.phaseHistory, {
        sequence: 1,
        phase: 'recovery-failed',
        boundary: 'observation',
        at: failedAt,
        operationFailureCode: 'internal',
        recoveryReasonCode: 'runtime-verification-failed',
      }],
      terminalResult: 'recovery-failed',
      recoveryAttempt: 1,
      recoveryReasonCode: 'runtime-verification-failed',
    })
    const exporter = new PluginRecoveryDiagnosticExporter(
      journal,
      () => new Date('2026-08-15T01:00:02.000Z'),
    )
    const destination = join(root, 'exports', 'recovery.json')

    await expect(exporter.export('operation-1', async () => destination)).resolves.toMatchObject({
      status: 'saved',
      filename: 'recovery.json',
    })
    const exported = await readFile(destination, 'utf8')
    expect(exported).toContain('runtime-verification-failed')
    expect(exported).not.toContain(root)
    expect(exported).not.toContain('token-canary-never-export')
    expect(exported).not.toContain('content-canary-never-export')
    expect(exported).not.toContain('path-canary-never-export')
    expect(Object.keys(JSON.parse(exported) as Record<string, unknown>).sort()).toEqual([
      'action', 'exportedAt', 'journalStatus', 'operationId', 'phaseHistory', 'pluginId', 'profileName',
      'recoveryAttempt', 'recoveryReasonCode', 'schemaVersion', 'terminalResult', 'version',
    ])
  })

  it('returns explicit cancellation without writing a file', async () => {
    const root = await temporaryRoot()
    const journal = new PluginOperationJournal(join(root, 'journal'))
    await journal.write(initialRecord())
    const exporter = new PluginRecoveryDiagnosticExporter(journal)

    await expect(exporter.export('operation-1', async () => null)).resolves.toEqual({
      operationId: 'operation-1',
      status: 'cancelled',
      filename: null,
      sha256: null,
      bytes: null,
    })
  })

  it('exports only a stable reason when the journal version is unreadable', async () => {
    const root = await temporaryRoot()
    const directory = join(root, 'journal')
    const journal = new PluginOperationJournal(directory)
    await mkdir(directory)
    await writeFile(journal.filename, '{"schemaVersion":999,"token":"secret-canary"}\n')
    const exporter = new PluginRecoveryDiagnosticExporter(
      journal,
      () => new Date('2026-08-15T01:00:02.000Z'),
    )
    const destination = join(root, 'unreadable.json')

    await expect(exporter.export('unreadable-journal', async () => destination)).resolves.toMatchObject({
      status: 'saved',
      filename: 'unreadable.json',
    })
    const exported = await readFile(destination, 'utf8')
    expect(exported).toContain('unsupported-journal-version')
    expect(exported).not.toContain('secret-canary')
    expect(JSON.parse(exported)).toMatchObject({
      journalStatus: 'unreadable',
      profileName: null,
      action: null,
      pluginId: null,
      version: null,
      phaseHistory: [],
    })
  })
})
