import { describe, expect, it } from 'vitest'
import {
  CatalogContractError,
  decodePluginDiagnosticExportRequest,
  decodePluginDiagnosticExportResult,
  decodePluginRecoveryDiagnostic,
  decodePluginRecoveryRetryRequest,
  decodePluginRecoverySnapshot,
  decodePluginRuntimeEvidence,
  decodePluginTransactionJournalRecord,
} from '../src/index.ts'

const OPERATION_ID = '019c1234-1234-1234-1234-123456789abc'
const STARTED_AT = '2026-08-15T01:00:00.000Z'
const RECOVERY_AT = '2026-08-15T01:00:03.000Z'

function runtimeEvidence() {
  return {
    entries: [{ entryId: 'include:fixture.workspace-tools', enabled: true, fiberPhase: 'active' }],
    clientModules: ['@deepseek-ai/dsh-plugin-center-fixture'],
    skillIds: ['fixture.workspace-tools'],
  }
}

function fingerprint() {
  return {
    desktopVersion: '0.1.0-rc.5',
    dshVersion: '0.1.0-rc.5',
    nodeVersion: '22.22.0',
    platform: 'darwin-arm64',
    catalogEtag: 'catalog-v1',
    catalogFreshness: 'fresh',
    profileRevision: 3,
    installedPlugins: [],
    protectedPackageNames: ['@deepseek-ai/dsh-base'],
    protectedEntryIds: ['agent-loop'],
    activeOperation: false,
  }
}

function recoveringJournal() {
  const operation = {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    idempotencyKey: 'install:fixture.workspace-tools:019c',
    profileName: 'web',
    action: 'install',
    pluginId: 'fixture.workspace-tools',
    version: '1.2.3',
    phase: 'recovery-restoring-profile',
    startedAt: STARTED_AT,
    updatedAt: RECOVERY_AT,
    hostGeneration: 3,
    failureCode: 'package-mutation-failed',
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
    priorFingerprint: fingerprint(),
    priorSnapshot: {
      snapshotId: 'snapshot.019c',
      snapshotSha256: 'b'.repeat(64),
      runtimeEvidence: runtimeEvidence(),
    },
    phaseHistory: [
      {
        sequence: 0,
        phase: 'preflight',
        boundary: 'observation',
        at: STARTED_AT,
        operationFailureCode: null,
        recoveryReasonCode: null,
      },
      {
        sequence: 1,
        phase: 'installing',
        boundary: 'before-side-effect',
        at: '2026-08-15T01:00:01.000Z',
        operationFailureCode: null,
        recoveryReasonCode: null,
      },
      {
        sequence: 2,
        phase: 'recovery-restoring-profile',
        boundary: 'before-side-effect',
        at: RECOVERY_AT,
        operationFailureCode: 'package-mutation-failed',
        recoveryReasonCode: null,
      },
    ],
    commitMarker: null,
    terminalResult: null,
    recoveryAttempt: 1,
    recoveryReasonCode: null,
  }
}

describe('plugin center recovery contract', () => {
  it('accepts a hash-bound recovering journal and exact prior runtime inventory', () => {
    const journal = recoveringJournal()

    expect(decodePluginRuntimeEvidence(runtimeEvidence())).toEqual(runtimeEvidence())
    expect(decodePluginTransactionJournalRecord(journal)).toEqual(journal)
  })

  it('accepts only explicit committed, rolled-back, and recovery-failed terminal records', () => {
    const recovering = recoveringJournal()
    const committedAt = '2026-08-15T01:00:04.000Z'
    const committed = {
      ...recovering,
      operation: {
        ...recovering.operation,
        phase: 'committed',
        updatedAt: committedAt,
        failureCode: null,
      },
      phaseHistory: [
        ...recovering.phaseHistory.slice(0, 2),
        {
          sequence: 2,
          phase: 'committed',
          boundary: 'observation',
          at: committedAt,
          operationFailureCode: null,
          recoveryReasonCode: null,
        },
      ],
      commitMarker: {
        committedAt,
        fingerprintSha256: 'c'.repeat(64),
        runtimeEvidence: runtimeEvidence(),
      },
      terminalResult: 'committed',
      recoveryAttempt: 0,
    }
    expect(decodePluginTransactionJournalRecord(committed)).toEqual(committed)

    const rolledBack = {
      ...recovering,
      operation: { ...recovering.operation, phase: 'rolled-back', updatedAt: committedAt },
      phaseHistory: [
        ...recovering.phaseHistory,
        {
          sequence: 3,
          phase: 'rolled-back',
          boundary: 'observation',
          at: committedAt,
          operationFailureCode: 'package-mutation-failed',
          recoveryReasonCode: null,
        },
      ],
      terminalResult: 'rolled-back',
    }
    expect(decodePluginTransactionJournalRecord(rolledBack)).toEqual(rolledBack)

    const recoveryFailed = {
      ...recovering,
      operation: { ...recovering.operation, phase: 'recovery-failed', updatedAt: committedAt },
      phaseHistory: [
        ...recovering.phaseHistory,
        {
          sequence: 3,
          phase: 'recovery-failed',
          boundary: 'observation',
          at: committedAt,
          operationFailureCode: 'package-mutation-failed',
          recoveryReasonCode: 'profile-restore-failed',
        },
      ],
      terminalResult: 'recovery-failed',
      recoveryReasonCode: 'profile-restore-failed',
    }
    expect(decodePluginTransactionJournalRecord(recoveryFailed)).toEqual(recoveryFailed)
  })

  it.each([
    ['future schema', () => decodePluginTransactionJournalRecord({ ...recoveringJournal(), schemaVersion: 3 })],
    ['header drift', () => {
      const journal = recoveringJournal()
      return decodePluginTransactionJournalRecord({
        ...journal,
        header: { ...journal.header, pluginId: 'fixture.other' },
      })
    }],
    ['non-contiguous history', () => {
      const journal = recoveringJournal()
      return decodePluginTransactionJournalRecord({
        ...journal,
        phaseHistory: journal.phaseHistory.map((entry, index) => index === 1 ? { ...entry, sequence: 7 } : entry),
      })
    }],
    ['commit marker without committed terminal state', () => {
      const journal = recoveringJournal()
      return decodePluginTransactionJournalRecord({
        ...journal,
        commitMarker: {
          committedAt: '2026-08-15T01:00:04.000Z',
          fingerprintSha256: 'c'.repeat(64),
          runtimeEvidence: runtimeEvidence(),
        },
      })
    }],
    ['mutation phase without a durable recovery foundation', () => {
      const journal = recoveringJournal()
      return decodePluginTransactionJournalRecord({
        ...journal,
        priorFingerprint: null,
        priorSnapshot: null,
      })
    }],
  ])('rejects %s', (_name, run) => {
    expect(run).toThrow(CatalogContractError)
  })

  it('keeps retry and diagnostic export as path-free renderer intents', () => {
    expect(decodePluginRecoveryRetryRequest({ operationId: OPERATION_ID }))
      .toEqual({ operationId: OPERATION_ID })
    expect(decodePluginDiagnosticExportRequest({ operationId: OPERATION_ID }))
      .toEqual({ operationId: OPERATION_ID })
    expect(() => decodePluginDiagnosticExportRequest({
      operationId: OPERATION_ID,
      outputPath: '/tmp/recovery.json',
    })).toThrow(CatalogContractError)

    const saved = {
      operationId: OPERATION_ID,
      status: 'saved',
      filename: `dsh-plugin-recovery-${OPERATION_ID}.json`,
      sha256: 'd'.repeat(64),
      bytes: 2_048,
    }
    expect(decodePluginDiagnosticExportResult(saved)).toEqual(saved)
    expect(decodePluginDiagnosticExportResult({
      operationId: OPERATION_ID,
      status: 'cancelled',
      filename: null,
      sha256: null,
      bytes: null,
    })).toEqual({
      operationId: OPERATION_ID,
      status: 'cancelled',
      filename: null,
      sha256: null,
      bytes: null,
    })
  })

  it('exposes honest recovery states and rejects secret-shaped diagnostic additions', () => {
    const recovery = {
      schemaVersion: 1,
      operationId: OPERATION_ID,
      phase: 'recovery-failed',
      recoveryPhase: null,
      operationFailureCode: 'package-mutation-failed',
      recoveryReasonCode: 'profile-restore-failed',
      attempt: 1,
      updatedAt: RECOVERY_AT,
      canRetry: true,
      canExportDiagnostics: true,
    }
    expect(decodePluginRecoverySnapshot(recovery)).toEqual(recovery)

    const journal = recoveringJournal()
    const diagnostic = {
      schemaVersion: 1,
      journalStatus: 'readable',
      operationId: OPERATION_ID,
      profileName: 'web',
      action: 'install',
      pluginId: 'fixture.workspace-tools',
      version: '1.2.3',
      phaseHistory: journal.phaseHistory,
      terminalResult: null,
      recoveryAttempt: 1,
      recoveryReasonCode: null,
      exportedAt: '2026-08-15T01:00:04.000Z',
    }
    expect(decodePluginRecoveryDiagnostic(diagnostic)).toEqual(diagnostic)
    expect(() => decodePluginRecoveryDiagnostic({ ...diagnostic, token: 'secret' }))
      .toThrow(CatalogContractError)

    const unreadable = {
      schemaVersion: 1,
      journalStatus: 'unreadable',
      operationId: 'unreadable-journal',
      profileName: null,
      action: null,
      pluginId: null,
      version: null,
      phaseHistory: [],
      terminalResult: 'recovery-failed',
      recoveryAttempt: 1,
      recoveryReasonCode: 'unsupported-journal-version',
      exportedAt: '2026-08-15T01:00:04.000Z',
    }
    expect(decodePluginRecoveryDiagnostic(unreadable)).toEqual(unreadable)
    expect(() => decodePluginRecoveryDiagnostic({ ...unreadable, pluginId: 'guessed.plugin' }))
      .toThrow(CatalogContractError)
  })
})
