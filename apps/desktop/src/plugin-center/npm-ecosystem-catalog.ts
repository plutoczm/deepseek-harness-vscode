/** Live npm-backed discovery for packages following the official dsh-plugin convention. */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Parser, type ReadEntry } from 'tar'
import {
  decodeCatalogMedia,
  decodeCatalogSnapshot,
  decodeCatalogSummary,
  decodeCatalogVersionPreflight,
  type CatalogCapability,
  type CatalogDetail,
  type CatalogDetailQuery,
  type CatalogDetailResult,
  type CatalogFreshness,
  type CatalogKind,
  type CatalogListQuery,
  type CatalogListResult,
  type CatalogMedia,
  type CatalogSnapshot,
  type CatalogSource,
  type CatalogSummary,
  type CatalogVersionPreflight,
  type CompatibilityRequest,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import { verifyPluginArtifact } from './artifact-verifier.ts'
import { CatalogCache } from './catalog-cache.ts'
import type {
  CatalogInstalledAuthority,
  CatalogPreflightSelection,
  PluginCatalogRepository,
} from './catalog-client.ts'

const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const NPM_SEARCH_URL = `${NPM_REGISTRY_ORIGIN}/-/v1/search`
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 10_000
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const SEARCH_CACHE_MS = 60_000
const DISCOVERY_CACHE_FRESH_MS = 24 * 60 * 60 * 1000
const MAX_DISCOVERY_CACHE_BYTES = 8 * 1024 * 1024
const MAX_DISCOVERY_CACHE_REFERENCES = 1_000
const SEARCH_PAGE_SIZE = 250
const MAX_SEARCH_INDEX_ENTRIES = 10_000
const COLD_START_ENTRY_LIMIT = 6
const COLD_START_BATCH_SIZE = 12
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u
const STABLE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u
const BRAND_COLOR = /^#[0-9A-Fa-f]{6}$/u
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u
const FALLBACK_BRAND_COLORS = [
  '#2563EB', '#7C3AED', '#DB2777', '#DC2626', '#EA580C', '#0F766E', '#0369A1', '#4F46E5',
] as const

interface NpmSearchSeed {
  readonly name: string
  readonly version: string
  readonly updatedAt: string
  readonly publisher: string
  readonly description: string
  readonly keywords: readonly string[]
}

interface NpmSearchPage {
  readonly total: number | undefined
  readonly objectCount: number
  readonly seeds: readonly NpmSearchSeed[]
}

interface NpmPackageReference {
  readonly pluginId: string
  readonly packageName: string
  readonly version: string
  readonly bundlePatch: string
  readonly hasClient: boolean
  readonly nodeRange: string
  readonly tarballUrl: string
  readonly integrity: string
  readonly summary: CatalogSummary
}

interface ArchiveInspection {
  readonly manifest: Record<string, unknown>
  readonly patch: string
  readonly entryCount: number
  readonly unpackedBytes: number
}

interface AuthorityState {
  readonly snapshot: CatalogSnapshot
  readonly source: CatalogSource
  readonly freshness: CatalogFreshness
}

interface AuthorityEntry {
  readonly detail: CatalogDetail
  readonly preflight: CatalogVersionPreflight
}

interface SearchCacheEntry {
  readonly expiresAt: number
  readonly result: CatalogListResult
}

interface SearchIndexCacheEntry {
  readonly expiresAt: number
  readonly seeds: readonly NpmSearchSeed[]
}

interface NpmDiscoveryDocument {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly seeds: readonly NpmSearchSeed[]
  readonly references: readonly NpmPackageReference[]
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  return value === undefined || value === null ? undefined : record(value, label)
}

function trimmedString(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value !== '' && value.trim() === value && value.length <= maximum
    ? value
    : undefined
}

function packageName(value: unknown): string {
  const decoded = trimmedString(value, 214)
  if (decoded === undefined || !PACKAGE_NAME.test(decoded)) throw new Error('npm package name is invalid')
  return decoded
}

function exactVersion(value: unknown): string {
  const decoded = trimmedString(value, 64)
  if (decoded === undefined || !EXACT_VERSION.test(decoded)) throw new Error('npm package version is invalid')
  return decoded
}

function canonicalInstant(value: unknown): string {
  const decoded = trimmedString(value, 80)
  if (decoded === undefined || !Number.isFinite(Date.parse(decoded))) throw new Error('npm publication date is invalid')
  return new Date(decoded).toISOString()
}

function stringList(value: unknown, maximum: number, itemMaximum: number): readonly string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    const decoded = trimmedString(item, itemMaximum)
    if (decoded === undefined || result.includes(decoded)) continue
    result.push(decoded)
    if (result.length === maximum) break
  }
  return result
}

function portableBundlePatch(value: unknown): string {
  const decoded = trimmedString(value, 256)
  if (decoded === undefined || decoded.startsWith('/') || decoded.startsWith('\\')
    || /^[A-Za-z]:/u.test(decoded) || decoded.includes('\\')) {
    throw new Error('dsh.bundle.patch must be a portable relative path')
  }
  const normalized = decoded.startsWith('./') ? decoded.slice(2) : decoded
  if (normalized === '' || normalized.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('dsh.bundle.patch must be a portable relative path')
  }
  return decoded
}

function npmPluginId(name: string): string {
  const normalized = name.replace(/^@/u, '').replace('/', '.').replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '').slice(0, 90) || 'package'
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 12)
  return `npm.${normalized}.${digest}`
}

function authorName(metadata: Record<string, unknown>, fallback: string): string {
  const author = metadata['author']
  if (typeof author === 'string') return trimmedString(author, 120) ?? fallback
  const authorRecord = optionalRecord(author, 'npm author')
  const namedAuthor = trimmedString(authorRecord?.['name'], 120)
  if (namedAuthor !== undefined) return namedAuthor
  const maintainers = metadata['maintainers']
  if (Array.isArray(maintainers) && maintainers.length > 0) {
    const maintainer = optionalRecord(maintainers[0], 'npm maintainer')
    return trimmedString(maintainer?.['name'], 120) ?? fallback
  }
  return fallback
}

function repositoryLocation(metadata: Record<string, unknown>): string | undefined {
  const repository = metadata['repository']
  if (typeof repository === 'string') return trimmedString(repository, 2048)
  if (typeof repository !== 'object' || repository === null || Array.isArray(repository)) return undefined
  return trimmedString((repository as Record<string, unknown>)['url'], 2048)
}

function githubOwner(metadata: Record<string, unknown>): string | undefined {
  const location = repositoryLocation(metadata)
  if (location === undefined) return undefined
  const shorthand = location.match(/^github:([^/]+)\/[^/]+$/u)?.[1]
  if (shorthand !== undefined) return GITHUB_OWNER.test(shorthand) ? shorthand : undefined
  const scp = location.match(/^git@github\.com:([^/]+)\/[^/]+$/u)?.[1]
  if (scp !== undefined) return GITHUB_OWNER.test(scp) ? scp : undefined
  let parsed: URL
  try {
    parsed = new URL(location.replace(/^git\+/u, ''))
  } catch {
    return undefined
  }
  if (parsed.hostname.toLocaleLowerCase() !== 'github.com') return undefined
  const owner = parsed.pathname.split('/').filter(Boolean)[0]
  return owner !== undefined && GITHUB_OWNER.test(owner) ? owner : undefined
}

function publisherAvatar(metadata: Record<string, unknown>, publisher: string): CatalogMedia | null {
  const owner = githubOwner(metadata)
  return owner === undefined ? null : decodeCatalogMedia({
    url: `https://avatars.githubusercontent.com/${owner}?s=128`,
    alt: `${publisher} publisher avatar`,
    width: 128,
    height: 128,
  })
}

function catalogIcon(
  pluginCenter: Record<string, unknown> | undefined,
  metadata: Record<string, unknown>,
  publisher: string,
): CatalogMedia | null {
  const declared = pluginCenter?.['icon']
  if (declared !== undefined && declared !== null) {
    try {
      return decodeCatalogMedia(declared)
    } catch {
      // Invalid optional artwork must not hide an otherwise valid Bundle.
    }
  }
  return publisherAvatar(metadata, publisher)
}

function catalogBrandColor(pluginCenter: Record<string, unknown> | undefined, packageName: string): string {
  const declared = pluginCenter?.['brandColor']
  if (typeof declared === 'string' && BRAND_COLOR.test(declared)) return declared
  const index = createHash('sha256').update(packageName).digest()[0] ?? 0
  return FALLBACK_BRAND_COLORS[index % FALLBACK_BRAND_COLORS.length] ?? FALLBACK_BRAND_COLORS[0]
}

function catalogKind(keywords: readonly string[], dsh: Record<string, unknown>): CatalogKind {
  const pluginCenter = optionalRecord(dsh['pluginCenter'], 'npm dsh.pluginCenter')
  const skillIds = stringList(pluginCenter?.['expectedSkillIds'], 64, 128)
  return skillIds.length > 0 || keywords.includes('dsh-skill-pack') ? 'skill-pack' : 'plugin'
}

function capabilities(keywords: readonly string[], hasClient: boolean): readonly CatalogCapability[] {
  const result: CatalogCapability[] = ['host']
  if (hasClient) result.push('client')
  if (keywords.some(keyword => ['skill', 'skills', 'agent-skill', 'dsh-skill-pack'].includes(keyword))) {
    result.push('skill')
  }
  return result
}

function summaryFor(reference: Omit<NpmPackageReference, 'summary'>, values: {
  readonly description: string
  readonly keywords: readonly string[]
  readonly publisher: string
  readonly updatedAt: string
  readonly icon: CatalogMedia | null
  readonly brandColor: string
}): CatalogSummary {
  const packageCapabilities = capabilities(values.keywords, reference.hasClient)
  return {
    pluginId: reference.pluginId,
    version: reference.version,
    catalogKind: catalogKind(values.keywords, { pluginCenter: undefined }),
    scope: 'public',
    displayName: reference.packageName,
    summary: values.description,
    publisher: values.publisher,
    verified: false,
    keywords: values.keywords,
    capabilities: packageCapabilities,
    icon: values.icon,
    brandColor: values.brandColor,
    compatibility: {
      status: 'unknown',
      reason: '安装前会下载确定版本并完成兼容性与产物校验。',
      platforms: ['darwin-arm64', 'win32-x64'],
    },
    updatedAt: values.updatedAt,
    installed: false,
  }
}

function exactKeys(source: Record<string, unknown>, label: string, expected: readonly string[]): void {
  const actual = Object.keys(source).sort()
  const keys = [...expected].sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} has unexpected fields`)
  }
}

function cachedString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || value.trim() !== value
    || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function cachedStringList(value: unknown, label: string, maximum: number, itemMaximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} is invalid`)
  const items = value.map((item, index) => cachedString(item, `${label}[${String(index)}]`, itemMaximum))
  if (new Set(items).size !== items.length) throw new Error(`${label} contains duplicates`)
  return items
}

function decodeDiscoverySeed(value: unknown, index: number): NpmSearchSeed {
  const label = `npm discovery seed ${String(index)}`
  const source = record(value, label)
  exactKeys(source, label, ['name', 'version', 'updatedAt', 'publisher', 'description', 'keywords'])
  return {
    name: packageName(source['name']),
    version: exactVersion(source['version']),
    updatedAt: canonicalInstant(source['updatedAt']),
    publisher: cachedString(source['publisher'], `${label}.publisher`, 120),
    description: cachedString(source['description'], `${label}.description`, 280, true),
    keywords: cachedStringList(source['keywords'], `${label}.keywords`, 64, 80),
  }
}

function decodeDiscoveryReference(value: unknown, index: number): NpmPackageReference {
  const label = `npm discovery reference ${String(index)}`
  const source = record(value, label)
  exactKeys(source, label, [
    'pluginId', 'packageName', 'version', 'bundlePatch', 'hasClient', 'nodeRange', 'tarballUrl', 'integrity', 'summary',
  ])
  const decodedPackageName = packageName(source['packageName'])
  const decodedVersion = exactVersion(source['version'])
  const pluginId = cachedString(source['pluginId'], `${label}.pluginId`, 128)
  const tarballUrl = cachedString(source['tarballUrl'], `${label}.tarballUrl`, 2048)
  const parsedTarball = new URL(tarballUrl)
  const integrity = cachedString(source['integrity'], `${label}.integrity`, 96)
  const summary = decodeCatalogSummary(source['summary'])
  if (pluginId !== npmPluginId(decodedPackageName) || !STABLE_ID.test(pluginId)
    || parsedTarball.protocol !== 'https:' || parsedTarball.origin !== NPM_REGISTRY_ORIGIN
    || !SHA512_INTEGRITY.test(integrity)
    || typeof source['hasClient'] !== 'boolean'
    || summary.pluginId !== pluginId || summary.version !== decodedVersion
    || summary.displayName !== decodedPackageName || summary.scope !== 'public'
    || summary.verified || summary.installed || summary.compatibility.status !== 'unknown') {
    throw new Error(`${label} identity is invalid`)
  }
  return {
    pluginId,
    packageName: decodedPackageName,
    version: decodedVersion,
    bundlePatch: portableBundlePatch(source['bundlePatch']),
    hasClient: source['hasClient'],
    nodeRange: cachedString(source['nodeRange'], `${label}.nodeRange`, 160),
    tarballUrl,
    integrity,
    summary,
  }
}

function decodeDiscoveryDocument(value: unknown): NpmDiscoveryDocument {
  const source = record(value, 'npm discovery cache')
  exactKeys(source, 'npm discovery cache', ['schemaVersion', 'generatedAt', 'seeds', 'references'])
  if (source['schemaVersion'] !== 1) throw new Error('npm discovery cache schema is unsupported')
  if (!Array.isArray(source['seeds']) || source['seeds'].length > MAX_SEARCH_INDEX_ENTRIES
    || !Array.isArray(source['references']) || source['references'].length > MAX_DISCOVERY_CACHE_REFERENCES) {
    throw new Error('npm discovery cache exceeds bounds')
  }
  const seeds = source['seeds'].map(decodeDiscoverySeed)
  const references = source['references'].map(decodeDiscoveryReference)
  const seedIdentities = new Set(seeds.map(seed => `${seed.name}@${seed.version}`))
  if (seedIdentities.size !== seeds.length
    || new Set(references.map(reference => `${reference.packageName}@${reference.version}`)).size !== references.length
    || references.some(reference => !seedIdentities.has(`${reference.packageName}@${reference.version}`))) {
    throw new Error('npm discovery cache identities are inconsistent')
  }
  return {
    schemaVersion: 1,
    generatedAt: canonicalInstant(source['generatedAt']),
    seeds,
    references,
  }
}

class NpmDiscoveryCache {
  private readonly file: string

  constructor(userDataDirectory: string) {
    this.file = join(userDataDirectory, 'plugin-center', 'npm-discovery-v1.json')
  }

  async read(): Promise<NpmDiscoveryDocument | undefined> {
    let source: string
    try {
      source = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (Buffer.byteLength(source, 'utf8') > MAX_DISCOVERY_CACHE_BYTES) return undefined
    try {
      return decodeDiscoveryDocument(JSON.parse(source) as unknown)
    } catch {
      return undefined
    }
  }

  async save(document: NpmDiscoveryDocument): Promise<void> {
    const decoded = decodeDiscoveryDocument(document)
    const serialized = `${JSON.stringify(decoded)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DISCOVERY_CACHE_BYTES) {
      throw new Error('npm discovery cache exceeds 8 MiB')
    }
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(serialized, 'utf8')
      await handle.sync()
      await handle.close()
      await rename(temporary, this.file)
    } catch (error) {
      await handle.close().catch(() => {})
      await rm(temporary, { force: true })
      throw error
    }
  }
}

function searchMatches(entry: CatalogSummary, query: string): boolean {
  if (query === '') return true
  const needle = query.toLocaleLowerCase()
  return [entry.displayName, entry.summary, entry.publisher, ...entry.keywords]
    .some(value => value.toLocaleLowerCase().includes(needle))
}

async function fetchJson(fetcher: typeof fetch, url: URL, label: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  try {
    const response = await fetcher(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`${label} returned HTTP ${String(response.status)}`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new Error(`${label} exceeds 2 MiB`)
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) throw new Error(`${label} exceeds 2 MiB`)
    return JSON.parse(text) as unknown
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchArtifact(fetcher: typeof fetch, rawUrl: string): Promise<Uint8Array> {
  const url = new URL(rawUrl)
  if (url.origin !== NPM_REGISTRY_ORIGIN || url.protocol !== 'https:' || url.username !== ''
    || url.password !== '' || url.hash !== '') {
    throw new Error('npm artifact URL is outside the fixed registry origin')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  try {
    const response = await fetcher(url, {
      headers: { accept: 'application/octet-stream' },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok || response.body === null) throw new Error(`npm artifact returned HTTP ${String(response.status)}`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) throw new Error('npm artifact exceeds 64 MiB')
    const chunks: Uint8Array[] = []
    let length = 0
    const reader = response.body.getReader()
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.byteLength
        if (length > MAX_ARTIFACT_BYTES) {
          await reader.cancel('artifact size limit exceeded')
          throw new Error('npm artifact exceeds 64 MiB')
        }
        chunks.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } finally {
    clearTimeout(timeout)
  }
}

function archiveMember(path: string): string {
  return `package/${path.startsWith('./') ? path.slice(2) : path}`
}

function inspectArchive(bytes: Uint8Array, bundlePatch: string): Promise<ArchiveInspection> {
  const manifestPath = 'package/package.json'
  const patchPath = archiveMember(bundlePatch)
  let manifestBytes: Buffer | undefined
  let patchBytes: Buffer | undefined
  let entryCount = 0
  let unpackedBytes = 0

  return new Promise((resolve, reject) => {
    const parser = new Parser({ strict: true, maxMetaEntrySize: 1024 * 1024, maxDecompressionRatio: 200 })
    parser.on('entry', (entry: ReadEntry) => {
      entryCount += 1
      unpackedBytes += entry.size
      if (entryCount > MAX_ARCHIVE_ENTRIES || unpackedBytes > MAX_UNPACKED_BYTES) {
        entry.resume()
        parser.abort(new Error('npm artifact exceeds archive inspection bounds'))
        return
      }
      const rawPath = entry.header.path ?? entry.path
      const normalized = rawPath.startsWith('./') ? rawPath.slice(2) : rawPath
      const limit = normalized === manifestPath ? 1024 * 1024 : normalized === patchPath ? MAX_CAPTURE_BYTES : 0
      if (limit === 0 || entry.type === 'Directory') {
        entry.resume()
        return
      }
      const chunks: Buffer[] = []
      let length = 0
      entry.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length <= limit) chunks.push(Buffer.from(chunk))
      })
      entry.on('end', () => {
        if (length > limit) {
          parser.abort(new Error('npm artifact metadata exceeds inspection bounds'))
          return
        }
        if (normalized === manifestPath) manifestBytes = Buffer.concat(chunks)
        else patchBytes = Buffer.concat(chunks)
      })
      entry.resume()
    })
    parser.once('error', (error: unknown) => { reject(error instanceof Error ? error : new Error(String(error))) })
    parser.once('end', () => {
      if (manifestBytes === undefined || patchBytes === undefined) {
        reject(new Error('npm artifact is missing its package manifest or Bundle patch'))
        return
      }
      try {
        resolve({
          manifest: record(JSON.parse(manifestBytes.toString('utf8')) as unknown, 'npm artifact package.json'),
          patch: patchBytes.toString('utf8'),
          entryCount,
          unpackedBytes,
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    parser.end(Buffer.from(bytes))
  })
}

function patchValues(patch: string, key: 'id' | 'name'): readonly string[] {
  const values = new Set<string>()
  const expression = key === 'id' ? /^\s*-\s+id:\s+(.+?)\s*$/u : /^\s+name:\s+(.+?)\s*$/u
  for (const line of patch.split(/\r?\n/u)) {
    const matched = line.match(expression)?.[1]?.trim()
    if (matched === undefined) continue
    const unquoted = ((matched.startsWith("'") && matched.endsWith("'"))
      || (matched.startsWith('"') && matched.endsWith('"'))) ? matched.slice(1, -1) : matched
    values.add(unquoted)
  }
  return [...values]
}

function searchPage(value: unknown): NpmSearchPage {
  const source = record(value, 'npm search response')
  const objects = source['objects']
  if (!Array.isArray(objects) || objects.length > SEARCH_PAGE_SIZE) {
    throw new Error('npm search response has invalid objects')
  }
  const rawTotal = source['total']
  let total: number | undefined
  if (rawTotal !== undefined) {
    if (typeof rawTotal !== 'number' || !Number.isSafeInteger(rawTotal)
      || rawTotal < objects.length || rawTotal > MAX_SEARCH_INDEX_ENTRIES) {
      throw new Error('npm search response has invalid total')
    }
    total = rawTotal
  }
  const seeds = objects.flatMap((item, index) => {
    try {
      const packageValue = record(record(item, `npm search object ${String(index)}`)['package'], 'npm search package')
      const keywords = stringList(packageValue['keywords'], 64, 80)
      if (!keywords.includes('dsh-plugin')) return []
      const publisherValue = optionalRecord(packageValue['publisher'], 'npm search publisher')
      return [{
        name: packageName(packageValue['name']),
        version: exactVersion(packageValue['version']),
        updatedAt: canonicalInstant(packageValue['date']),
        publisher: trimmedString(publisherValue?.['username'], 120) ?? 'npm publisher',
        description: trimmedString(packageValue['description'], 280) ?? '',
        keywords,
      }]
    } catch {
      return []
    }
  })
  return { total, objectCount: objects.length, seeds }
}

function seedMatchRank(seed: NpmSearchSeed, query: string): number | undefined {
  if (query === '') return 0
  const needle = query.toLocaleLowerCase()
  const name = seed.name.toLocaleLowerCase()
  if (name === needle) return 0
  if (name.startsWith(needle)) return 1
  if (name.includes(needle)) return 2
  const keywords = seed.keywords.map(keyword => keyword.toLocaleLowerCase())
  if (keywords.includes(needle)) return 3
  if (seed.publisher.toLocaleLowerCase().includes(needle)) return 4
  if (seed.description.toLocaleLowerCase().includes(needle)) return 5
  if (keywords.some(keyword => keyword.includes(needle))) return 6
  return undefined
}

function matchingSeeds(seeds: readonly NpmSearchSeed[], query: string, kind: CatalogKind): readonly NpmSearchSeed[] {
  const matches: Array<{ readonly seed: NpmSearchSeed; readonly rank: number; readonly index: number }> = []
  for (const [index, seed] of seeds.entries()) {
    const rank = seedMatchRank(seed, query)
    if (rank !== undefined) matches.push({ seed, rank, index })
  }
  matches.sort((left, right) => left.rank - right.rank || left.index - right.index)
  if (query !== '' || kind === 'plugin') return matches.map(match => match.seed)
  const skillKeywords = new Set(['skill', 'skills', 'agent-skill', 'dsh-skill-pack'])
  const preferred: NpmSearchSeed[] = []
  const remaining: NpmSearchSeed[] = []
  for (const match of matches) {
    const target = match.seed.keywords.some(keyword => skillKeywords.has(keyword)) ? preferred : remaining
    target.push(match.seed)
  }
  return [...preferred, ...remaining]
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  project: (value: T) => Promise<U>,
): Promise<readonly U[]> {
  const output: U[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= values.length) return
      output[index] = await project(values[index] as T)
    }
  })
  await Promise.all(workers)
  return output
}

function sectioned(entries: readonly CatalogSummary[], query: string): CatalogListResult['sections'] {
  if (query !== '') return { featured: entries, popular: [], recent: [] }
  return {
    featured: entries.slice(0, 6),
    popular: entries.slice(6, 18),
    recent: entries.slice(18),
  }
}

function snapshotEntries(snapshot: CatalogSnapshot): readonly AuthorityEntry[] {
  return snapshot.preflights.flatMap((preflight) => {
    const detail = snapshot.details.find(value => value.summary.pluginId === preflight.pluginId
      && value.summary.version === preflight.version)
    return detail === undefined ? [] : [{ detail, preflight }]
  })
}

function createSnapshot(entries: readonly AuthorityEntry[], generatedAt: string): CatalogSnapshot {
  const exact = new Map(entries.map(entry => [
    `${entry.preflight.pluginId}@${entry.preflight.version}`,
    entry,
  ]))
  const retained = [...exact.values()].sort((left, right) =>
    right.detail.summary.updatedAt.localeCompare(left.detail.summary.updatedAt)).slice(0, 100)
  const identity = retained.map(entry => ({
    pluginId: entry.preflight.pluginId,
    version: entry.preflight.version,
    packageName: entry.preflight.packageName,
    integrity: entry.preflight.artifacts[0]?.integrity ?? '',
  }))
  const etag = `npm-ecosystem-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`
  const preflights = retained.map(entry => ({ ...entry.preflight, catalogEtag: etag }))
  const summaries = retained.map(entry => entry.detail.summary)
  const ids = [...new Set(summaries.map(summary => summary.pluginId))]
  return decodeCatalogSnapshot({
    schemaVersion: 1,
    etag,
    generatedAt,
    maxAgeSeconds: 86_400,
    sections: {
      featured: ids.slice(0, 6),
      popular: ids.slice(6, 66),
      recent: ids.slice(66),
    },
    entries: summaries,
    details: retained.map(entry => entry.detail),
    preflights,
  })
}

/** Search npm's public dsh-plugin index and publish only exact validated DSH Bundles. */
export class NpmEcosystemCatalogRepository implements PluginCatalogRepository {
  private authorityState: AuthorityState | undefined
  private authorityLoading: Promise<AuthorityState> | undefined
  private readonly packageReferences = new Map<string, NpmPackageReference>()
  private readonly referenceLoads = new Map<string, Promise<NpmPackageReference | null>>()
  private searchIndexCache: SearchIndexCacheEntry | undefined
  private searchIndexLoading: Promise<readonly NpmSearchSeed[]> | undefined
  private discoveryDocument: NpmDiscoveryDocument | null | undefined
  private discoveryLoading: Promise<NpmDiscoveryDocument | null> | undefined
  private discoveryWrites: Promise<void> = Promise.resolve()
  private readonly searchCache = new Map<string, SearchCacheEntry>()
  private readonly searches = new Map<string, Promise<CatalogListResult>>()
  private readonly networkSearches = new Map<string, Promise<CatalogListResult>>()
  private readonly hydrations = new Map<string, Promise<AuthorityEntry>>()
  private publicationGate: Promise<void> = Promise.resolve()
  private readonly discoveryCache: NpmDiscoveryCache | undefined

  constructor(
    private readonly cache: CatalogCache,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    discoveryDirectory?: string,
  ) {
    this.discoveryCache = discoveryDirectory === undefined ? undefined : new NpmDiscoveryCache(discoveryDirectory)
  }

  private currentAuthority(): Promise<AuthorityState> {
    this.authorityLoading ??= this.cache.read().catch(() => undefined).then((cached) => {
      const validEntries = cached === undefined ? [] : snapshotEntries(cached).filter(entry =>
        entry.preflight.pluginId.startsWith('npm.')
        && entry.preflight.artifacts.length > 0
        && entry.preflight.artifacts.every(artifact => new URL(artifact.url).origin === NPM_REGISTRY_ORIGIN))
      const snapshot = createSnapshot(validEntries, new Date(this.now()).toISOString())
      const state: AuthorityState = {
        snapshot,
        source: validEntries.length === 0 ? 'bundled' : 'cache',
        freshness: validEntries.length === 0 ? 'stale' : 'cached',
      }
      this.authorityState = state
      return state
    })
    return this.authorityState === undefined ? this.authorityLoading : Promise.resolve(this.authorityState)
  }

  private currentDiscovery(): Promise<NpmDiscoveryDocument | null> {
    if (this.discoveryDocument !== undefined) return Promise.resolve(this.discoveryDocument)
    if (this.discoveryLoading !== undefined) return this.discoveryLoading
    const loading = (this.discoveryCache?.read() ?? Promise.resolve(undefined)).catch(() => undefined).then((cached) => {
      const document = cached ?? null
      if (document !== null) {
        for (const reference of document.references) {
          this.packageReferences.set(`${reference.pluginId}@${reference.version}`, reference)
        }
      }
      this.discoveryDocument = document
      return document
    }).finally(() => { this.discoveryLoading = undefined })
    this.discoveryLoading = loading
    return loading
  }

  private async persistDiscovery(seeds: readonly NpmSearchSeed[], generatedAt: string): Promise<void> {
    const previous = await this.currentDiscovery()
    const previousWins = previous !== null && (previous.generatedAt > generatedAt
      || (previous.generatedAt === generatedAt && previous.seeds.length > seeds.length))
    const retainedSeeds = previousWins ? previous.seeds : seeds
    const seedIdentities = new Set(retainedSeeds.map(seed => `${seed.name}@${seed.version}`))
    const references = [...this.packageReferences.values()]
      .filter(reference => seedIdentities.has(`${reference.packageName}@${reference.version}`))
      .slice(-MAX_DISCOVERY_CACHE_REFERENCES)
    const document = decodeDiscoveryDocument({
      schemaVersion: 1,
      generatedAt: previousWins ? previous.generatedAt : generatedAt,
      seeds: retainedSeeds,
      references,
    })
    this.discoveryDocument = document
    if (this.discoveryCache === undefined) return
    this.discoveryWrites = this.discoveryWrites.then(
      () => this.discoveryCache?.save(document),
      () => this.discoveryCache?.save(document),
    ).then(() => undefined, () => undefined)
    await this.discoveryWrites
  }

  private async cachedDiscoveryResult(
    query: CatalogListQuery,
    document: NpmDiscoveryDocument,
  ): Promise<CatalogListResult | null> {
    const references = matchingSeeds(document.seeds, query.query.trim(), query.catalogKind).flatMap((seed) => {
      const reference = this.packageReferences.get(`${npmPluginId(seed.name)}@${seed.version}`)
      return reference === undefined || reference.summary.catalogKind !== query.catalogKind ? [] : [reference]
    }).slice(0, query.limit)
    if (references.length === 0) return null
    const authority = await this.currentAuthority()
    const verified = new Map(authority.snapshot.entries.map(entry => [`${entry.pluginId}@${entry.version}`, entry]))
    const entries = references.map(reference =>
      verified.get(`${reference.pluginId}@${reference.version}`) ?? reference.summary)
    const etag = `npm-discovery-${createHash('sha256').update(JSON.stringify(entries.map(entry =>
      [entry.pluginId, entry.version]))).digest('hex').slice(0, 24)}`
    return {
      etag,
      generatedAt: document.generatedAt,
      freshness: this.now() - Date.parse(document.generatedAt) <= DISCOVERY_CACHE_FRESH_MS ? 'cached' : 'stale',
      source: 'cache',
      sections: sectioned(entries, query.query.trim()),
    }
  }

  private async decodeReference(seed: NpmSearchSeed): Promise<NpmPackageReference> {
    const url = new URL(`${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(seed.name)}/${encodeURIComponent(seed.version)}`)
    const metadata = record(await fetchJson(this.fetcher, url, `${seed.name}@${seed.version}`), 'npm version metadata')
    const decodedName = packageName(metadata['name'])
    const decodedVersion = exactVersion(metadata['version'])
    if (decodedName !== seed.name || decodedVersion !== seed.version) throw new Error('npm exact metadata identity changed')
    const keywords = stringList(metadata['keywords'], 24, 48)
    if (!keywords.includes('dsh-plugin')) throw new Error('npm exact version is not tagged dsh-plugin')
    const dsh = record(metadata['dsh'], 'npm dsh manifest')
    const bundle = record(dsh['bundle'], 'npm dsh.bundle manifest')
    const pluginCenter = optionalRecord(dsh['pluginCenter'], 'npm dsh.pluginCenter manifest')
    const bundlePatch = portableBundlePatch(bundle['patch'])
    const client = optionalRecord(dsh['client'], 'npm dsh.client manifest')
    const dist = record(metadata['dist'], 'npm dist metadata')
    const tarballUrl = trimmedString(dist['tarball'], 2048)
    const integrity = trimmedString(dist['integrity'], 96)
    if (tarballUrl === undefined || integrity === undefined || !SHA512_INTEGRITY.test(integrity)) {
      throw new Error('npm exact version lacks immutable distribution evidence')
    }
    const parsedTarball = new URL(tarballUrl)
    if (parsedTarball.origin !== NPM_REGISTRY_ORIGIN || parsedTarball.protocol !== 'https:') {
      throw new Error('npm tarball is outside the fixed registry origin')
    }
    const description = trimmedString(metadata['description'], 280) ?? `DeepSeek Harness Bundle ${decodedName}`
    const publisher = authorName(metadata, seed.publisher)
    const engines = optionalRecord(metadata['engines'], 'npm engines')
    const nodeRange = trimmedString(engines?.['node'], 160) ?? '>=22.19 <25'
    const base = {
      pluginId: npmPluginId(decodedName),
      packageName: decodedName,
      version: decodedVersion,
      bundlePatch,
      hasClient: client !== undefined,
      nodeRange,
      tarballUrl,
      integrity,
    } as const
    return {
      ...base,
      summary: {
        ...summaryFor(base, {
          description,
          keywords,
          publisher,
          updatedAt: seed.updatedAt,
          icon: catalogIcon(pluginCenter, metadata, publisher),
          brandColor: catalogBrandColor(pluginCenter, decodedName),
        }),
        catalogKind: catalogKind(keywords, dsh),
      },
    }
  }

  private loadReference(seed: NpmSearchSeed): Promise<NpmPackageReference | null> {
    const pluginId = npmPluginId(seed.name)
    const existing = this.packageReferences.get(`${pluginId}@${seed.version}`)
    if (existing !== undefined) return Promise.resolve(existing)
    const key = `${seed.name}@${seed.version}`
    const running = this.referenceLoads.get(key)
    if (running !== undefined) return running
    const loading = this.decodeReference(seed).then(
      (reference) => {
        this.packageReferences.set(`${reference.pluginId}@${reference.version}`, reference)
        return reference
      },
      () => null,
    )
    this.referenceLoads.set(key, loading)
    return loading
  }

  private async fetchSearchPage(from: number): Promise<NpmSearchPage> {
    const url = new URL(NPM_SEARCH_URL)
    url.searchParams.set('text', 'keywords:dsh-plugin')
    url.searchParams.set('size', String(SEARCH_PAGE_SIZE))
    url.searchParams.set('from', String(from))
    return searchPage(await fetchJson(this.fetcher, url, 'npm dsh-plugin search'))
  }

  private async fetchSearchIndex(): Promise<readonly NpmSearchSeed[]> {
    const first = await this.fetchSearchPage(0)
    const pages: NpmSearchPage[] = [first]
    if (first.objectCount === SEARCH_PAGE_SIZE) {
      if (first.total === undefined) {
        for (let from = SEARCH_PAGE_SIZE; from < MAX_SEARCH_INDEX_ENTRIES; from += SEARCH_PAGE_SIZE) {
          const page = await this.fetchSearchPage(from)
          pages.push(page)
          if (page.objectCount < SEARCH_PAGE_SIZE) break
        }
      } else {
        const offsets = Array.from(
          { length: Math.ceil(first.total / SEARCH_PAGE_SIZE) - 1 },
          (_, index) => (index + 1) * SEARCH_PAGE_SIZE,
        )
        pages.push(...await mapConcurrent(offsets, 4, from => this.fetchSearchPage(from)))
      }
    }
    const unique = new Map<string, NpmSearchSeed>()
    for (const page of pages) {
      for (const seed of page.seeds) unique.set(`${seed.name}@${seed.version}`, seed)
    }
    return [...unique.values()]
  }

  private searchIndex(force = false): Promise<readonly NpmSearchSeed[]> {
    if (!force && this.searchIndexCache !== undefined && this.searchIndexCache.expiresAt > this.now()) {
      return Promise.resolve(this.searchIndexCache.seeds)
    }
    if (this.searchIndexLoading !== undefined) return this.searchIndexLoading
    const loading = this.fetchSearchIndex().then((seeds) => {
      this.searchIndexCache = { expiresAt: this.now() + SEARCH_CACHE_MS, seeds }
      return seeds
    }).finally(() => { this.searchIndexLoading = undefined })
    this.searchIndexLoading = loading
    return loading
  }

  private async referencesFor(
    seeds: readonly NpmSearchSeed[],
    kind: CatalogKind,
    limit: number,
    batchSize: number,
  ): Promise<readonly NpmPackageReference[]> {
    const references: NpmPackageReference[] = []
    for (let from = 0; from < seeds.length && references.length < limit; from += batchSize) {
      const batch = await mapConcurrent(seeds.slice(from, from + batchSize), 8,
        seed => this.loadReference(seed))
      references.push(...batch.filter((value): value is NpmPackageReference =>
        value !== null && value.summary.catalogKind === kind))
    }
    return references.slice(0, limit)
  }

  private async resultForSeeds(
    query: CatalogListQuery,
    seeds: readonly NpmSearchSeed[],
    limit: number,
    batchSize: number,
    generatedAt: string,
  ): Promise<CatalogListResult> {
    const searchQuery = query.query.trim()
    const matched = matchingSeeds(seeds, searchQuery, query.catalogKind)
    const references = await this.referencesFor(matched, query.catalogKind, limit, batchSize)
    const authority = await this.currentAuthority()
    const verified = new Map(authority.snapshot.entries.map(entry => [
      `${entry.pluginId}@${entry.version}`,
      entry,
    ]))
    const entries = references.map(reference =>
      verified.get(`${reference.pluginId}@${reference.version}`) ?? reference.summary)
      .slice(0, limit)
    const etag = `npm-search-${createHash('sha256').update(JSON.stringify(entries.map(entry =>
      [entry.pluginId, entry.version]))).digest('hex').slice(0, 24)}`
    return {
      etag,
      generatedAt,
      freshness: 'fresh',
      source: 'network',
      sections: sectioned(entries, searchQuery),
    }
  }

  private async searchNetwork(query: CatalogListQuery, forceIndex = false): Promise<CatalogListResult> {
    const seeds = await this.searchIndex(forceIndex)
    const generatedAt = new Date(this.now()).toISOString()
    const result = await this.resultForSeeds(
      query,
      seeds,
      query.limit,
      Math.min(SEARCH_PAGE_SIZE, Math.max(query.limit * 2, 24)),
      generatedAt,
    )
    await this.persistDiscovery(seeds, generatedAt).catch(() => {})
    return result
  }

  private async coldStartNetwork(query: CatalogListQuery): Promise<CatalogListResult> {
    const first = await this.fetchSearchPage(0)
    const generatedAt = new Date(this.now()).toISOString()
    const result = await this.resultForSeeds(
      query,
      first.seeds,
      Math.min(query.limit, COLD_START_ENTRY_LIMIT),
      COLD_START_BATCH_SIZE,
      generatedAt,
    )
    await this.persistDiscovery(first.seeds, generatedAt).catch(() => {})
    return result
  }

  private async searchKnownIndex(
    query: CatalogListQuery,
    document: NpmDiscoveryDocument,
  ): Promise<CatalogListResult> {
    const cold = query.query.trim() === '' && query.catalogKind === 'plugin'
    const generatedAt = new Date(this.now()).toISOString()
    const result = await this.resultForSeeds(
      query,
      document.seeds,
      cold ? Math.min(query.limit, COLD_START_ENTRY_LIMIT) : query.limit,
      cold ? COLD_START_BATCH_SIZE : Math.min(SEARCH_PAGE_SIZE, Math.max(query.limit * 2, 24)),
      generatedAt,
    )
    await this.persistDiscovery(document.seeds, generatedAt).catch(() => {})
    return result
  }

  private async fallback(query: CatalogListQuery): Promise<CatalogListResult> {
    const state = await this.currentAuthority()
    const entries = state.snapshot.entries.filter(entry =>
      entry.catalogKind === query.catalogKind
      && entry.scope === query.scope
      && searchMatches(entry, query.query.trim())).slice(0, query.limit)
    return {
      etag: state.snapshot.etag,
      generatedAt: state.snapshot.generatedAt,
      freshness: 'stale',
      source: state.source,
      sections: sectioned(entries, query.query.trim()),
    }
  }

  private async recoverList(query: CatalogListQuery): Promise<CatalogListResult> {
    const document = await this.currentDiscovery()
    if (document !== null) {
      const cached = await this.cachedDiscoveryResult(query, document)
      if (cached !== null) return cached
    }
    return await this.fallback(query)
  }

  private networkSearch(query: CatalogListQuery, forceIndex: boolean): Promise<CatalogListResult> {
    const key = JSON.stringify(query)
    const running = this.networkSearches.get(key)
    if (running !== undefined) return running
    const search = this.searchNetwork(query, forceIndex).catch(() => this.recoverList(query)).then((result) => {
      this.searchCache.set(key, { expiresAt: this.now() + SEARCH_CACHE_MS, result })
      return result
    }).finally(() => { this.networkSearches.delete(key) })
    this.networkSearches.set(key, search)
    return search
  }

  private async listUncached(query: CatalogListQuery): Promise<CatalogListResult> {
    const document = await this.currentDiscovery()
    if (document !== null) {
      const cached = await this.cachedDiscoveryResult(query, document)
      if (cached !== null) return cached
      return await this.searchKnownIndex(query, document).catch(() => this.recoverList(query))
    }
    if (query.query.trim() === '' && query.catalogKind === 'plugin') {
      return await this.coldStartNetwork(query).catch(() => this.recoverList(query))
    }
    return await this.networkSearch(query, false)
  }

  async list(query: CatalogListQuery): Promise<CatalogListResult> {
    if (query.scope === 'local') return await this.fallback(query)
    const key = JSON.stringify(query)
    const cached = this.searchCache.get(key)
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.result
    const running = this.searches.get(key)
    if (running !== undefined) return await running
    const search = this.listUncached(query).then((result) => {
      this.searchCache.set(key, { expiresAt: this.now() + SEARCH_CACHE_MS, result })
      return result
    }).finally(() => { this.searches.delete(key) })
    this.searches.set(key, search)
    return await search
  }

  async refresh(query: CatalogListQuery): Promise<CatalogListResult> {
    if (query.scope === 'local') return await this.fallback(query)
    return await this.networkSearch(query, true)
  }

  private async hydrate(reference: NpmPackageReference): Promise<AuthorityEntry> {
    const key = `${reference.pluginId}@${reference.version}`
    const state = await this.currentAuthority()
    const retained = snapshotEntries(state.snapshot).find(entry =>
      entry.preflight.pluginId === reference.pluginId && entry.preflight.version === reference.version)
    if (retained !== undefined) return retained
    const running = this.hydrations.get(key)
    if (running !== undefined) return await running
    const hydration = this.createAuthority(reference).finally(() => { this.hydrations.delete(key) })
    this.hydrations.set(key, hydration)
    return await hydration
  }

  private async createAuthority(reference: NpmPackageReference): Promise<AuthorityEntry> {
    const bytes = await fetchArtifact(this.fetcher, reference.tarballUrl)
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    if (integrity !== reference.integrity) throw new Error('npm tarball does not match its registry integrity')
    const inspection = await inspectArchive(bytes, reference.bundlePatch)
    if (inspection.manifest['name'] !== reference.packageName
      || inspection.manifest['version'] !== reference.version) {
      throw new Error('npm tarball package identity differs from exact metadata')
    }
    const dsh = record(inspection.manifest['dsh'], 'npm artifact dsh manifest')
    const bundle = record(dsh['bundle'], 'npm artifact dsh.bundle manifest')
    if (bundle['patch'] !== reference.bundlePatch) throw new Error('npm tarball Bundle declaration changed')
    const entryIds = patchValues(inspection.patch, 'id')
    if (entryIds.length === 0 || entryIds.some(entryId => !STABLE_ID.test(entryId))) {
      throw new Error('npm Bundle has no stable Loader entry evidence')
    }
    const moduleNames = patchValues(inspection.patch, 'name')
    const client = optionalRecord(dsh['client'], 'npm artifact dsh.client manifest')
    if ((client !== undefined) !== reference.hasClient) throw new Error('npm tarball client declaration changed')
    const expectedClientModules = reference.hasClient ? [reference.packageName] : []
    if (expectedClientModules.some(moduleName => !moduleNames.includes(moduleName))) {
      throw new Error('npm Bundle does not mount its declared client module')
    }
    const pluginCenter = optionalRecord(dsh['pluginCenter'], 'npm artifact dsh.pluginCenter manifest')
    const expectedSkillIds = stringList(pluginCenter?.['expectedSkillIds'], 64, 128)
    if (expectedSkillIds.some(skillId => !STABLE_ID.test(skillId))) {
      throw new Error('npm Bundle declares an invalid Skill identity')
    }
    const verifiedSummary: CatalogSummary = {
      ...reference.summary,
      verified: true,
      compatibility: {
        ...reference.summary.compatibility,
        reason: '确定版本的 npm 完整性、包身份与 Bundle 激活声明已校验；安装前仍会核对本机环境。',
      },
    }
    const riskSummary = '这是社区发布的 DSH Bundle，产物身份已经校验，但代码未经过 DeepSeek 官方安全审计，运行时拥有应用进程权限。'
    const candidate = decodeCatalogVersionPreflight({
      pluginId: reference.pluginId,
      version: reference.version,
      packageName: reference.packageName,
      catalogEtag: 'npm-pending',
      reviewed: true,
      eligible: true,
      withdrawn: false,
      desktopRange: '>=0.1.0-rc.1 <0.2.0',
      dshRange: '>=0.1.0-rc.1 <0.2.0',
      nodeRange: reference.nodeRange,
      artifacts: (['darwin-arm64', 'win32-x64'] as const).map(platform => ({
        platform,
        url: reference.tarballUrl,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        integrity,
        packedBytes: bytes.byteLength,
        unpackedBytes: inspection.unpackedBytes,
        fileCount: inspection.entryCount,
      })),
      bundlePatch: reference.bundlePatch,
      capabilities: verifiedSummary.capabilities,
      riskLevel: 'high',
      riskSummary,
      executionAuthority: 'broad-application-authority',
      conflicts: { pluginIds: [], packageNames: [], entryIds: [] },
      expectedEntries: entryIds,
      expectedClientModules,
      expectedSkillIds,
      supportedActions: ['install', 'update', 'enable', 'disable', 'uninstall'],
      restartRequired: true,
    })
    const verification = await verifyPluginArtifact({ bytes, candidate, platform: 'darwin-arm64' })
    if (!verification.verified) throw new Error('npm Bundle failed non-executing artifact verification')
    const detail: CatalogDetail = {
      summary: verifiedSummary,
      description: reference.summary.summary,
      screenshots: [],
      permissions: [
        '安装后向当前 DeepSeek Harness Profile 注册 Bundle 条目。',
        '插件代码会随 Harness Host 运行，并可获得应用进程权限。',
      ],
      riskLevel: 'high',
      riskSummary,
      changelog: `npm 确定版本 ${reference.version}。`,
      publishedAt: reference.summary.updatedAt,
      expectedEntries: entryIds,
      expectedClientModules,
      expectedSkillIds,
      eligible: true,
      withdrawn: false,
    }
    let release!: () => void
    const previous = this.publicationGate
    this.publicationGate = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const current = await this.currentAuthority()
      const nextSnapshot = createSnapshot([
        ...snapshotEntries(current.snapshot),
        { detail, preflight: candidate },
      ], new Date(this.now()).toISOString())
      await this.cache.save(nextSnapshot)
      const next: AuthorityState = { snapshot: nextSnapshot, source: 'network', freshness: 'fresh' }
      this.authorityState = next
      const retainedPreflight = nextSnapshot.preflights.find(value => value.pluginId === reference.pluginId
        && value.version === reference.version)
      if (retainedPreflight === undefined) throw new Error('validated npm Bundle was not retained in catalog authority')
      return { detail, preflight: retainedPreflight }
    } finally {
      release()
    }
  }

  async detail(query: CatalogDetailQuery): Promise<CatalogDetailResult> {
    const current = await this.currentAuthority()
    const cached = current.snapshot.details.find(item => item.summary.pluginId === query.pluginId
      && item.summary.version === query.version)
    if (cached !== undefined) {
      return {
        etag: current.snapshot.etag,
        generatedAt: current.snapshot.generatedAt,
        freshness: current.freshness,
        source: current.source,
        detail: cached,
      }
    }
    const reference = this.packageReferences.get(`${query.pluginId}@${query.version}`)
    if (reference === undefined) {
      return {
        etag: current.snapshot.etag,
        generatedAt: current.snapshot.generatedAt,
        freshness: current.freshness,
        source: current.source,
        detail: null,
      }
    }
    const entry = await this.hydrate(reference)
    const state = await this.currentAuthority()
    return {
      etag: state.snapshot.etag,
      generatedAt: state.snapshot.generatedAt,
      freshness: state.freshness,
      source: state.source,
      detail: entry.detail,
    }
  }

  async resolvePreflight(request: CompatibilityRequest): Promise<CatalogPreflightSelection> {
    let state = await this.currentAuthority()
    let candidate = state.snapshot.preflights.find(item => item.pluginId === request.pluginId
      && item.version === request.version) ?? null
    if (candidate === null) {
      const reference = this.packageReferences.get(`${request.pluginId}@${request.version}`)
      if (reference !== undefined) {
        try {
          await this.hydrate(reference)
          state = await this.currentAuthority()
          candidate = state.snapshot.preflights.find(item => item.pluginId === request.pluginId
            && item.version === request.version) ?? null
        } catch {
          candidate = null
        }
      }
    }
    return {
      candidate,
      candidates: state.snapshot.preflights,
      etag: state.snapshot.etag,
      freshness: state.freshness,
    }
  }

  async installedAuthority(): Promise<CatalogInstalledAuthority> {
    const state = await this.currentAuthority()
    return {
      etag: state.snapshot.etag,
      freshness: state.freshness,
      entries: state.snapshot.entries,
      details: state.snapshot.details,
      preflights: state.snapshot.preflights,
    }
  }
}
