import { describe, expect, it } from 'vitest'
import {
  CatalogContractError,
  decodeCatalogDetailQuery,
  decodeCatalogListQuery,
  decodeCatalogSnapshot,
  decodeCatalogSummary,
} from '../src/index.ts'

const SUMMARY = {
  pluginId: 'fixture.skill-pack',
  version: '1.2.3',
  catalogKind: 'skill-pack',
  scope: 'public',
  displayName: 'Fixture skills',
  summary: 'Reviewed fixture skills.',
  publisher: 'Harness Fixture',
  verified: true,
  keywords: ['fixture', 'skills'],
  capabilities: ['skill'],
  icon: null,
  brandColor: '#5B8CFF',
  compatibility: { status: 'compatible', reason: null, platforms: ['darwin-arm64', 'win32-x64'] },
  updatedAt: '2026-08-15T00:00:00.000Z',
  installed: false,
} as const

const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`

function snapshot() {
  return {
    schemaVersion: 1,
    etag: 'fixture-v1',
    generatedAt: '2026-08-15T00:00:00.000Z',
    maxAgeSeconds: 3600,
    sections: { featured: ['fixture.skill-pack'], popular: ['fixture.skill-pack'], recent: ['fixture.skill-pack'] },
    entries: [SUMMARY],
    details: [{
      summary: SUMMARY,
      description: 'Fixture detail.',
      screenshots: [],
      permissions: ['Reads only the selected workspace.'],
      riskLevel: 'low',
      riskSummary: 'Reviewed fixture; no sandbox claim.',
      changelog: 'Initial fixture.',
      publishedAt: '2026-08-15T00:00:00.000Z',
      expectedEntries: [],
      expectedClientModules: [],
      expectedSkillIds: ['fixture.skill'],
      eligible: true,
      withdrawn: false,
    }],
    preflights: [{
      pluginId: SUMMARY.pluginId,
      version: SUMMARY.version,
      packageName: '@fixture/dsh-skill-pack',
      catalogEtag: 'fixture-v1',
      reviewed: true,
      eligible: true,
      withdrawn: false,
      desktopRange: '>=0.1.0-rc.1 <0.2.0',
      dshRange: '>=0.1.0-rc.1 <0.2.0',
      nodeRange: '>=22 <23',
      artifacts: [{
        platform: 'darwin-arm64',
        url: 'https://cdn.deepseek.com/plugins/fixture.skill-pack/1.2.3.tgz',
        sha256: 'a'.repeat(64),
        integrity: INTEGRITY,
        packedBytes: 4_096,
        unpackedBytes: 16_384,
        fileCount: 12,
      }],
      bundlePatch: './cordis.patch.yml',
      capabilities: ['skill'],
      riskLevel: 'low',
      riskSummary: 'Reviewed fixture; no sandbox claim.',
      executionAuthority: 'broad-application-authority',
      conflicts: { pluginIds: [], packageNames: [], entryIds: [] },
      expectedEntries: [],
      expectedClientModules: [],
      expectedSkillIds: ['fixture.skill'],
      supportedActions: ['install', 'update', 'enable', 'disable', 'uninstall'],
      restartRequired: true,
    }],
  }
}

describe('plugin center catalog contracts', () => {
  it('decodes an exact Plugin or Skill Bundle snapshot', () => {
    expect(decodeCatalogSnapshot(snapshot())).toEqual(snapshot())
    expect(decodeCatalogSummary(SUMMARY)).toEqual(SUMMARY)
    expect(decodeCatalogListQuery({ catalogKind: 'skill-pack', scope: 'public', query: '', limit: 24 }))
      .toEqual({ catalogKind: 'skill-pack', scope: 'public', query: '', limit: 24 })
    expect(decodeCatalogDetailQuery({ pluginId: 'fixture.skill-pack', version: '1.2.3' }))
      .toEqual({ pluginId: 'fixture.skill-pack', version: '1.2.3' })
  })

  it.each([
    ['unknown snapshot field', () => decodeCatalogSnapshot({ ...snapshot(), rawSkillPath: '/tmp/skill' })],
    ['invalid id', () => decodeCatalogDetailQuery({ pluginId: '../escape', version: '1.2.3' })],
    ['version range', () => decodeCatalogDetailQuery({ pluginId: 'fixture.skill-pack', version: '^1.2.3' })],
    ['oversized page', () => decodeCatalogListQuery({ catalogKind: 'plugin', scope: 'public', query: '', limit: 61 })],
    ['unknown section', () => decodeCatalogSnapshot({ ...snapshot(), sections: { ...snapshot().sections, trending: [] } })],
    ['unapproved media origin', () => decodeCatalogSnapshot({
      ...snapshot(),
      entries: [{ ...SUMMARY, icon: { url: 'https://evil.example/icon.png', alt: '', width: 32, height: 32 } }],
    })],
    ['skill pack without skill capability', () => decodeCatalogSnapshot({
      ...snapshot(), entries: [{ ...SUMMARY, capabilities: ['client'] }],
    })],
    ['missing exact preflight', () => decodeCatalogSnapshot({ ...snapshot(), preflights: [] })],
    ['preflight detail disagreement', () => decodeCatalogSnapshot({
      ...snapshot(), preflights: [{ ...snapshot().preflights[0]!, riskLevel: 'high' }],
    })],
    ['raw Skill query source', () => decodeCatalogListQuery({
      catalogKind: 'skill-pack', scope: 'public', query: '', limit: 24, repository: 'https://github.com/example/skill',
    })],
  ])('rejects %s', (_name, run) => {
    expect(run).toThrow(CatalogContractError)
  })
})
