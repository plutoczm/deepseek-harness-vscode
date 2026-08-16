import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { decodeCatalogListQuery } from '@deepseek-ai/dsh-plugin-center-contracts'
import { CatalogCache } from '../src/plugin-center/catalog-cache.ts'
import { CatalogRepository, createCatalogTransport, type CatalogTransport } from '../src/plugin-center/catalog-client.ts'
import { BUNDLED_CATALOG } from '../src/plugin-center/catalog-fixture.ts'

const NOW = Date.parse('2026-08-15T04:30:00.000Z')
const QUERY = decodeCatalogListQuery({ catalogKind: 'plugin', scope: 'public', query: '', limit: 24 })

function retag(etag: string) {
  return {
    ...BUNDLED_CATALOG,
    etag,
    preflights: BUNDLED_CATALOG.preflights.map(preflight => ({ ...preflight, catalogEtag: etag })),
  }
}

async function repository(transport: CatalogTransport) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-catalog-'))
  return { root, cache: new CatalogCache(root), repository: new CatalogRepository(
    new CatalogCache(root), BUNDLED_CATALOG, transport, () => NOW,
  ) }
}

describe('verified catalog cache', () => {
  it('atomically replaces a first fetch, reuses 304, and preserves it after a failed refresh', async () => {
    const updated = { ...retag('network-v2'), generatedAt: '2026-08-15T04:20:00.000Z' }
    const transport = vi.fn<CatalogTransport>()
      .mockResolvedValueOnce({ status: 200, etag: 'network-v2', body: updated })
      .mockResolvedValueOnce({ status: 304 })
      .mockRejectedValueOnce(new Error('offline'))
    const fixture = await repository(transport)

    await fixture.repository.refresh(QUERY)
    expect((await fixture.repository.list(QUERY))).toMatchObject({ etag: 'network-v2', freshness: 'fresh', source: 'network' })
    const saved = await fixture.cache.read()
    expect(saved?.etag).toBe('network-v2')

    await fixture.repository.refresh(QUERY)
    expect((await fixture.repository.list(QUERY))).toMatchObject({ etag: 'network-v2', freshness: 'fresh' })
    await fixture.repository.refresh(QUERY)
    expect((await fixture.repository.list(QUERY))).toMatchObject({ etag: 'network-v2', freshness: 'stale' })
    expect(transport).toHaveBeenNthCalledWith(1, BUNDLED_CATALOG.etag)
    expect(transport).toHaveBeenNthCalledWith(2, 'network-v2')
    expect(await readFile(join(fixture.root, 'plugin-center/catalog-v1.json'), 'utf8')).toContain('network-v2')
  })

  it('keeps the last verified object when replacement decoding fails and bounds projections', async () => {
    const fixture = await repository(async () => ({
      status: 200,
      etag: 'invalid-v3',
      body: { ...retag('invalid-v3'), rawSkillPath: '/tmp/skill' },
    }))
    const before = await fixture.repository.list(QUERY)
    await fixture.repository.refresh(QUERY)
    const after = await fixture.repository.list(QUERY)
    expect(after.etag).toBe(before.etag)
    expect(after.freshness).toBe('stale')
    const bounded = await fixture.repository.list({ ...QUERY, limit: 1 })
    expect(bounded.sections.featured).toHaveLength(1)
  })

  it('uses If-None-Match and rejects oversized HTTP content before publication', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1), {
      status: 200,
      headers: { etag: 'too-large' },
    }))
    const transport = createCatalogTransport(new URL('https://catalog.example.test/v1/catalog.json'), fetcher)
    await expect(transport('fixture-v1')).rejects.toThrow('exceeds 2 MiB')
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      headers: { 'if-none-match': 'fixture-v1' },
      redirect: 'error',
    }))
    expect(() => createCatalogTransport(new URL('http://catalog.example.test/v1/catalog.json'))).toThrow('HTTPS')
  })
})
