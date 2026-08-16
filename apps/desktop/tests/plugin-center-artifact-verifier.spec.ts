import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  decodeCatalogVersionPreflight,
  type CatalogArtifactEvidence,
  type CatalogVersionPreflight,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import { verifyPluginArtifact } from '../src/plugin-center/artifact-verifier.ts'
import { BUNDLED_CATALOG } from '../src/plugin-center/catalog-fixture.ts'

interface TarEntry {
  readonly path: string
  readonly body?: string | Buffer
  readonly type?: '0' | '1' | '2'
  readonly linkPath?: string
}

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
    version: '1.2.3',
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

function exactCandidate(
  bytes: Buffer,
  entries: readonly TarEntry[],
  artifactOverrides: Partial<CatalogArtifactEvidence> = {},
): CatalogVersionPreflight {
  const unpackedBytes = entries.reduce((sum, entry) => {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? '')
    return sum + body.length
  }, 0)
  return decodeCatalogVersionPreflight({
    pluginId: 'fixture.workspace-tools',
    version: '1.2.3',
    packageName: '@fixture/dsh-workspace-tools',
    catalogEtag: 'catalog-v1',
    reviewed: true,
    eligible: true,
    withdrawn: false,
    desktopRange: '>=0.1.0-rc.1 <0.2.0',
    dshRange: '>=0.1.0-rc.1 <0.2.0',
    nodeRange: '>=22 <23',
    artifacts: [{
      platform: 'darwin-arm64',
      url: 'https://cdn.deepseek.com/plugins/fixture.workspace-tools/1.2.3.tgz',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      packedBytes: bytes.length,
      unpackedBytes,
      fileCount: entries.length,
      ...artifactOverrides,
    }],
    bundlePatch: './cordis.patch.yml',
    capabilities: ['host', 'client'],
    riskLevel: 'medium',
    riskSummary: 'Reviewed code still runs with broad application authority.',
    executionAuthority: 'broad-application-authority',
    conflicts: { pluginIds: [], packageNames: [], entryIds: [] },
    expectedEntries: ['fixture.workspace-tools'],
    expectedClientModules: ['@fixture/dsh-client-ui-workspace-tools'],
    expectedSkillIds: [],
    supportedActions: ['install', 'update', 'enable', 'disable', 'uninstall'],
    restartRequired: true,
  })
}

function fixture(
  entries: readonly TarEntry[] = packageEntries(),
  artifactOverrides: Partial<CatalogArtifactEvidence> = {},
): { readonly bytes: Buffer; readonly candidate: CatalogVersionPreflight } {
  const bytes = tarball(entries)
  return { bytes, candidate: exactCandidate(bytes, entries, artifactOverrides) }
}

describe('plugin center artifact verifier', () => {
  it.each([
    ['fixture.workspace-tools', 'deepseek-ai-dsh-plugin-center-fixture-0.1.0-rc.5.tgz'],
    ['fixture.skill-pack', 'deepseek-ai-dsh-plugin-center-skill-fixture-0.1.0-rc.5.tgz'],
  ])('accepts the prebuilt reviewed artifact for %s', async (pluginId, filename) => {
    const candidate = BUNDLED_CATALOG.preflights.find(value => value.pluginId === pluginId)
    expect(candidate).toBeDefined()
    const bytes = await readFile(new URL(`../resources/plugin-center/fixtures/${filename}`, import.meta.url))
    const result = await verifyPluginArtifact({
      bytes,
      candidate: candidate!,
      platform: 'darwin-arm64',
    })
    expect(result).toMatchObject({
      verified: true,
      observedPackageName: candidate?.packageName,
      observedVersion: candidate?.version,
    })
  })

  it('accepts one reviewed archive without importing or executing plugin code', async () => {
    const input = fixture()
    await expect(verifyPluginArtifact({ ...input, platform: 'darwin-arm64' })).resolves.toEqual({
      verified: true,
      reasons: [],
      observedPackageName: '@fixture/dsh-workspace-tools',
      observedVersion: '1.2.3',
      observedBundlePatch: './cordis.patch.yml',
      entryCount: 2,
      unpackedBytes: packageEntries().reduce((sum, entry) => sum + Buffer.byteLength(entry.body ?? ''), 0),
    })
  })

  it('accepts a standard prebuilt DSH Bundle without private plugin-center metadata', async () => {
    const manifest = packageManifest({
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web', inject: [] },
      },
      scripts: { prepublishOnly: 'pnpm build' },
    })
    const input = fixture(packageEntries(manifest))

    await expect(verifyPluginArtifact({ ...input, platform: 'darwin-arm64' })).resolves.toMatchObject({
      verified: true,
      reasons: [],
    })
  })

  it.each([
    ['digest', () => {
      const input = fixture()
      return { ...input, candidate: exactCandidate(input.bytes, packageEntries(), { sha256: 'b'.repeat(64) }) }
    }, 'sha256-mismatch'],
    ['package name', () => fixture(packageEntries(packageManifest({ name: '@fixture/wrong' }))), 'package-name-mismatch'],
    ['package version', () => fixture(packageEntries(packageManifest({ version: '1.2.2' }))), 'package-version-mismatch'],
    ['Bundle declaration', () => fixture(packageEntries(packageManifest({
      dsh: {
        bundle: { patch: './other.patch.yml' },
        pluginCenter: {
          expectedEntries: ['fixture.workspace-tools'],
          expectedClientModules: ['@fixture/dsh-client-ui-workspace-tools'],
          expectedSkillIds: [],
        },
      },
    }))), 'bundle-patch-mismatch'],
    ['missing Bundle', () => fixture([{ path: 'package/package.json', body: packageManifest() }]), 'bundle-patch-missing'],
    ['lifecycle script', () => fixture(packageEntries(packageManifest({ scripts: { postinstall: 'node install.js' } }))),
      'lifecycle-script-denied'],
    ['path traversal', () => fixture([...packageEntries(), { path: 'package/../escape', body: 'escape' }]),
      'archive-path-traversal'],
    ['absolute path', () => fixture([...packageEntries(), { path: '/escape', body: 'escape' }]),
      'archive-absolute-path'],
    ['unsafe link', () => fixture([...packageEntries(), {
      path: 'package/link', type: '2', linkPath: '../../escape',
    }]), 'archive-unsafe-link'],
    ['duplicate entry', () => fixture([...packageEntries(), { path: 'package/cordis.patch.yml', body: BUNDLE_PATCH }]),
      'archive-duplicate-entry'],
    ['file count', () => {
      const entries = packageEntries()
      return fixture(entries, { fileCount: 1 })
    }, 'archive-file-count-exceeded'],
    ['packed size', () => {
      const input = fixture()
      return { ...input, candidate: exactCandidate(input.bytes, packageEntries(), { packedBytes: input.bytes.length - 1 }) }
    }, 'packed-size-exceeded'],
    ['unpacked size', () => {
      const entries = packageEntries()
      const input = fixture(entries)
      const unpackedBytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.body ?? ''), 0)
      return { ...input, candidate: exactCandidate(input.bytes, entries, { unpackedBytes: unpackedBytes - 1 }) }
    }, 'archive-unpacked-size-exceeded'],
    ['declared evidence', () => fixture(packageEntries(packageManifest({
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        pluginCenter: { expectedEntries: [], expectedClientModules: [], expectedSkillIds: [] },
      },
    }))), 'expected-evidence-missing'],
    ['invalid archive', () => {
      const bytes = Buffer.from('not a tar archive')
      return { bytes, candidate: exactCandidate(bytes, [{ path: 'invalid', body: 'x' }]) }
    }, 'archive-format-invalid'],
  ])('rejects before mutation: %s', async (_name, makeInput, reason) => {
    const result = await verifyPluginArtifact({ ...makeInput(), platform: 'darwin-arm64' })
    expect(result.verified).toBe(false)
    expect(result.reasons.map(item => item.code)).toContain(reason)
  })
})
