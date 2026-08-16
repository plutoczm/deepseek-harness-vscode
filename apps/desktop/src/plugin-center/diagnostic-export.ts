/** User-initiated, field-whitelisted Plugin Center recovery diagnostic export. */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  decodePluginDiagnosticExportResult,
  decodePluginRecoveryDiagnostic,
  type PluginDiagnosticExportResult,
  type PluginRecoveryDiagnostic,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import {
  PluginOperationJournalError,
  UNREADABLE_PLUGIN_JOURNAL_OPERATION_ID,
  type PluginOperationJournal,
} from './operation-journal.ts'

/** Desktop-owned save selection; renderer input never supplies the path. */
export type PluginDiagnosticPathSelector = (defaultFilename: string) => Promise<string | null>

/** Creates and saves bounded recovery evidence without Profile paths, content, env, or tokens. */
export class PluginRecoveryDiagnosticExporter {
  constructor(
    private readonly journal: PluginOperationJournal,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Assemble the only diagnostic shape permitted to leave Desktop. */
  async create(operationId: string): Promise<PluginRecoveryDiagnostic> {
    let record
    try {
      record = await this.journal.read()
    } catch (error) {
      if (!(error instanceof PluginOperationJournalError)
        || operationId !== UNREADABLE_PLUGIN_JOURNAL_OPERATION_ID) throw error
      return decodePluginRecoveryDiagnostic({
        schemaVersion: 1,
        journalStatus: 'unreadable',
        operationId,
        profileName: null,
        action: null,
        pluginId: null,
        version: null,
        phaseHistory: [],
        terminalResult: 'recovery-failed',
        recoveryAttempt: 1,
        recoveryReasonCode: error.reasonCode,
        exportedAt: this.now().toISOString(),
      })
    }
    if (record === null || record.header.operationId !== operationId) {
      throw new Error('plugin recovery diagnostic operation is unavailable')
    }
    return decodePluginRecoveryDiagnostic({
      schemaVersion: 1,
      journalStatus: 'readable',
      operationId: record.header.operationId,
      profileName: record.header.profileIdentity.profileName,
      action: record.header.action,
      pluginId: record.header.pluginId,
      version: record.header.version,
      phaseHistory: record.phaseHistory,
      terminalResult: record.terminalResult,
      recoveryAttempt: record.recoveryAttempt,
      recoveryReasonCode: record.recoveryReasonCode,
      exportedAt: this.now().toISOString(),
    })
  }

  /** Ask Desktop for a destination, then return only basename/hash/size metadata. */
  async export(operationId: string, selectPath: PluginDiagnosticPathSelector): Promise<PluginDiagnosticExportResult> {
    const diagnostic = await this.create(operationId)
    const defaultFilename = `dsh-plugin-recovery-${operationId}.json`
    const path = await selectPath(defaultFilename)
    if (path === null) {
      return decodePluginDiagnosticExportResult({
        operationId,
        status: 'cancelled',
        filename: null,
        sha256: null,
        bytes: null,
      })
    }
    const content = `${JSON.stringify(diagnostic, null, 2)}\n`
    const bytes = Buffer.byteLength(content)
    await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
    return decodePluginDiagnosticExportResult({
      operationId,
      status: 'saved',
      filename: basename(path),
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes,
    })
  }
}
