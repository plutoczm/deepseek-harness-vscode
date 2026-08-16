/** Single-operation controller backed by the version-2 recovery journal. */

import { createHash, randomUUID } from 'node:crypto'
import {
  PLUGIN_MUTATION_PHASES,
  decodePluginInstallRequest,
  decodePluginManagementRequest,
  decodePluginOperationSnapshot,
  decodePluginOperationStartResult,
  decodePluginRuntimeEvidence,
  type CompatibilityFingerprint,
  type PluginMutationRequest,
  type PluginMutationPhase,
  type PluginOperationBoundary,
  type PluginOperationFailureCode,
  type PluginOperationSnapshot,
  type PluginOperationStartResult,
  type PluginPriorSnapshotReference,
  type PluginProfileIdentity,
  type PluginRuntimeEvidence,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import {
  PluginOperationJournal,
  type PluginOperationJournalRecord,
} from './operation-journal.ts'

type RunningPhase = Exclude<PluginMutationPhase, 'preflight'>
type SideEffectPhase = Extract<
  RunningPhase,
  'stopping-host' | 'installing' | 'starting-host' | 'reloading'
>

/** One durable mutation point available to deterministic Desktop fault tests only. */
export interface PluginOperationFaultPoint {
  readonly operationId: string
  readonly action: PluginMutationRequest['action']
  readonly phase: RunningPhase
  readonly boundary: PluginOperationBoundary
}

/** Test-only failure seam that runs after its matching journal point is durable. */
export type PluginOperationFaultInjector = (
  point: PluginOperationFaultPoint,
) => void | Promise<void>

/** Snapshot and old runtime proof published together before the first Profile write. */
export interface PluginOperationFoundation {
  readonly snapshotId: string
  readonly snapshotSha256: string
  readonly profileIdentity: PluginProfileIdentity
  readonly runtimeEvidence: PluginRuntimeEvidence
}

/** Evidence required before the only committed marker may be written. */
export interface PluginOperationCommitEvidence {
  readonly hostGeneration: number | null
  readonly fingerprint: CompatibilityFingerprint
  readonly runtimeEvidence: PluginRuntimeEvidence
}

/** Mutation controls owned by the trusted Desktop executor. */
export interface PluginOperationControls {
  readonly operationId: string
  transition(
    phase: RunningPhase,
    hostGeneration?: number | null,
    boundary?: PluginOperationBoundary,
  ): Promise<PluginOperationSnapshot>
  recordFoundation(
    priorFingerprint: CompatibilityFingerprint,
    foundation: PluginOperationFoundation,
  ): Promise<void>
  completeSideEffect(
    phase: SideEffectPhase,
    hostGeneration?: number | null,
  ): Promise<void>
}

/** Trusted executor; fulfillment carries all target commit evidence. */
export type PluginOperationRunner = (
  request: PluginMutationRequest,
  controls: PluginOperationControls,
) => Promise<PluginOperationCommitEvidence>

/** Recovery continuation invoked for every non-committed runner failure. */
export type PluginOperationRecovery = (failureCode: PluginOperationFailureCode) => Promise<void>

/** Error carrying only a stable renderer-facing failure category. */
export class PluginOperationFailure extends Error {
  override readonly name = 'PluginOperationFailure'

  constructor(readonly code: PluginOperationFailureCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

function phaseIndex(phase: PluginMutationPhase): number {
  return PLUGIN_MUTATION_PHASES.indexOf(phase)
}

function defaultBoundary(phase: RunningPhase): PluginOperationBoundary {
  return phase === 'stopping-host' || phase === 'installing'
    || phase === 'starting-host' || phase === 'reloading'
    ? 'before-side-effect'
    : 'observation'
}

function fingerprintSha256(fingerprint: CompatibilityFingerprint): string {
  return createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex')
}

/** Owns idempotency, Profile serialization, durable state, commit, and recovery handoff. */
export class PluginOperationController {
  private record: PluginOperationJournalRecord | null = null
  private execution: Promise<void> | null = null
  private startGate: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(operation: PluginOperationSnapshot) => void>()

  constructor(
    private readonly journal: PluginOperationJournal,
    private readonly run: PluginOperationRunner,
    private readonly readProfileIdentity: () => PluginProfileIdentity | Promise<PluginProfileIdentity>,
    private readonly recover: PluginOperationRecovery,
    private readonly now: () => Date = () => new Date(),
    private readonly createOperationId: () => string = randomUUID,
    private readonly injectFault: PluginOperationFaultInjector = () => {},
  ) {}

  /** Hydrate the last durable value before registering renderer handlers. */
  async initialize(): Promise<void> {
    this.record = await this.journal.read()
  }

  getOperation(): PluginOperationSnapshot | null {
    return this.record?.operation ?? null
  }

  get active(): boolean {
    return this.record !== null && this.record.terminalResult === null
  }

  subscribe(listener: (operation: PluginOperationSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Start, join, or reject one exact install under a serialized ownership gate. */
  async start(value: unknown): Promise<PluginOperationStartResult> {
    const install = decodePluginInstallRequest(value)
    return await this.startRequest({ ...install, action: 'install' })
  }

  /** Start, join, or reject one installed-item action through the same owner. */
  async manage(value: unknown): Promise<PluginOperationStartResult> {
    return await this.startRequest(decodePluginManagementRequest(value))
  }

  private async startRequest(request: PluginMutationRequest): Promise<PluginOperationStartResult> {
    let release!: () => void
    const previous = this.startGate
    this.startGate = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const current = this.record
      if (current?.operation.idempotencyKey === request.idempotencyKey) {
        return decodePluginOperationStartResult({ kind: 'joined', operation: current.operation })
      }
      if (current !== null && current.terminalResult === null) {
        return decodePluginOperationStartResult({
          kind: 'busy',
          activeOperationId: current.operation.operationId,
        })
      }
      const timestamp = this.now().toISOString()
      const profileIdentity = await this.readProfileIdentity()
      const operation = decodePluginOperationSnapshot({
        schemaVersion: 1,
        operationId: this.createOperationId(),
        idempotencyKey: request.idempotencyKey,
        profileName: 'web',
        action: request.action,
        pluginId: request.pluginId,
        version: request.version,
        phase: 'preflight',
        startedAt: timestamp,
        updatedAt: timestamp,
        hostGeneration: null,
        failureCode: null,
      })
      const record: PluginOperationJournalRecord = {
        schemaVersion: 2,
        header: {
          operationId: operation.operationId,
          idempotencyKey: operation.idempotencyKey,
          profileIdentity,
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
          at: timestamp,
          operationFailureCode: null,
          recoveryReasonCode: null,
        }],
        commitMarker: null,
        terminalResult: null,
        recoveryAttempt: 0,
        recoveryReasonCode: null,
      }
      await this.journal.write(record)
      this.record = record
      this.publish(operation)
      this.execution = this.execute(request)
      return decodePluginOperationStartResult({ kind: 'started', operation })
    } finally {
      release()
    }
  }

  /** Test and shutdown join point for the currently running mutation/recovery. */
  async whenSettled(): Promise<void> {
    await this.execution
  }

  private async execute(request: PluginMutationRequest): Promise<void> {
    try {
      const operationId = this.requireActive().operation.operationId
      const evidence = await this.run(request, {
        operationId,
        transition: (phase, hostGeneration, boundary) => this.transition(phase, hostGeneration, boundary),
        recordFoundation: (fingerprint, foundation) => this.recordFoundation(fingerprint, foundation),
        completeSideEffect: (phase, hostGeneration) => this.completeSideEffect(phase, hostGeneration),
      })
      await this.commit(evidence)
    } catch (error) {
      const code = error instanceof PluginOperationFailure ? error.code : 'internal'
      try {
        await this.recover(code)
        this.record = await this.journal.read()
        if (this.record !== null) this.publish(this.record.operation)
      } catch (recoveryError) {
        console.error('plugin operation recovery could not be completed:', recoveryError)
        this.record = await this.journal.read().catch(() => this.record)
      }
    }
  }

  private async transition(
    phase: RunningPhase,
    hostGeneration?: number | null,
    boundary: PluginOperationBoundary = defaultBoundary(phase),
  ): Promise<PluginOperationSnapshot> {
    const current = this.requireActive()
    const currentPhase = current.operation.phase
    if (!PLUGIN_MUTATION_PHASES.includes(currentPhase as PluginMutationPhase)
      || phaseIndex(phase) <= phaseIndex(currentPhase as PluginMutationPhase)) {
      throw new Error(`plugin operation phase cannot move from ${currentPhase} to ${phase}`)
    }
    const timestamp = this.now().toISOString()
    const next = decodePluginOperationSnapshot({
      ...current.operation,
      phase,
      updatedAt: timestamp,
      hostGeneration: hostGeneration === undefined ? current.operation.hostGeneration : hostGeneration,
      failureCode: null,
    })
    await this.commitRecord({
      ...current,
      operation: next,
      phaseHistory: [...current.phaseHistory, {
        sequence: current.phaseHistory.length,
        phase,
        boundary,
        at: timestamp,
        operationFailureCode: null,
        recoveryReasonCode: null,
      }],
    })
    await this.injectFault({
      operationId: current.header.operationId,
      action: current.header.action,
      phase,
      boundary,
    })
    return next
  }

  private async completeSideEffect(
    phase: SideEffectPhase,
    hostGeneration?: number | null,
  ): Promise<void> {
    const current = this.requireActive()
    const latest = current.phaseHistory.at(-1)
    if (current.operation.phase !== phase || latest?.phase !== phase
      || latest.boundary !== 'before-side-effect') {
      throw new Error(`plugin operation cannot complete an unowned ${phase} side effect`)
    }
    const timestamp = this.now().toISOString()
    const next = decodePluginOperationSnapshot({
      ...current.operation,
      updatedAt: timestamp,
      hostGeneration: hostGeneration === undefined ? current.operation.hostGeneration : hostGeneration,
    })
    await this.commitRecord({
      ...current,
      operation: next,
      phaseHistory: [...current.phaseHistory, {
        sequence: current.phaseHistory.length,
        phase,
        boundary: 'after-side-effect',
        at: timestamp,
        operationFailureCode: null,
        recoveryReasonCode: null,
      }],
    }, false)
    await this.injectFault({
      operationId: current.header.operationId,
      action: current.header.action,
      phase,
      boundary: 'after-side-effect',
    })
  }

  private async commit(evidence: PluginOperationCommitEvidence): Promise<void> {
    const current = this.requireActive()
    if (current.priorSnapshot === null || current.priorFingerprint === null) {
      throw new Error('plugin operation cannot commit without prior recovery evidence')
    }
    const timestamp = this.now().toISOString()
    const runtimeEvidence = decodePluginRuntimeEvidence(evidence.runtimeEvidence)
    const next = decodePluginOperationSnapshot({
      ...current.operation,
      phase: 'committed',
      updatedAt: timestamp,
      hostGeneration: evidence.hostGeneration,
      failureCode: null,
    })
    await this.commitRecord({
      ...current,
      operation: next,
      phaseHistory: [...current.phaseHistory, {
        sequence: current.phaseHistory.length,
        phase: 'committed',
        boundary: 'observation',
        at: timestamp,
        operationFailureCode: null,
        recoveryReasonCode: null,
      }],
      commitMarker: {
        committedAt: timestamp,
        fingerprintSha256: fingerprintSha256(evidence.fingerprint),
        runtimeEvidence,
      },
      terminalResult: 'committed',
    })
  }

  private async recordFoundation(
    priorFingerprint: CompatibilityFingerprint,
    foundation: PluginOperationFoundation,
  ): Promise<void> {
    const current = this.requireActive()
    if (current.priorFingerprint !== null || current.priorSnapshot !== null) {
      throw new Error('plugin operation foundation is already durable')
    }
    if (foundation.profileIdentity.rootSha256 !== current.header.profileIdentity.rootSha256) {
      throw new Error('plugin operation snapshot belongs to a different Profile root')
    }
    const priorSnapshot: PluginPriorSnapshotReference = {
      snapshotId: foundation.snapshotId,
      snapshotSha256: foundation.snapshotSha256,
      runtimeEvidence: decodePluginRuntimeEvidence(foundation.runtimeEvidence),
    }
    await this.commitRecord({
      ...current,
      priorFingerprint,
      priorSnapshot,
    }, false)
  }

  private requireActive(): PluginOperationJournalRecord {
    if (this.record === null || this.record.terminalResult !== null) {
      throw new Error('plugin operation is not active')
    }
    return this.record
  }

  private async commitRecord(record: PluginOperationJournalRecord, notify = true): Promise<void> {
    await this.journal.write(record)
    this.record = record
    if (notify) this.publish(record.operation)
  }

  private publish(operation: PluginOperationSnapshot): void {
    for (const listener of this.listeners) {
      try { listener(operation) } catch (error) {
        console.error('plugin operation listener failed:', error)
      }
    }
  }
}
