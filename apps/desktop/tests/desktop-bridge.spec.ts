import { describe, expect, it } from 'vitest'
import {
  decodeCatalogDetailQuery,
  decodeCatalogListQuery,
  decodeCompatibilityRequest,
  type CompatibilityFingerprint,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import { assertCatalogRequestOwner } from '../src/plugin-center/bridge-policy.ts'
import { BUNDLED_CATALOG } from '../src/plugin-center/catalog-fixture.ts'
import { PluginCompatibilityService } from '../src/plugin-center/preflight-service.ts'

describe('plugin catalog reads', () => {
  it('accepts only bounded intent from the current renderer generation', () => {
    expect(() => {
      assertCatalogRequestOwner(
        { senderId: 7, senderFrameUrl: 'http://127.0.0.1:43120/settings?view=plugins' },
        { webContentsId: 7, origin: 'http://127.0.0.1:43120' },
      )
    }).not.toThrow()
    expect(decodeCatalogListQuery({ catalogKind: 'skill-pack', scope: 'public', query: 'skill', limit: 24 }))
      .toMatchObject({ catalogKind: 'skill-pack', query: 'skill' })
    expect(decodeCatalogDetailQuery({ pluginId: 'fixture.skill-pack', version: '0.2.0' }))
      .toEqual({ pluginId: 'fixture.skill-pack', version: '0.2.0' })
  })

  it.each([
    [{ senderId: 8, senderFrameUrl: 'http://127.0.0.1:43120/' }, { webContentsId: 7, origin: 'http://127.0.0.1:43120' }],
    [{ senderId: 7, senderFrameUrl: 'http://127.0.0.1:43121/' }, { webContentsId: 7, origin: 'http://127.0.0.1:43120' }],
    [{ senderId: 7, senderFrameUrl: undefined }, { webContentsId: 7, origin: 'http://127.0.0.1:43120' }],
    [{ senderId: 7, senderFrameUrl: 'not a URL' }, { webContentsId: 7, origin: 'http://127.0.0.1:43120' }],
  ])('rejects an unowned or stale renderer', (identity, owner) => {
    expect(() => {
      assertCatalogRequestOwner(identity, owner)
    }).toThrow(/plugin catalog request/u)
  })

  it('rejects endpoints, package sources, and unbounded queries', () => {
    expect(() => decodeCatalogListQuery({
      catalogKind: 'plugin', scope: 'public', query: '', limit: 24, endpoint: 'https://evil.example',
    })).toThrow()
    expect(() => decodeCatalogDetailQuery({
      pluginId: 'fixture.skill-pack', version: '0.2.0', packageName: '@evil/package',
    })).toThrow()
    expect(() => decodeCatalogListQuery({ catalogKind: 'plugin', scope: 'public', query: '', limit: 10_000 })).toThrow()
  })

  it('enforces compatibility ownership and resolves all authority outside the renderer', async () => {
    const request = { pluginId: 'fixture.workspace-tools', version: '1.0.0', action: 'install' } as const
    expect(decodeCompatibilityRequest(request)).toEqual(request)
    for (const forbidden of [
      { packageName: '@evil/package' },
      { url: 'https://evil.example/plugin.tgz' },
      { path: '/tmp/plugin.tgz' },
      { evidence: { sha256: 'a'.repeat(64) } },
      { environment: { platform: 'darwin-arm64' } },
      { policy: { allowProtected: true } },
    ]) {
      expect(() => decodeCompatibilityRequest({ ...request, ...forbidden })).toThrow()
    }

    const candidate = BUNDLED_CATALOG.preflights.find(value => value.pluginId === request.pluginId)!
    const fingerprint: CompatibilityFingerprint = {
      desktopVersion: '0.1.0-rc.5',
      dshVersion: '0.1.0-rc.5',
      nodeVersion: '22.22.0',
      platform: 'darwin-arm64',
      catalogEtag: BUNDLED_CATALOG.etag,
      catalogFreshness: 'fresh',
      profileRevision: 4,
      installedPlugins: [],
      protectedPackageNames: [],
      protectedEntryIds: [],
      activeOperation: false,
    }
    const resolved: unknown[] = []
    let reads = 0
    const service = new PluginCompatibilityService({
      resolvePreflight: async (value) => {
        resolved.push(value)
        return {
          candidate,
          candidates: BUNDLED_CATALOG.preflights,
          etag: BUNDLED_CATALOG.etag,
          freshness: 'fresh',
        }
      },
    }, () => {
      reads += 1
      return fingerprint
    })

    await expect(service.check(request)).resolves.toMatchObject({ allowed: true, action: 'install' })
    expect(resolved).toEqual([request])
    expect(reads).toBe(1)
  })
})
