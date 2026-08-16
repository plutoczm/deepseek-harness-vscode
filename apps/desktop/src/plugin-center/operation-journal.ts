/** Crash-durable version-2 transaction journal for Desktop Plugin Center mutations. */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  decodePluginTransactionJournalRecord,
  type PluginRecoveryReasonCode,
  type PluginTransactionJournalRecord,
} from '@deepseek-ai/dsh-plugin-center-contracts'

const MAX_JOURNAL_BYTES = 2 * 1024 * 1024
const MAX_ARCHIVED_JOURNALS = 20

/** Stable renderer identity used when a journal cannot be decoded without guessing its header. */
export const UNREADABLE_PLUGIN_JOURNAL_OPERATION_ID = 'unreadable-journal'

/** Shared v2 record name retained for existing Desktop imports. */
export type PluginOperationJournalRecord = PluginTransactionJournalRecord

/** Stable startup-facing classification for an unreadable durable record. */
export class PluginOperationJournalError extends Error {
  override readonly name = 'PluginOperationJournalError'

  constructor(
    readonly reasonCode: Extract<
      PluginRecoveryReasonCode,
      'unsupported-journal-version' | 'journal-invalid'
    >,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function requireDirectory(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new PluginOperationJournalError('journal-invalid', 'plugin operation journal directory is not trusted')
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function durableAtomicWrite(path: string, content: string): Promise<void> {
  const parent = dirname(path)
  await requireDirectory(parent)
  const current = await optionalLstat(path)
  if (current !== null && (!current.isFile() || current.isSymbolicLink())) {
    throw new PluginOperationJournalError('journal-invalid', 'plugin operation journal path is not a regular file')
  }
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
  await handle.close()
  try {
    await rename(temporary, path)
    await syncDirectory(parent)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function prefix(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return previous.length <= next.length && previous.every((entry, index) => same(entry, next[index]))
}

function assertInitialRecord(record: PluginOperationJournalRecord): void {
  const initial = record.phaseHistory[0]
  if (initial?.sequence !== 0 || initial.phase !== 'preflight' || initial.boundary !== 'observation'
    || initial.at !== record.header.startedAt || initial.operationFailureCode !== null
    || initial.recoveryReasonCode !== null || record.phaseHistory.length !== 1
    || record.operation.phase !== 'preflight' || record.priorFingerprint !== null
    || record.priorSnapshot !== null || record.commitMarker !== null || record.terminalResult !== null
    || record.recoveryAttempt !== 0 || record.recoveryReasonCode !== null) {
    throw new PluginOperationJournalError(
      'journal-invalid',
      'plugin operation journal must begin with one empty preflight observation',
    )
  }
}

function assertMonotonic(previous: PluginOperationJournalRecord, next: PluginOperationJournalRecord): void {
  if (!same(previous.header, next.header)) {
    throw new PluginOperationJournalError('journal-invalid', 'plugin operation journal header is immutable')
  }
  if (!prefix(previous.phaseHistory, next.phaseHistory)) {
    throw new PluginOperationJournalError('journal-invalid', 'plugin operation journal phase history is append-only')
  }
  if (previous.priorFingerprint !== null && !same(previous.priorFingerprint, next.priorFingerprint)) {
    throw new PluginOperationJournalError('journal-invalid', 'plugin operation prior fingerprint is immutable')
  }
  if (previous.priorSnapshot !== null && !same(previous.priorSnapshot, next.priorSnapshot)) {
    throw new PluginOperationJournalError('journal-invalid', 'plugin operation prior snapshot is immutable')
  }
  if (previous.commitMarker !== null && !same(previous.commitMarker, next.commitMarker)) {
    throw new PluginOperationJournalError('journal-invalid', 'plugin operation commit marker is immutable')
  }
  if (previous.terminalResult !== null && !same(previous, next)) {
    const retry = previous.terminalResult === 'recovery-failed'
      && next.terminalResult === null
      && next.recoveryReasonCode === null
      && next.operation.phase === 'recovery-stopping-host'
      && next.recoveryAttempt === previous.recoveryAttempt + 1
      && next.phaseHistory.length === previous.phaseHistory.length + 1
    if (!retry) {
      throw new PluginOperationJournalError('journal-invalid', 'plugin operation terminal record cannot reopen')
    }
  }
  if (next.recoveryAttempt < previous.recoveryAttempt
    || next.recoveryAttempt > previous.recoveryAttempt + 1) {
    throw new PluginOperationJournalError('journal-invalid', 'plugin operation recovery attempt must advance one at a time')
  }
}

function decodeStoredJournal(value: unknown): PluginOperationJournalRecord {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>)['schemaVersion'] !== 2) {
    throw new PluginOperationJournalError(
      'unsupported-journal-version',
      'plugin operation journal version is not supported',
    )
  }
  try {
    return decodePluginTransactionJournalRecord(value)
  } catch (error) {
    if (error instanceof PluginOperationJournalError) throw error
    throw new PluginOperationJournalError('journal-invalid', 'plugin operation journal failed validation', { cause: error })
  }
}

async function pruneTerminalHistory(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  const terminals: Array<{ filename: string; record: PluginOperationJournalRecord }> = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const filename = join(directory, entry.name)
    try {
      const metadata = await lstat(filename)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_JOURNAL_BYTES) continue
      const record = decodeStoredJournal(JSON.parse(await readFile(filename, 'utf8')) as unknown)
      if (`${record.header.operationId}.json` !== entry.name
        || (record.terminalResult !== 'committed' && record.terminalResult !== 'rolled-back')) continue
      terminals.push({ filename, record })
    } catch {
      // Retain malformed or suspicious artifacts for diagnosis; only verified closed records are pruned.
    }
  }
  terminals.sort((left, right) => {
    const byTime = Date.parse(right.record.operation.updatedAt) - Date.parse(left.record.operation.updatedAt)
    return byTime === 0
      ? right.record.header.operationId.localeCompare(left.record.header.operationId)
      : byTime
  })
  for (const terminal of terminals.slice(MAX_ARCHIVED_JOURNALS)) await unlink(terminal.filename)
  if (terminals.length > MAX_ARCHIVED_JOURNALS) await syncDirectory(directory)
}

/** Atomically publishes append-only operation state and refuses history rewrites. */
export class PluginOperationJournal {
  readonly filename: string

  constructor(private readonly directory: string) {
    this.filename = join(directory, 'operation.json')
  }

  /** Read one complete verified record; absence means no operation has ever started. */
  async read(): Promise<PluginOperationJournalRecord | null> {
    const metadata = await optionalLstat(this.filename)
    if (metadata === null) return null
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_JOURNAL_BYTES) {
      throw new PluginOperationJournalError('journal-invalid', 'plugin operation journal is not a bounded regular file')
    }
    let value: unknown
    try {
      value = JSON.parse(await readFile(this.filename, 'utf8')) as unknown
    } catch (error) {
      throw new PluginOperationJournalError('journal-invalid', 'plugin operation journal is not valid JSON', {
        cause: error,
      })
    }
    return decodeStoredJournal(value)
  }

  /** Durably publish the initial record or an append-only successor. */
  async write(value: PluginOperationJournalRecord): Promise<void> {
    const record = decodeStoredJournal(value)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await requireDirectory(this.directory)
    const previous = await this.read()
    if (previous === null) assertInitialRecord(record)
    else if (previous.header.operationId !== record.header.operationId) {
      if (previous.terminalResult !== 'committed' && previous.terminalResult !== 'rolled-back') {
        throw new PluginOperationJournalError('journal-invalid', 'an unsafe terminal record cannot be replaced')
      }
      assertInitialRecord(record)
      const historyDirectory = join(this.directory, 'history')
      await mkdir(historyDirectory, { recursive: true, mode: 0o700 })
      await requireDirectory(historyDirectory)
      await durableAtomicWrite(
        join(historyDirectory, `${previous.header.operationId}.json`),
        `${JSON.stringify(previous, null, 2)}\n`,
      )
      await pruneTerminalHistory(historyDirectory)
    } else assertMonotonic(previous, record)
    await durableAtomicWrite(this.filename, `${JSON.stringify(record, null, 2)}\n`)
  }
}
