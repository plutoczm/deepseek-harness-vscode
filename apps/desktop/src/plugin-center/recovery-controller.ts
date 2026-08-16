/** Idempotent recovery owner for one uncommitted Plugin Center transaction. */

import {
  decodePluginRecoverySnapshot,
  type PluginOperationBoundary,
  type PluginOperationFailureCode,
  type PluginOperationPhase,
  type PluginRecoveryPhase,
  type PluginRecoveryReasonCode,
  type PluginRecoverySnapshot,
  type PluginTransactionJournalRecord,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import type { HostSupervisor } from '../host-supervisor.ts'
import {
  restoreTrustedProfilePackages,
  type TrustedPackageManagerOptions,
} from './package-manager.ts'
import {
  PluginOperationJournal,
  PluginOperationJournalError,
  UNREADABLE_PLUGIN_JOURNAL_OPERATION_ID,
} from './operation-journal.ts'
import {
  ProfileSnapshotError,
  ProfileSnapshotStore,
} from './profile-snapshot-store.ts'
import {
  ProfileMutationBusyError,
  type AcquiredProfileLock,
  type ProfileMutationLock,
} from './profile-lock.ts'
import type { PluginRuntimeVerifier } from './runtime-verifier.ts'

/** A committed marker or verified rollback is the only state that permits normal startup. */
export function blocksNormalPluginStartup(record: PluginTransactionJournalRecord | null): boolean {
  return record !== null && record.terminalResult !== 'committed' && record.terminalResult !== 'rolled-back'
}

/** Only an unclosed record is automatically replayed; recovery-failed waits for explicit retry. */
export function needsAutomaticPluginRecovery(record: PluginTransactionJournalRecord | null): boolean {
  return record !== null && record.terminalResult === null
}

class RecoveryStepError extends Error {
  override readonly name = 'RecoveryStepError'
  readonly reasonCode: PluginRecoveryReasonCode

  constructor(reasonCode: PluginRecoveryReasonCode, options?: ErrorOptions) {
    super(`plugin recovery step failed: ${reasonCode}`, options)
    this.reasonCode = reasonCode
  }
}

export interface PluginRecoveryControllerOptions {
  readonly journal: PluginOperationJournal
  readonly snapshotStore: ProfileSnapshotStore
  readonly profileLock: ProfileMutationLock
  readonly packageManager: TrustedPackageManagerOptions
  readonly host: HostSupervisor
  readonly runtimeVerifier: PluginRuntimeVerifier
  readonly reloadHost?: (origin: string) => Promise<void>
  readonly now?: () => Date
}

function failureCode(record: PluginTransactionJournalRecord, supplied?: PluginOperationFailureCode): PluginOperationFailureCode {
  return record.operation.failureCode ?? supplied ?? 'internal'
}

function recoveryPhase(phase: PluginOperationPhase): PluginRecoveryPhase | null {
  return phase.startsWith('recovery-') && phase !== 'recovery-failed'
    ? phase as PluginRecoveryPhase
    : null
}

function projectRecovery(record: PluginTransactionJournalRecord): PluginRecoverySnapshot | null {
  const code = record.operation.failureCode
  if (code === null) return null
  const phase = recoveryPhase(record.operation.phase)
  if (phase !== null) {
    return decodePluginRecoverySnapshot({
      schemaVersion: 1,
      operationId: record.header.operationId,
      phase: 'recovering',
      recoveryPhase: phase,
      operationFailureCode: code,
      recoveryReasonCode: null,
      attempt: record.recoveryAttempt,
      updatedAt: record.operation.updatedAt,
      canRetry: false,
      canExportDiagnostics: true,
    })
  }
  if (record.terminalResult !== 'rolled-back' && record.terminalResult !== 'recovery-failed') return null
  return decodePluginRecoverySnapshot({
    schemaVersion: 1,
    operationId: record.header.operationId,
    phase: record.terminalResult,
    recoveryPhase: null,
    operationFailureCode: code,
    recoveryReasonCode: record.recoveryReasonCode,
    attempt: record.recoveryAttempt,
    updatedAt: record.operation.updatedAt,
    canRetry: record.terminalResult === 'recovery-failed',
    canExportDiagnostics: true,
  })
}

/** Restores prior Profile/package/runtime evidence before releasing startup ownership. */
export class PluginRecoveryController {
  private execution: Promise<PluginRecoverySnapshot | null> | null = null
  private readonly listeners = new Set<(snapshot: PluginRecoverySnapshot) => void>()
  private readonly now: () => Date

  constructor(private readonly options: PluginRecoveryControllerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  subscribe(listener: (snapshot: PluginRecoverySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async getSnapshot(): Promise<PluginRecoverySnapshot | null> {
    try {
      const record = await this.options.journal.read()
      return record === null ? null : projectRecovery(record)
    } catch (error) {
      if (error instanceof PluginOperationJournalError) return this.projectJournalFailure(error)
      throw error
    }
  }

  /** Replay one open record; a durable recovery-failed result is not retried silently. */
  async recoverOpen(failure?: PluginOperationFailureCode): Promise<PluginRecoverySnapshot | null> {
    return await this.run(false, undefined, failure)
  }

  /** Explicitly retry the same operation identity after a recovery failure. */
  async retry(operationId: string): Promise<PluginRecoverySnapshot | null> {
    if (operationId === UNREADABLE_PLUGIN_JOURNAL_OPERATION_ID) {
      return await this.run(false)
    }
    return await this.run(true, operationId)
  }

  private async run(
    retry: boolean,
    expectedOperationId?: string,
    suppliedFailure?: PluginOperationFailureCode,
  ): Promise<PluginRecoverySnapshot | null> {
    if (this.execution !== null) return await this.execution
    const execution = this.execute(retry, expectedOperationId, suppliedFailure).catch((error: unknown) => {
      if (error instanceof PluginOperationJournalError) return this.publishJournalFailure(error)
      throw error
    })
    this.execution = execution
    try {
      return await execution
    } finally {
      if (this.execution === execution) this.execution = null
    }
  }

  private async execute(
    retry: boolean,
    expectedOperationId?: string,
    suppliedFailure?: PluginOperationFailureCode,
  ): Promise<PluginRecoverySnapshot | null> {
    let record = await this.options.journal.read()
    if (record === null) return null
    if (expectedOperationId !== undefined && record.header.operationId !== expectedOperationId) {
      throw new Error('plugin recovery retry does not own the requested operation')
    }
    if (record.terminalResult === 'committed' || record.terminalResult === 'rolled-back') {
      return projectRecovery(record)
    }
    if (record.terminalResult === 'recovery-failed' && !retry) return projectRecovery(record)
    if (retry && record.terminalResult !== 'recovery-failed') return projectRecovery(record)

    const operationFailureCode = failureCode(record, suppliedFailure)
    const attempt = retry ? record.recoveryAttempt + 1 : Math.max(record.recoveryAttempt, 1)
    if (record.priorSnapshot === null) {
      record = await this.append(record, 'rolled-back', 'observation', operationFailureCode, attempt)
      return this.publish(record)
    }
    const priorSnapshot = record.priorSnapshot
    let activeRecord: PluginTransactionJournalRecord = record
    let recoveryLock: AcquiredProfileLock | undefined

    try {
      try {
        recoveryLock = await this.options.profileLock.acquireRecovery(activeRecord.header.operationId)
      } catch (error) {
        if (error instanceof ProfileMutationBusyError) {
          throw new RecoveryStepError('profile-lock-busy', { cause: error })
        }
        throw error
      }
      activeRecord = await this.append(
        activeRecord,
        'recovery-stopping-host',
        'before-side-effect',
        operationFailureCode,
        attempt,
      )
      const restartProgress = { entered: false, completed: false }
      let generation: Awaited<ReturnType<HostSupervisor['restart']>>
      try {
        generation = await this.options.host.restart(
          `recover plugin operation ${activeRecord.header.operationId}`,
          async () => {
            restartProgress.entered = true
            activeRecord = await this.append(
              activeRecord,
              'recovery-restoring-profile',
              'before-side-effect',
              operationFailureCode,
              attempt,
            )
            try {
              const restoredSnapshot = await this.options.snapshotStore.restore({
                snapshotId: priorSnapshot.snapshotId,
                snapshotSha256: priorSnapshot.snapshotSha256,
                operationId: activeRecord.header.operationId,
                profileIdentity: activeRecord.header.profileIdentity,
              })
              activeRecord = await this.append(
                activeRecord,
                'recovery-restoring-profile',
                'after-side-effect',
                operationFailureCode,
                attempt,
              )
              activeRecord = await this.append(
                activeRecord,
                'recovery-restoring-packages',
                'before-side-effect',
                operationFailureCode,
                attempt,
              )
              const frozen = restoredSnapshot.files.some(
                file => file.path === 'pnpm-lock.yaml' && file.sha256 !== null,
              )
              await restoreTrustedProfilePackages(this.options.packageManager, frozen)
              await this.options.snapshotStore.verifyTargetPackagePresence(restoredSnapshot)
            } catch (error) {
              if (error instanceof ProfileSnapshotError) {
                throw new RecoveryStepError(error.reasonCode, { cause: error })
              }
              if (activeRecord.operation.phase === 'recovery-restoring-profile') {
                throw new RecoveryStepError('profile-restore-failed', { cause: error })
              }
              throw new RecoveryStepError('package-restore-failed', { cause: error })
            }
            activeRecord = await this.append(
              activeRecord,
              'recovery-restoring-packages',
              'after-side-effect',
              operationFailureCode,
              attempt,
            )
            activeRecord = await this.append(
              activeRecord,
              'recovery-starting-host',
              'before-side-effect',
              operationFailureCode,
              attempt,
            )
            restartProgress.completed = true
          },
        )
      } catch (error) {
        if (error instanceof RecoveryStepError) throw error
        throw new RecoveryStepError(
          restartProgress.entered && restartProgress.completed ? 'host-start-failed' : 'host-stop-failed',
          { cause: error },
        )
      }

      activeRecord = await this.append(
        activeRecord,
        'recovery-verifying-runtime',
        'observation',
        operationFailureCode,
        attempt,
        generation.id,
      )
      try {
        await this.options.runtimeVerifier.verifyHealth(generation.origin)
        await this.options.runtimeVerifier.verifyEvidence(generation.origin, priorSnapshot.runtimeEvidence)
      } catch (error) {
        throw new RecoveryStepError('runtime-verification-failed', { cause: error })
      }
      try {
        await this.options.reloadHost?.(generation.origin)
      } catch (error) {
        throw new RecoveryStepError('host-start-failed', { cause: error })
      }
      await recoveryLock.release()
      recoveryLock = undefined
      activeRecord = await this.append(
        activeRecord,
        'rolled-back',
        'observation',
        operationFailureCode,
        attempt,
        generation.id,
      )
    } catch (error) {
      let reason = error instanceof RecoveryStepError ? error.reasonCode : 'journal-invalid'
      if (recoveryLock !== undefined) {
        try {
          await recoveryLock.release()
          recoveryLock = undefined
        } catch {
          reason = 'profile-lock-busy'
        }
      }
      activeRecord = await this.append(
        activeRecord,
        'recovery-failed',
        'observation',
        operationFailureCode,
        attempt,
        activeRecord.operation.hostGeneration,
        reason,
      )
    }
    return this.publish(activeRecord)
  }

  private async append(
    record: PluginTransactionJournalRecord,
    phase: PluginRecoveryPhase | 'rolled-back' | 'recovery-failed',
    boundary: PluginOperationBoundary,
    operationFailureCode: PluginOperationFailureCode,
    recoveryAttempt: number,
    hostGeneration: number | null = record.operation.hostGeneration,
    recoveryReasonCode: PluginRecoveryReasonCode | null = null,
  ): Promise<PluginTransactionJournalRecord> {
    const at = this.now().toISOString()
    const terminalResult = phase === 'rolled-back'
      ? 'rolled-back' as const
      : phase === 'recovery-failed'
        ? 'recovery-failed' as const
        : null
    const next: PluginTransactionJournalRecord = {
      ...record,
      operation: {
        ...record.operation,
        phase,
        updatedAt: at,
        hostGeneration,
        failureCode: operationFailureCode,
      },
      phaseHistory: [...record.phaseHistory, {
        sequence: record.phaseHistory.length,
        phase,
        boundary,
        at,
        operationFailureCode,
        recoveryReasonCode,
      }],
      commitMarker: null,
      terminalResult,
      recoveryAttempt,
      recoveryReasonCode,
    }
    await this.options.journal.write(next)
    const snapshot = projectRecovery(next)
    if (snapshot !== null) this.publishSnapshot(snapshot)
    return next
  }

  private publish(record: PluginTransactionJournalRecord): PluginRecoverySnapshot | null {
    const snapshot = projectRecovery(record)
    if (snapshot !== null) this.publishSnapshot(snapshot)
    return snapshot
  }

  private publishSnapshot(snapshot: PluginRecoverySnapshot): void {
    for (const listener of this.listeners) {
      try { listener(snapshot) } catch (error) {
        console.error('plugin recovery listener failed:', error)
      }
    }
  }

  private projectJournalFailure(error: PluginOperationJournalError): PluginRecoverySnapshot {
    return decodePluginRecoverySnapshot({
      schemaVersion: 1,
      operationId: UNREADABLE_PLUGIN_JOURNAL_OPERATION_ID,
      phase: 'recovery-failed',
      recoveryPhase: null,
      operationFailureCode: 'internal',
      recoveryReasonCode: error.reasonCode,
      attempt: 1,
      updatedAt: this.now().toISOString(),
      canRetry: true,
      canExportDiagnostics: true,
    })
  }

  private publishJournalFailure(error: PluginOperationJournalError): PluginRecoverySnapshot {
    const snapshot = this.projectJournalFailure(error)
    this.publishSnapshot(snapshot)
    return snapshot
  }
}
