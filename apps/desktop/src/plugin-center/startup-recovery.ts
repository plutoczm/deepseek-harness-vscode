/** Startup gate that gives an open Plugin Center journal ownership before ordinary Host boot. */

import type { PluginRecoverySnapshot } from '@deepseek-ai/dsh-plugin-center-contracts'
import {
  PluginOperationJournalError,
  type PluginOperationJournal,
} from './operation-journal.ts'
import {
  blocksNormalPluginStartup,
  needsAutomaticPluginRecovery,
  type PluginRecoveryController,
} from './recovery-controller.ts'

export interface PluginStartupRecoveryResult {
  readonly mode: 'normal' | 'recovery-failed'
  readonly recovery: PluginRecoverySnapshot | null
}

/** Recover an interrupted operation first, then start the normal Host only after a safe terminal state. */
export async function preparePluginCenterStartup(input: {
  readonly journal: PluginOperationJournal
  readonly recovery: PluginRecoveryController
  readonly startNormalHost: () => Promise<unknown>
}): Promise<PluginStartupRecoveryResult> {
  let before
  try {
    before = await input.journal.read()
  } catch (error) {
    if (!(error instanceof PluginOperationJournalError)) throw error
    return { mode: 'recovery-failed', recovery: await input.recovery.getSnapshot() }
  }
  if (needsAutomaticPluginRecovery(before)) await input.recovery.recoverOpen('internal')
  let after
  try {
    after = await input.journal.read()
  } catch (error) {
    if (!(error instanceof PluginOperationJournalError)) throw error
    return { mode: 'recovery-failed', recovery: await input.recovery.getSnapshot() }
  }
  const recovery = await input.recovery.getSnapshot()
  if (blocksNormalPluginStartup(after)) return { mode: 'recovery-failed', recovery }
  await input.startNormalHost()
  return { mode: 'normal', recovery }
}
