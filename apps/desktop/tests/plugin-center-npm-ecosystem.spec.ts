import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogCache } from '../src/plugin-center/catalog-cache.ts'
import { NpmEcosystemCatalogRepository } from '../src/plugin-center/npm-ecosystem-catalog.ts'

const roots: string[] = []
const NOW = Date.parse('2026-08-15T08:00:00.000Z')
const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-center-fixture'
const VERSION = '0.1.0-rc.5'
const TARBALL_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/-/${VERSION}.tgz`
const QUERY = { catalogKind: 'plugin', scope: 'public', query: 'workspace', limit: 24 } as const

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-npm-ecosystem-'))
  roots.push(root)
  return root
}

describe('npm DSH ecosystem catalog', () => {
  it('searches tagged Bundles, hydrates exact artifact authority, and reuses it offline', async () => {
    const root = await temporaryRoot()
    const bytes = await readFile(new URL(
      '../resources/plugin-center/fixtures/deepseek-ai-dsh-plugin-center-fixture-0.1.0-rc.5.tgz',
      import.meta.url,
    ))
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/-/v1/search') {
        return new Response(JSON.stringify({
          total: 571,
          objects: [{
            package: {
              name: PACKAGE_NAME,
              version: VERSION,
              date: '2026-08-15T07:00:00.000Z',
              keywords: ['dsh-plugin', 'workspace'],
              publisher: { username: 'deepseek-ai' },
            },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.href === TARBALL_URL) {
        return new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.byteLength) },
        })
      }
      return new Response(JSON.stringify({
        name: PACKAGE_NAME,
        version: VERSION,
        description: 'Workspace tools for DeepSeek Harness',
        keywords: ['dsh-plugin', 'workspace'],
        author: { name: 'DeepSeek Harness' },
        repository: { type: 'git', url: 'git+https://github.com/deepseek-ai/deepseek-harness.git' },
        engines: { node: '>=22.19 <25' },
        dsh: {
          bundle: { patch: './cordis.patch.yml' },
          client: { platform: 'web', inject: [] },
          pluginCenter: {
            expectedEntries: ['fixture.workspace-tools'],
            expectedClientModules: [PACKAGE_NAME],
            expectedSkillIds: [],
          },
        },
        dist: { tarball: TARBALL_URL, integrity },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const cache = new CatalogCache(root)
    const repository = new NpmEcosystemCatalogRepository(cache, fetcher, () => NOW)

    const list = await repository.list(QUERY)
    const summary = list.sections.featured[0]
    expect(list).toMatchObject({ source: 'network', freshness: 'fresh' })
    expect(summary).toMatchObject({
      displayName: PACKAGE_NAME,
      verified: false,
      icon: {
        url: 'https://avatars.githubusercontent.com/deepseek-ai?s=128',
        alt: 'DeepSeek Harness publisher avatar',
        width: 128,
        height: 128,
      },
    })
    expect(summary?.brandColor).toMatch(/^#[0-9A-F]{6}$/u)

    const detail = await repository.detail({ pluginId: summary!.pluginId, version: VERSION })
    expect(detail.detail).toMatchObject({
      summary: { verified: true },
      expectedEntries: ['fixture.workspace-tools'],
      expectedClientModules: [PACKAGE_NAME],
      riskLevel: 'high',
    })
    const selection = await repository.resolvePreflight({
      pluginId: summary!.pluginId,
      version: VERSION,
      action: 'install',
    })
    expect(selection.candidate).toMatchObject({ packageName: PACKAGE_NAME, reviewed: true })
    expect(selection.candidate?.artifacts).toContainEqual(expect.objectContaining({
      url: TARBALL_URL,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }))

    const offline = new NpmEcosystemCatalogRepository(cache, vi.fn<typeof fetch>(async () => {
      throw new Error('offline')
    }), () => NOW)
    await expect(offline.installedAuthority()).resolves.toMatchObject({
      freshness: 'cached',
      entries: [{
        displayName: PACKAGE_NAME,
        verified: true,
        icon: { url: 'https://avatars.githubusercontent.com/deepseek-ai?s=128' },
      }],
      preflights: [{ packageName: PACKAGE_NAME }],
    })
  })

  it('prefers bounded publisher-declared artwork over the GitHub avatar fallback', async () => {
    const root = await temporaryRoot()
    const name = '@fixture/visual-plugin'
    const version = '1.0.0'
    const integrity = `sha512-${createHash('sha512').update(name).digest('base64')}`
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/-/v1/search') {
        return new Response(JSON.stringify({
          total: 1,
          objects: [{
            package: {
              name,
              version,
              date: '2026-08-15T07:00:00.000Z',
              keywords: ['dsh-plugin'],
              publisher: { username: 'fixture' },
            },
          }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        name,
        version,
        keywords: ['dsh-plugin'],
        repository: { url: 'git+https://github.com/fallback-owner/visual-plugin.git' },
        dsh: {
          bundle: { patch: './cordis.patch.yml' },
          pluginCenter: {
            icon: {
              url: 'https://raw.githubusercontent.com/fixture/visual-plugin/main/icon.png',
              alt: 'Visual plugin logo',
              width: 256,
              height: 256,
            },
            brandColor: '#123ABC',
          },
        },
        dist: {
          tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
          integrity,
        },
      }), { status: 200 })
    }
    const repository = new NpmEcosystemCatalogRepository(new CatalogCache(root), fetcher, () => NOW)

    const result = await repository.list({ ...QUERY, query: '' })

    expect(result.sections.featured[0]).toMatchObject({
      icon: { url: 'https://raw.githubusercontent.com/fixture/visual-plugin/main/icon.png' },
      brandColor: '#123ABC',
    })
  })

  it('excludes tagged npm packages that do not declare a DSH Bundle', async () => {
    const root = await temporaryRoot()
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/-/v1/search') {
        return new Response(JSON.stringify({
          objects: [{
            package: {
              name: 'plain-library',
              version: '1.0.0',
              date: '2026-08-15T07:00:00.000Z',
              keywords: ['dsh-plugin'],
              publisher: { username: 'publisher' },
            },
          }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        name: 'plain-library',
        version: '1.0.0',
        keywords: ['dsh-plugin'],
        dist: {},
      }), { status: 200 })
    }
    const repository = new NpmEcosystemCatalogRepository(new CatalogCache(root), fetcher, () => NOW)

    await expect(repository.list({ ...QUERY, query: '' })).resolves.toMatchObject({
      source: 'network',
      sections: { featured: [], popular: [], recent: [] },
    })
  })

  it('searches the complete paginated npm keyword index before filtering by the live query', async () => {
    const root = await temporaryRoot()
    const targetName = 'deepseek-harness-openai-oauth'
    const targetVersion = '0.3.1'
    const integrity = `sha512-${createHash('sha512').update(targetName).digest('base64')}`
    const searchOffsets: string[] = []
    const metadataRequests: string[] = []
    const decoys = Array.from({ length: 250 }, (_, index) => ({
      package: {
        name: `dsh-decoy-${String(index).padStart(3, '0')}`,
        version: '1.0.0',
        date: '2026-08-15T07:00:00.000Z',
        description: 'Unrelated catalog entry',
        keywords: ['dsh-plugin'],
        publisher: { username: 'publisher' },
      },
    }))
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/-/v1/search') {
        const from = url.searchParams.get('from') ?? '0'
        searchOffsets.push(from)
        return new Response(JSON.stringify({
          total: 251,
          objects: from === '0' ? decoys : [{
            package: {
              name: targetName,
              version: targetVersion,
              date: '2026-08-15T07:30:00.000Z',
              description: 'OpenAI OAuth provider for DeepSeek Harness',
              keywords: ['dsh-plugin', 'oauth'],
              publisher: { username: 'publisher' },
            },
          }],
        }), { status: 200 })
      }
      metadataRequests.push(url.pathname)
      return new Response(JSON.stringify({
        name: targetName,
        version: targetVersion,
        description: 'OpenAI OAuth provider for DeepSeek Harness',
        keywords: ['dsh-plugin', 'oauth'],
        author: { name: 'publisher' },
        engines: { node: '>=22.19 <25' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        dist: {
          tarball: `https://registry.npmjs.org/${targetName}/-/${targetName}-${targetVersion}.tgz`,
          integrity,
        },
      }), { status: 200 })
    }
    const repository = new NpmEcosystemCatalogRepository(new CatalogCache(root), fetcher, () => NOW)

    const result = await repository.list({ ...QUERY, query: targetName })

    expect(result).toMatchObject({
      source: 'network',
      sections: { featured: [expect.objectContaining({ displayName: targetName })] },
    })
    expect(searchOffsets).toEqual(['0', '250'])
    expect(metadataRequests).toEqual([`/${targetName}/${targetVersion}`])
  })

  it('returns a small cold-start batch and reuses its strict discovery cache on the next launch', async () => {
    const root = await temporaryRoot()
    const packages = Array.from({ length: 30 }, (_, index) => ({
      name: `dsh-cold-${String(index).padStart(2, '0')}`,
      version: '1.0.0',
      date: '2026-08-15T07:00:00.000Z',
      description: `Cold-start plugin ${String(index)}`,
      keywords: ['dsh-plugin'],
      publisher: { username: 'fixture' },
    }))
    const metadataRequests: string[] = []
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/-/v1/search') {
        return new Response(JSON.stringify({ total: packages.length, objects: packages.map(packageValue => ({
          package: packageValue,
        })) }), { status: 200 })
      }
      metadataRequests.push(url.pathname)
      const name = url.pathname.split('/').filter(Boolean)[0] ?? ''
      const integrity = `sha512-${createHash('sha512').update(name).digest('base64')}`
      return new Response(JSON.stringify({
        name,
        version: '1.0.0',
        description: `Cold-start plugin ${name}`,
        keywords: ['dsh-plugin'],
        repository: { url: `git+https://github.com/fixture/${name}.git` },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        dist: {
          tarball: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
          integrity,
        },
      }), { status: 200 })
    }
    const query = { ...QUERY, query: '' }
    const repository = new NpmEcosystemCatalogRepository(
      new CatalogCache(root),
      fetcher,
      () => NOW,
      root,
    )

    const cold = await repository.list(query)

    expect(Object.values(cold.sections).flat()).toHaveLength(6)
    expect(metadataRequests).toHaveLength(12)

    const offlineFetch = vi.fn<typeof fetch>(async () => { throw new Error('offline') })
    const reopened = new NpmEcosystemCatalogRepository(
      new CatalogCache(root),
      offlineFetch,
      () => NOW + 1_000,
      root,
    )
    const cached = await reopened.list(query)

    expect(cached).toMatchObject({ source: 'cache', freshness: 'cached' })
    expect(Object.values(cached.sections).flat()).toHaveLength(12)
    expect(offlineFetch).not.toHaveBeenCalled()
    const cachedEntry = cached.sections.featured[0]!
    await expect(reopened.resolvePreflight({
      pluginId: cachedEntry.pluginId,
      version: cachedEntry.version,
      action: 'install',
    })).resolves.toMatchObject({ candidate: null })
    expect(offlineFetch).toHaveBeenCalledTimes(1)
  })
})
