/** Post-uninstall deletion of explicitly declared plugin-owned relative paths. */

import { mkdir, lstat, open, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import {
  decodePluginOwnedDataOffer,
  decodePluginOwnedDataRemovalRequest,
  decodePluginOwnedDataRemovalResult,
  decodePluginOwnedDataRetentionRequest,
  decodePluginOwnedDataRetentionResult,
  type InstalledPluginOwnedData,
  type PluginOwnedDataOffer,
  type PluginOwnedDataRemovalResult,
  type PluginOwnedDataRetentionResult,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import type { PluginOperationJournal } from './operation-journal.ts'

const STABLE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u

interface OwnedDataAuthorityRecord {
  readonly schemaVersion: 1
  readonly operationId: string
  readonly pluginId: string
  readonly packageName: string
  readonly version: string
  readonly declarations: readonly InstalledPluginOwnedData[]
}

function safeId(value: string, label: string): string {
  if (!STABLE_ID.test(value)) throw new Error(`${label} must be a stable lowercase id`)
  return value
}

function relativePath(value: string): string {
  if (value === '' || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/u.test(value)
    || value.includes('\\') || value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('owned-data declaration must be a portable relative path')
  }
  return value
}

function validateRecord(value: unknown): OwnedDataAuthorityRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('owned-data authority must be an object')
  }
  const source = value as Record<string, unknown>
  const keys = Object.keys(source).sort()
  const expected = ['declarations', 'operationId', 'packageName', 'pluginId', 'schemaVersion', 'version']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('owned-data authority has unknown or missing fields')
  }
  if (source['schemaVersion'] !== 1 || typeof source['operationId'] !== 'string'
    || typeof source['pluginId'] !== 'string' || typeof source['packageName'] !== 'string'
    || typeof source['version'] !== 'string' || !Array.isArray(source['declarations'])) {
    throw new Error('owned-data authority has invalid field types')
  }
  if (!PACKAGE_NAME.test(source['packageName'])) throw new Error('owned-data authority package name is invalid')
  if (!EXACT_VERSION.test(source['version'])) throw new Error('owned-data authority version is invalid')
  const declarations = source['declarations'].map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`owned-data declaration ${String(index)} must be an object`)
    }
    const declaration = value as Record<string, unknown>
    if (Object.keys(declaration).sort().join(',') !== 'label,path'
      || typeof declaration['path'] !== 'string' || typeof declaration['label'] !== 'string'
      || declaration['label'] === '' || declaration['label'].length > 120
      || declaration['label'].trim() !== declaration['label']) {
      throw new Error(`owned-data declaration ${String(index)} is invalid`)
    }
    return { path: relativePath(declaration['path']), label: declaration['label'] }
  })
  if (new Set(declarations.map(item => item.path)).size !== declarations.length) {
    throw new Error('owned-data authority contains duplicate paths')
  }
  return {
    schemaVersion: 1,
    operationId: safeId(source['operationId'], 'operation id'),
    pluginId: safeId(source['pluginId'], 'plugin id'),
    packageName: source['packageName'],
    version: source['version'],
    declarations,
  }
}

async function optionalMetadata(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try { return await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function requireRealDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory`)
}

/** Durable operation-owned declarations captured while the exact package still exists. */
export class PluginOwnedDataAuthorityStore {
  constructor(private readonly directory: string) {}

  /**
   * Persist declarations under the uninstall operation identity without overwriting drift.
   * @param input - Exact installed package declarations captured before mutation.
   * @returns After the authority record is durable.
   */
  async capture(input: Omit<OwnedDataAuthorityRecord, 'schemaVersion'>): Promise<void> {
    const record = validateRecord({ schemaVersion: 1, ...input })
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await requireRealDirectory(this.directory, 'owned-data authority directory')
    const path = join(this.directory, `${record.operationId}.json`)
    const content = `${JSON.stringify(record, null, 2)}\n`
    try {
      const handle = await open(path, 'wx', 0o600)
      try { await handle.writeFile(content) } finally { await handle.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await readFile(path, 'utf8') !== content) {
        throw new Error('owned-data authority operation id already belongs to different declarations')
      }
    }
  }

  /**
   * Read one previously validated authority record.
   * @param operationId - Uninstall operation that owns the declaration record.
   * @returns Exact declarations bound to that operation.
   */
  async read(operationId: string): Promise<OwnedDataAuthorityRecord> {
    safeId(operationId, 'operation id')
    await requireRealDirectory(this.directory, 'owned-data authority directory')
    const path = join(this.directory, `${operationId}.json`)
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('owned-data authority must be a regular file')
    return validateRecord(JSON.parse(await readFile(path, 'utf8')) as unknown)
  }

  /** Read a current authority when it still exists after an uninstall reload. */
  async optionalRead(operationId: string): Promise<OwnedDataAuthorityRecord | null> {
    try {
      return await this.read(operationId)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** Consume one validated offer after the user makes a final retain/remove decision. */
  async consume(operationId: string): Promise<void> {
    const record = await this.read(operationId)
    await rm(join(this.directory, `${record.operationId}.json`), { force: false })
  }
}

async function rejectSymlinks(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) throw new Error('owned-data deletion refuses symbolic links')
  if (!metadata.isDirectory()) return
  for (const entry of await readdir(path)) await rejectSymlinks(join(path, entry))
}

function overlapping(paths: readonly string[]): boolean {
  const ordered = [...paths].sort()
  return ordered.some((path, index) => ordered.slice(index + 1).some(next => next.startsWith(`${path}/`)))
}

/** Enforces committed-uninstall ownership and containment before any destructive write. */
export class PluginOwnedDataRemover {
  constructor(
    private readonly storageRoot: string,
    private readonly journal: PluginOperationJournal,
    private readonly authority: PluginOwnedDataAuthorityStore,
  ) {}

  private async committedAuthority(
    operationId: string,
    pluginId: string,
  ): Promise<OwnedDataAuthorityRecord> {
    const operation = await this.journal.read()
    if (operation === null || operation.operation.operationId !== operationId
      || operation.operation.action !== 'uninstall' || operation.operation.pluginId !== pluginId
      || operation.terminalResult !== 'committed' || operation.commitMarker === null) {
      throw new Error('owned-data decision requires the matching committed uninstall')
    }
    const authority = await this.authority.read(operationId)
    if (authority.pluginId !== pluginId || authority.version !== operation.operation.version) {
      throw new Error('owned-data authority does not match the committed uninstall')
    }
    return authority
  }

  /** Restore the current committed uninstall offer after the Host changes renderer origin. */
  async currentOffer(): Promise<PluginOwnedDataOffer | null> {
    const operation = await this.journal.read()
    if (operation === null || operation.operation.action !== 'uninstall'
      || operation.terminalResult !== 'committed' || operation.commitMarker === null) return null
    const authority = await this.authority.optionalRead(operation.operation.operationId)
    if (authority === null || authority.pluginId !== operation.operation.pluginId
      || authority.version !== operation.operation.version || authority.declarations.length === 0) return null
    return decodePluginOwnedDataOffer({
      operationId: authority.operationId,
      pluginId: authority.pluginId,
      packageName: authority.packageName,
      version: authority.version,
      declarations: authority.declarations,
    })
  }

  /** Persist the default retain decision by consuming only the operation authority metadata. */
  async retain(value: unknown): Promise<PluginOwnedDataRetentionResult> {
    const request = decodePluginOwnedDataRetentionRequest(value)
    await this.committedAuthority(request.operationId, request.pluginId)
    await this.authority.consume(request.operationId)
    return decodePluginOwnedDataRetentionResult({
      operationId: request.operationId,
      pluginId: request.pluginId,
      retained: true,
    })
  }

  /**
   * Delete only separately confirmed paths declared by the matching committed uninstall.
   * @param value - Renderer request decoded at the destructive Desktop process boundary.
   * @returns Bounded relative paths actually removed.
   */
  async remove(value: unknown): Promise<PluginOwnedDataRemovalResult> {
    const request = decodePluginOwnedDataRemovalRequest(value)
    if (request.paths.length === 0) throw new Error('owned-data deletion requires at least one selected path')
    const authority = await this.committedAuthority(request.operationId, request.pluginId)
    const allowed = new Set(authority.declarations.map(item => item.path))
    if (request.paths.some(path => !allowed.has(path)) || overlapping(request.paths)) {
      throw new Error('owned-data deletion contains undeclared or overlapping paths')
    }

    await mkdir(this.storageRoot, { recursive: true, mode: 0o700 })
    await requireRealDirectory(this.storageRoot, 'plugin storage root')
    const canonicalRoot = await realpath(this.storageRoot)
    const pluginRoot = join(canonicalRoot, request.pluginId)
    const pluginMetadata = await optionalMetadata(pluginRoot)
    if (pluginMetadata === null) {
      return decodePluginOwnedDataRemovalResult({
        operationId: request.operationId,
        pluginId: request.pluginId,
        removedPaths: [],
      })
    }
    if (!pluginMetadata.isDirectory() || pluginMetadata.isSymbolicLink()) {
      throw new Error('plugin-owned storage root must be a real directory')
    }

    const removedPaths: string[] = []
    for (const declared of request.paths) {
      const target = resolve(pluginRoot, ...declared.split('/'))
      const fromPlugin = relative(pluginRoot, target)
      if (fromPlugin === '..' || fromPlugin.startsWith('../') || fromPlugin.startsWith('..\\')) {
        throw new Error('owned-data path escaped the plugin storage root')
      }
      let parent = dirname(target)
      while (parent !== pluginRoot) {
        const metadata = await optionalMetadata(parent)
        if (metadata === null) break
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new Error('owned-data path has an unsafe parent')
        }
        parent = dirname(parent)
      }
      const metadata = await optionalMetadata(target)
      if (metadata === null) continue
      await rejectSymlinks(target)
      await rm(target, { recursive: metadata.isDirectory(), force: false })
      removedPaths.push(declared)
    }
    return decodePluginOwnedDataRemovalResult({
      operationId: request.operationId,
      pluginId: request.pluginId,
      removedPaths,
    })
  }
}
