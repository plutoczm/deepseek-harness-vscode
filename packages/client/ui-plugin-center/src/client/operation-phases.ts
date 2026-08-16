/** Client-local ordered projection of the Desktop trusted-install phases. */

import type { PluginOperationPhase } from '@deepseek-ai/dsh-plugin-center-contracts'
import type { PluginCenterLocaleKey } from './locales.ts'

/** Ordered trusted-install phases rendered by the browser progress surface. */
export const PLUGIN_OPERATION_PHASES = [
  'preflight',
  'downloading',
  'verifying-artifact',
  'snapshotting',
  'stopping-host',
  'installing',
  'validating-profile',
  'starting-host',
  'reloading',
  'health-checking',
  'verifying-runtime',
  'committed',
  'failed',
] as const satisfies readonly PluginOperationPhase[]

/** One operation phase owned by the F003 trusted-install presentation. */
export type TrustedInstallPhase = typeof PLUGIN_OPERATION_PHASES[number]

const TRUSTED_INSTALL_PHASE_SET: ReadonlySet<PluginOperationPhase> = new Set<PluginOperationPhase>(
  PLUGIN_OPERATION_PHASES,
)

/** Locale key for each Desktop-owned trusted-install phase. */
export const PLUGIN_OPERATION_PHASE_KEYS = {
  preflight: 'phasePreflight',
  downloading: 'phaseDownloading',
  'verifying-artifact': 'phaseVerifyingArtifact',
  snapshotting: 'phaseSnapshotting',
  'stopping-host': 'phaseStoppingHost',
  installing: 'phaseInstalling',
  'validating-profile': 'phaseValidatingProfile',
  'starting-host': 'phaseStartingHost',
  reloading: 'phaseReloading',
  'health-checking': 'phaseHealthChecking',
  'verifying-runtime': 'phaseVerifyingRuntime',
  committed: 'phaseCommitted',
  failed: 'phaseFailed',
} as const satisfies Record<TrustedInstallPhase, PluginCenterLocaleKey>

/** User-facing groups that collapse implementation phases into four stable progress steps. */
export const PLUGIN_OPERATION_GROUPS = [
  {
    label: 'progressPreparing',
    phases: ['preflight', 'downloading', 'verifying-artifact', 'snapshotting'],
  },
  {
    label: 'progressInstalling',
    phases: ['stopping-host', 'installing', 'validating-profile'],
  },
  {
    label: 'progressReloading',
    phases: ['starting-host', 'reloading', 'health-checking'],
  },
  {
    label: 'progressVerifying',
    phases: ['verifying-runtime'],
  },
] as const satisfies readonly {
  readonly label: PluginCenterLocaleKey
  readonly phases: readonly TrustedInstallPhase[]
}[]

/**
 * Narrow the shared operation vocabulary to phases owned by the F003 UI.
 * @param phase - Phase received from the evolving Desktop operation protocol.
 * @returns True only for the trusted-install phases rendered by this Feature.
 */
export function isTrustedInstallPhase(phase: PluginOperationPhase): phase is TrustedInstallPhase {
  return TRUSTED_INSTALL_PHASE_SET.has(phase)
}

/**
 * Report whether an operation can no longer advance through F003.
 * @param phase - Current Desktop operation phase.
 * @returns True for committed or failed operations.
 */
export function isTerminalOperationPhase(phase: PluginOperationPhase): boolean {
  return phase === 'committed' || phase === 'failed' || phase === 'rolled-back' || phase === 'recovery-failed'
}

/**
 * Report whether an operation must keep later plugin mutations gated.
 * A completed rollback restored the previous environment and releases the gate;
 * failed recovery states stay gated until recovery succeeds.
 * @param phase - Current Desktop operation phase.
 * @returns True while another mutation is active or still needs recovery.
 */
export function isMutationBlockingOperationPhase(phase: PluginOperationPhase): boolean {
  return phase !== 'committed' && phase !== 'rolled-back'
}
