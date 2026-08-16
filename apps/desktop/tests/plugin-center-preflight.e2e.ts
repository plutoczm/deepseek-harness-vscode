import { createHash } from 'node:crypto'
import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CatalogArtifactEvidence,
  CatalogVersionPreflight,
  CompatibilityAction,
  CompatibilityFingerprint,
  CompatibilityReasonCode,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import { verifyPluginArtifact } from '../src/plugin-center/artifact-verifier.ts'
import { BUNDLED_CATALOG } from '../src/plugin-center/catalog-fixture.ts'
import { evaluateCompatibility } from '../src/plugin-center/compatibility.ts'
import { readProfileCompatibilityFingerprint } from '../src/plugin-center/profile-compatibility.ts'

interface TarEntry {
  readonly path: string
  readonly body?: string | Buffer
  readonly type?: '0' | '1' | '2'
  readonly linkPath?: string
}

interface AuthorityFixture {
  readonly root: string
  readonly profile: string
  readonly fingerprint: () => CompatibilityFingerprint
  readonly hash: () => string
}

const roots: string[] = []
const WORKSPACE_CANDIDATE = BUNDLED_CATALOG.preflights.find(
  candidate => candidate.pluginId === 'fixture.workspace-tools',
)!

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function authorityFixture(): AuthorityFixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-preflight-'))
  roots.push(root)
  const profile = join(root, 'profiles/web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, undefined, 2)}\n`)
  writeFileSync(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(root, 'host-generation.json'), '{"generation":11}\n')

  const fingerprint = (): CompatibilityFingerprint => readProfileCompatibilityFingerprint({
    homeDirectory: root,
    profileName: 'web',
    desktopVersion: '0.1.0-rc.5',
    dshVersion: '0.1.0-rc.5',
    nodeVersion: '22.22.0',
    os: 'darwin',
    architecture: 'arm64',
    catalogEtag: BUNDLED_CATALOG.etag,
    catalogFreshness: 'fresh',
    candidates: BUNDLED_CATALOG.preflights,
    systemComponents: {
      packageNames: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      entryIds: ['agent-loop', 'ui-plugin-center'],
    },
    activeOperation: false,
  })
  const hash = (): string => {
    const manifestBytes = readFileSync(join(profile, 'package.json'))
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      dsh: { profile: { bundles: readonly string[] } }
    }
    const currentFingerprint = fingerprint()
    const digest = createHash('sha256')
    for (const [label, value] of [
      ['profile-manifest', manifestBytes],
      ['profile-lock', readFileSync(join(profile, 'pnpm-lock.yaml'))],
      ['profile-patch', readFileSync(join(profile, 'cordis.patch.yml'))],
      ['bundle-order', Buffer.from(JSON.stringify(manifest.dsh.profile.bundles))],
      ['host-generation', readFileSync(join(root, 'host-generation.json'))],
      ['installed-projection', Buffer.from(JSON.stringify(currentFingerprint.installedPlugins))],
    ] as const) {
      digest.update(label)
      digest.update('\0')
      digest.update(value)
      digest.update('\0')
    }
    return digest.digest('hex')
  }
  return { root, profile, fingerprint, hash }
}

function candidate(overrides: Partial<CatalogVersionPreflight> = {}): CatalogVersionPreflight {
  return { ...WORKSPACE_CANDIDATE, ...overrides }
}

interface MetadataDenial {
  readonly name: string
  readonly reason: CompatibilityReasonCode
  readonly candidate?: Partial<CatalogVersionPreflight>
  readonly fingerprint?: Partial<CompatibilityFingerprint>
  readonly action?: CompatibilityAction
}

const METADATA_DENIALS: readonly MetadataDenial[] = [
  { name: 'unreviewed catalog version', reason: 'catalog-unverified', candidate: { reviewed: false } },
  { name: 'withdrawn version', reason: 'version-withdrawn', candidate: { withdrawn: true } },
  { name: 'ineligible version', reason: 'version-ineligible', candidate: { eligible: false } },
  { name: 'stale catalog authority', reason: 'version-ineligible', fingerprint: { catalogFreshness: 'stale' } },
  { name: 'catalog revision changed', reason: 'catalog-metadata-invalid', fingerprint: { catalogEtag: 'changed' } },
  { name: 'Desktop release range', reason: 'desktop-version-unsupported', candidate: { desktopRange: '>=0.2.0' } },
  { name: 'DSH release range', reason: 'dsh-version-unsupported', candidate: { dshRange: '>=0.2.0' } },
  { name: 'Node release range', reason: 'node-version-unsupported', candidate: { nodeRange: '>=25' } },
  { name: 'platform artifact absent', reason: 'artifact-missing', candidate: { artifacts: [] } },
  {
    name: 'runtime evidence absent',
    reason: 'artifact-evidence-incomplete',
    candidate: { expectedEntries: [], expectedClientModules: [], expectedSkillIds: [] },
  },
  { name: 'protected package', reason: 'protected-package', candidate: { packageName: '@deepseek-ai/dsh-base' } },
  { name: 'protected Loader row', reason: 'protected-entry', candidate: { expectedEntries: ['agent-loop'] } },
  {
    name: 'package identity collision',
    reason: 'package-identity-conflict',
    fingerprint: { installedPlugins: [{
      pluginId: null,
      version: WORKSPACE_CANDIDATE.version,
      packageName: WORKSPACE_CANDIDATE.packageName,
      enabled: true,
      entryIds: ['local.other'],
    }] },
  },
  {
    name: 'Loader row identity collision',
    reason: 'entry-identity-conflict',
    fingerprint: { installedPlugins: [{
      pluginId: 'fixture.other',
      version: '1.0.0',
      packageName: '@fixture/other',
      enabled: true,
      entryIds: ['fixture.workspace-tools'],
    }] },
  },
  {
    name: 'declared catalog conflict',
    reason: 'declared-conflict',
    candidate: { conflicts: { pluginIds: ['fixture.other'], packageNames: [], entryIds: [] } },
    fingerprint: { installedPlugins: [{
      pluginId: 'fixture.other',
      version: '1.0.0',
      packageName: '@fixture/other',
      enabled: false,
      entryIds: [],
    }] },
  },
  { name: 'concurrent operation', reason: 'operation-busy', fingerprint: { activeOperation: true } },
  { name: 'action without installed version', reason: 'action-not-supported', action: 'update' },
]

function field(block: Buffer, offset: number, length: number, value: string): void {
  block.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8')
}

function octal(block: Buffer, offset: number, length: number, value: number): void {
  field(block, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

function tarball(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? '')
    const header = Buffer.alloc(512)
    field(header, 0, 100, entry.path)
    octal(header, 100, 8, 0o644)
    octal(header, 108, 8, 0)
    octal(header, 116, 8, 0)
    octal(header, 124, 12, body.length)
    octal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    field(header, 156, 1, entry.type ?? '0')
    field(header, 157, 100, entry.linkPath ?? '')
    field(header, 257, 6, 'ustar\0')
    field(header, 263, 2, '00')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    field(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
    chunks.push(header, body)
    const padding = (512 - (body.length % 512)) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

function packageManifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: '@fixture/dsh-workspace-tools',
    version: '1.0.0',
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      pluginCenter: {
        expectedEntries: ['fixture.workspace-tools'],
        expectedClientModules: ['@fixture/dsh-client-ui-workspace-tools'],
        expectedSkillIds: [],
      },
    },
    ...overrides,
  })
}

const BUNDLE_PATCH = `- insert:
    - id: fixture.workspace-tools
      name: '@fixture/dsh-workspace-tools'
    - id: fixture.workspace-tools-ui
      name: '@fixture/dsh-client-ui-workspace-tools'
`

function packageEntries(manifest = packageManifest(), patch = BUNDLE_PATCH): readonly TarEntry[] {
  return [
    { path: 'package/package.json', body: manifest },
    { path: 'package/cordis.patch.yml', body: patch },
  ]
}

function artifactCandidate(
  bytes: Buffer,
  entries: readonly TarEntry[],
  overrides: Partial<CatalogArtifactEvidence> = {},
): CatalogVersionPreflight {
  const unpackedBytes = entries.reduce((sum, entry) => {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? '')
    return sum + body.length
  }, 0)
  return {
    ...WORKSPACE_CANDIDATE,
    artifacts: [{
      platform: 'darwin-arm64',
      url: 'https://cdn.deepseek.com/plugins/fixture.workspace-tools/1.0.0.tgz',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      packedBytes: bytes.length,
      unpackedBytes,
      fileCount: entries.length,
      ...overrides,
    }],
  }
}

function artifactFixture(
  entries: readonly TarEntry[] = packageEntries(),
  overrides: Partial<CatalogArtifactEvidence> = {},
) {
  const bytes = tarball(entries)
  return { bytes, candidate: artifactCandidate(bytes, entries, overrides), platform: 'darwin-arm64' as const }
}

const ARTIFACT_DENIALS = [
  ['digest mismatch', () => {
    const input = artifactFixture()
    return { ...input, candidate: artifactCandidate(input.bytes, packageEntries(), { sha256: 'b'.repeat(64) }) }
  }, 'sha256-mismatch'],
  ['package name mismatch', () => artifactFixture(packageEntries(packageManifest({ name: '@fixture/wrong' }))),
    'package-name-mismatch'],
  ['package version mismatch', () => artifactFixture(packageEntries(packageManifest({ version: '1.0.1' }))),
    'package-version-mismatch'],
  ['Bundle declaration mismatch', () => artifactFixture(packageEntries(packageManifest({
    dsh: {
      bundle: { patch: './other.patch.yml' },
      pluginCenter: {
        expectedEntries: ['fixture.workspace-tools'],
        expectedClientModules: ['@fixture/dsh-client-ui-workspace-tools'],
        expectedSkillIds: [],
      },
    },
  }))), 'bundle-patch-mismatch'],
  ['missing Bundle patch', () => artifactFixture([{ path: 'package/package.json', body: packageManifest() }]),
    'bundle-patch-missing'],
  ['lifecycle script', () => artifactFixture(packageEntries(packageManifest({ scripts: { postinstall: 'node install.js' } }))),
    'lifecycle-script-denied'],
  ['path traversal', () => artifactFixture([...packageEntries(), { path: 'package/../escape', body: 'escape' }]),
    'archive-path-traversal'],
  ['absolute path', () => artifactFixture([...packageEntries(), { path: '/escape', body: 'escape' }]),
    'archive-absolute-path'],
  ['unsafe link', () => artifactFixture([...packageEntries(), {
    path: 'package/link', type: '2', linkPath: '../../escape',
  }]), 'archive-unsafe-link'],
  ['duplicate entry', () => artifactFixture([
    ...packageEntries(), { path: 'package/cordis.patch.yml', body: BUNDLE_PATCH },
  ]), 'archive-duplicate-entry'],
  ['file count', () => artifactFixture(packageEntries(), { fileCount: 1 }), 'archive-file-count-exceeded'],
  ['packed size', () => {
    const input = artifactFixture()
    return {
      ...input,
      candidate: artifactCandidate(input.bytes, packageEntries(), { packedBytes: input.bytes.length - 1 }),
    }
  }, 'packed-size-exceeded'],
  ['unpacked size', () => {
    const entries = packageEntries()
    const input = artifactFixture(entries)
    const unpackedBytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.body ?? ''), 0)
    return { ...input, candidate: artifactCandidate(input.bytes, entries, { unpackedBytes: unpackedBytes - 1 }) }
  }, 'archive-unpacked-size-exceeded'],
  ['declared evidence', () => artifactFixture(packageEntries(packageManifest({
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      pluginCenter: { expectedEntries: [], expectedClientModules: [], expectedSkillIds: [] },
    },
  }))), 'expected-evidence-missing'],
  ['invalid archive', () => {
    const bytes = Buffer.from('not a tar archive')
    return {
      bytes,
      candidate: artifactCandidate(bytes, [{ path: 'invalid', body: 'x' }]),
      platform: 'darwin-arm64' as const,
    }
  }, 'archive-format-invalid'],
] as const

describe('plugin center preflight mutation boundary', () => {
  it.each(METADATA_DENIALS)('denies metadata before mutation: $name', (scenario) => {
    const authority = authorityFixture()
    const before = authority.hash()
    const decision = evaluateCompatibility({
      candidate: candidate(scenario.candidate),
      fingerprint: { ...authority.fingerprint(), ...scenario.fingerprint },
      action: scenario.action ?? 'install',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reasons.map(reason => reason.code)).toContain(scenario.reason)
    expect(authority.hash()).toBe(before)
  })

  it.each(ARTIFACT_DENIALS)('denies artifact before mutation: %s', async (_name, makeInput, reason) => {
    const authority = authorityFixture()
    const before = authority.hash()
    const result = await verifyPluginArtifact(makeInput())
    expect(result.verified).toBe(false)
    expect(result.reasons.map(item => item.code)).toContain(reason)
    expect(authority.hash()).toBe(before)
  })
})
