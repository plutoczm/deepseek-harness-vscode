/** Inspect one catalog-bound package archive without extracting or executing plugin code. */

import { createHash } from 'node:crypto'
import { Parser, type ReadEntry } from 'tar'
import {
  ARTIFACT_VERIFICATION_REASON_ORDER,
  decodeArtifactVerificationResult,
  type ArtifactVerificationReason,
  type ArtifactVerificationReasonCode,
  type ArtifactVerificationResult,
  type CatalogVersionPreflight,
  type SupportedPluginPlatform,
} from '@deepseek-ai/dsh-plugin-center-contracts'

const MAX_PACKED_BYTES = 64 * 1024 * 1024
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024
const MAX_ENTRY_COUNT = 10_000
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_BUNDLE_PATCH_BYTES = 4 * 1024 * 1024
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u
const INSTALL_LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall'])

interface PluginCenterEvidence {
  readonly expectedEntries?: unknown
  readonly expectedClientModules?: unknown
  readonly expectedSkillIds?: unknown
}

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly scripts?: unknown
  readonly dsh?: {
    readonly bundle?: { readonly patch?: unknown }
    readonly pluginCenter?: PluginCenterEvidence
  }
}

interface ArchiveObservation {
  readonly paths: ReadonlySet<string>
  readonly packageManifest?: Buffer
  readonly bundlePatch?: Buffer
  readonly entryCount: number
  readonly unpackedBytes: number
}

/** Trusted input for one non-executing package verification. */
export interface ArtifactVerificationInput {
  readonly bytes: Uint8Array
  readonly candidate: CatalogVersionPreflight
  readonly platform: SupportedPluginPlatform
}

function archivePath(raw: string): { path: string; issue?: ArtifactVerificationReasonCode } {
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(raw)) {
    return { path: raw, issue: 'archive-absolute-path' }
  }
  if (raw.includes('\\')) return { path: raw, issue: 'archive-path-traversal' }
  const segments = raw.split('/')
  if (segments.some(segment => segment === '..')) return { path: raw, issue: 'archive-path-traversal' }
  while (segments[0] === '.') segments.shift()
  return { path: segments.join('/') }
}

function archiveMember(path: string): string {
  const normalized = path.startsWith('./') ? path.slice(2) : path
  return `package/${normalized}`
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return undefined
  return value as readonly string[]
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort()
  return left.length === right.length && [...left].sort().every((value, index) => value === sortedRight[index])
}

function patchValues(patch: string, key: 'id' | 'name'): ReadonlySet<string> {
  const values = new Set<string>()
  const expression = key === 'id' ? /^\s*-\s+id:\s+(.+?)\s*$/u : /^\s+name:\s+(.+?)\s*$/u
  for (const line of patch.split(/\r?\n/u)) {
    const matched = line.match(expression)?.[1]?.trim()
    if (matched === undefined) continue
    const unquoted = ((matched.startsWith("'") && matched.endsWith("'"))
      || (matched.startsWith('"') && matched.endsWith('"'))) ? matched.slice(1, -1) : matched
    values.add(unquoted)
  }
  return values
}

function parseArchive(
  bytes: Buffer,
  bundlePatchPath: string,
  add: (code: ArtifactVerificationReasonCode, subject: string) => void,
): Promise<ArchiveObservation> {
  const paths = new Set<string>()
  const manifestPath = 'package/package.json'
  const expectedPatchPath = archiveMember(bundlePatchPath)
  let packageManifest: Buffer | undefined
  let bundlePatch: Buffer | undefined
  let entryCount = 0
  let unpackedBytes = 0
  let boundsExceeded = false

  const observation = (): ArchiveObservation => ({
    paths,
    ...(packageManifest === undefined ? {} : { packageManifest }),
    ...(bundlePatch === undefined ? {} : { bundlePatch }),
    entryCount,
    unpackedBytes,
  })

  return new Promise((resolve, reject) => {
    const parser = new Parser({ strict: true, maxMetaEntrySize: MAX_MANIFEST_BYTES, maxDecompressionRatio: 200 })
    parser.on('entry', (entry: ReadEntry) => {
      entryCount += 1
      unpackedBytes += entry.size
      const raw = entry.header.path ?? entry.path
      const decoded = archivePath(raw)
      if (decoded.issue !== undefined) add(decoded.issue, raw)
      const path = decoded.path
      if (paths.has(path)) add('archive-duplicate-entry', path)
      paths.add(path)
      if (entry.type === 'Link' || entry.type === 'SymbolicLink') {
        add('archive-unsafe-link', `${path} -> ${entry.linkpath ?? ''}`)
      } else if (!['File', 'OldFile', 'Directory', 'ContiguousFile'].includes(entry.type)) {
        add('archive-format-invalid', `${path} (${entry.type})`)
      }
      if (entryCount > MAX_ENTRY_COUNT) add('archive-file-count-exceeded', String(entryCount))
      if (unpackedBytes > MAX_UNPACKED_BYTES) add('archive-unpacked-size-exceeded', String(unpackedBytes))
      if (entryCount > MAX_ENTRY_COUNT || unpackedBytes > MAX_UNPACKED_BYTES) {
        boundsExceeded = true
        entry.resume()
        parser.abort(new Error('plugin archive exceeded hard verification bounds'))
        return
      }

      const limit = path === manifestPath
        ? MAX_MANIFEST_BYTES
        : path === expectedPatchPath ? MAX_BUNDLE_PATCH_BYTES : 0
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
          add('archive-unpacked-size-exceeded', path)
          return
        }
        const content = Buffer.concat(chunks)
        if (path === manifestPath) packageManifest = content
        else bundlePatch = content
      })
      entry.resume()
    })
    parser.once('error', (error: unknown) => {
      if (boundsExceeded) resolve(observation())
      else reject(error instanceof Error ? error : new Error(String(error)))
    })
    parser.once('end', () => { resolve(observation()) })
    parser.end(bytes)
  })
}

/**
 * Verify compressed bytes, archive containment, manifest identity, and runtime evidence.
 * @param input - Trusted catalog metadata, current platform, and controlled-cache bytes.
 * @returns An ordered bounded result containing no archive bytes or local paths.
 */
export async function verifyPluginArtifact(input: ArtifactVerificationInput): Promise<ArtifactVerificationResult> {
  const bytes = Buffer.from(input.bytes)
  const reasons: ArtifactVerificationReason[] = []
  const observedReasons = new Set<string>()
  const add = (code: ArtifactVerificationReasonCode, subject: string): void => {
    const boundedSubject = subject.replace(/[\u0000-\u001f\u007f]/gu, '?').slice(0, 256)
    const key = `${code}\u0000${boundedSubject}`
    if (observedReasons.has(key)) return
    observedReasons.add(key)
    reasons.push({ code, subject: boundedSubject })
  }
  const evidence = input.candidate.artifacts.find(artifact => artifact.platform === input.platform)
  if (evidence === undefined) {
    add('expected-evidence-missing', input.platform)
    return decodeArtifactVerificationResult({
      verified: false,
      reasons,
      observedPackageName: null,
      observedVersion: null,
      observedBundlePatch: null,
      entryCount: 0,
      unpackedBytes: 0,
    })
  }

  if (bytes.length > MAX_PACKED_BYTES) {
    add('packed-size-exceeded', `${String(bytes.length)} > ${String(MAX_PACKED_BYTES)}`)
    if (bytes.length !== evidence.packedBytes) {
      add('packed-size-mismatch', `${String(bytes.length)} != ${String(evidence.packedBytes)}`)
    }
    return decodeArtifactVerificationResult({
      verified: false,
      reasons,
      observedPackageName: null,
      observedVersion: null,
      observedBundlePatch: null,
      entryCount: 0,
      unpackedBytes: 0,
    })
  }

  if (bytes.length > evidence.packedBytes) {
    add('packed-size-exceeded', `${String(bytes.length)} > ${String(evidence.packedBytes)}`)
  }
  if (bytes.length !== evidence.packedBytes) {
    add('packed-size-mismatch', `${String(bytes.length)} != ${String(evidence.packedBytes)}`)
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== evidence.sha256) add('sha256-mismatch', input.candidate.packageName)
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (integrity !== evidence.integrity) add('integrity-mismatch', input.candidate.packageName)

  let observation: ArchiveObservation
  try {
    observation = await parseArchive(bytes, input.candidate.bundlePatch, add)
  } catch {
    add('archive-format-invalid', input.candidate.packageName)
    observation = { paths: new Set(), entryCount: 0, unpackedBytes: 0 }
  }
  if (observation.entryCount > evidence.fileCount) {
    add('archive-file-count-exceeded', `${String(observation.entryCount)} > ${String(evidence.fileCount)}`)
  }
  if (observation.unpackedBytes > evidence.unpackedBytes) {
    add('archive-unpacked-size-exceeded', `${String(observation.unpackedBytes)} > ${String(evidence.unpackedBytes)}`)
  }

  let manifest: PackageManifest | undefined
  if (observation.packageManifest === undefined) {
    add('package-manifest-missing', 'package/package.json')
  } else {
    try {
      const parsed: unknown = JSON.parse(observation.packageManifest.toString('utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('manifest object required')
      manifest = parsed
    } catch {
      add('package-manifest-invalid', 'package/package.json')
    }
  }

  const manifestPackageName = typeof manifest?.name === 'string' ? manifest.name : null
  const manifestVersion = typeof manifest?.version === 'string' ? manifest.version : null
  const manifestBundlePatch = typeof manifest?.dsh?.bundle?.patch === 'string' ? manifest.dsh.bundle.patch : null
  const observedPackageName = manifestPackageName !== null && PACKAGE_NAME.test(manifestPackageName) ? manifestPackageName : null
  const observedVersion = manifestVersion !== null && EXACT_VERSION.test(manifestVersion) ? manifestVersion : null
  const observedBundlePatch = manifestBundlePatch === input.candidate.bundlePatch ? manifestBundlePatch : null
  if (manifest !== undefined) {
    if (manifestPackageName !== input.candidate.packageName) {
      add('package-name-mismatch', manifestPackageName ?? '<missing>')
    }
    if (manifestVersion !== input.candidate.version) {
      add('package-version-mismatch', manifestVersion ?? '<missing>')
    }
    if (manifestBundlePatch !== input.candidate.bundlePatch) {
      add('bundle-patch-mismatch', manifestBundlePatch ?? '<missing>')
    }
    if (typeof manifest.scripts === 'object' && manifest.scripts !== null && !Array.isArray(manifest.scripts)) {
      for (const script of Object.keys(manifest.scripts)) {
        if (INSTALL_LIFECYCLE_SCRIPTS.has(script)) add('lifecycle-script-denied', script)
      }
    } else if (manifest.scripts !== undefined) {
      add('package-manifest-invalid', 'scripts')
    }

    const declared = manifest.dsh?.pluginCenter
    const declaredEntries = declared?.expectedEntries === undefined
      ? undefined
      : stringArray(declared.expectedEntries)
    const declaredClientModules = declared?.expectedClientModules === undefined
      ? undefined
      : stringArray(declared.expectedClientModules)
    const declaredSkillIds = declared?.expectedSkillIds === undefined
      ? undefined
      : stringArray(declared.expectedSkillIds)
    if (declared?.expectedEntries !== undefined
      && (declaredEntries === undefined || !sameSet(declaredEntries, input.candidate.expectedEntries))) {
      add('expected-evidence-missing', 'expectedEntries')
    }
    if (declared?.expectedClientModules !== undefined
      && (declaredClientModules === undefined
        || !sameSet(declaredClientModules, input.candidate.expectedClientModules))) {
      add('expected-evidence-missing', 'expectedClientModules')
    }
    if (declared?.expectedSkillIds !== undefined
      && (declaredSkillIds === undefined || !sameSet(declaredSkillIds, input.candidate.expectedSkillIds))) {
      add('expected-evidence-missing', 'expectedSkillIds')
    }
  }

  const patchPath = archiveMember(input.candidate.bundlePatch)
  if (!observation.paths.has(patchPath) || observation.bundlePatch === undefined) {
    add('bundle-patch-missing', patchPath)
  } else {
    const patch = observation.bundlePatch.toString('utf8')
    const ids = patchValues(patch, 'id')
    const names = patchValues(patch, 'name')
    for (const entryId of input.candidate.expectedEntries) {
      if (!ids.has(entryId)) add('expected-evidence-missing', entryId)
    }
    for (const moduleName of input.candidate.expectedClientModules) {
      if (!names.has(moduleName)) add('expected-evidence-missing', moduleName)
    }
  }

  const order = new Map(ARTIFACT_VERIFICATION_REASON_ORDER.map((code, index) => [code, index]))
  reasons.sort((left, right) => {
    const byCode = (order.get(left.code) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.code) ?? Number.MAX_SAFE_INTEGER)
    return byCode === 0 ? left.subject.localeCompare(right.subject) : byCode
  })
  return decodeArtifactVerificationResult({
    verified: reasons.length === 0,
    reasons,
    observedPackageName,
    observedVersion,
    observedBundlePatch,
    entryCount: observation.entryCount,
    unpackedBytes: observation.unpackedBytes,
  })
}
