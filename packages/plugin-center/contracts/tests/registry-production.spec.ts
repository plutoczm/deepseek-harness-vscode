import { describe, expect, it } from 'vitest'
import {
  CatalogContractError,
  decodeRegistryErrorResult,
  decodeRegistryFeaturedPlacementRequest,
  decodeRegistryHealthResult,
  decodeRegistryInstallEvent,
  decodeRegistryModerationRequest,
  decodeRegistryOperationResult,
  decodeRegistryRankAudit,
  decodeRegistryVersionImportRequest,
} from '../src/index.ts'

const NOW = '2026-08-15T08:00:00.000Z'
const INTEGRITY = `sha512-${Buffer.alloc(64, 3).toString('base64')}`

function importRequest() {
  const summary = {
    pluginId: 'fixture.registry-plugin',
    version: '1.2.3',
    catalogKind: 'plugin',
    scope: 'public',
    displayName: 'Registry fixture',
    summary: 'Reviewed only after an attributable decision.',
    publisher: 'Fixture Publisher',
    verified: false,
    keywords: ['fixture'],
    capabilities: ['host'],
    icon: null,
    brandColor: '#5B8CFF',
    compatibility: { status: 'compatible', reason: null, platforms: ['darwin-arm64', 'win32-x64'] },
    updatedAt: NOW,
    installed: false,
  } as const
  return {
    schemaVersion: 1,
    requestId: 'import.fixture.registry-plugin.1.2.3',
    operatorId: 'operator.catalog',
    reason: 'Initial reviewed fixture import.',
    evidenceRef: 'review.fixture.registry-plugin.1.2.3',
    occurredAt: NOW,
    publisher: { publisherId: 'publisher.fixture', displayName: 'Fixture Publisher' },
    detail: {
      summary,
      description: 'Registry fixture detail.',
      screenshots: [],
      permissions: ['Runs inside the Host process.'],
      riskLevel: 'medium',
      riskSummary: 'Reviewed metadata does not provide process isolation.',
      changelog: 'Initial version.',
      publishedAt: NOW,
      expectedEntries: ['fixture.registry-plugin'],
      expectedClientModules: [],
      expectedSkillIds: [],
      eligible: false,
      withdrawn: false,
    },
    preflight: {
      pluginId: summary.pluginId,
      version: summary.version,
      packageName: '@fixture/dsh-registry-plugin',
      catalogEtag: 'pending-import',
      reviewed: false,
      eligible: false,
      withdrawn: false,
      desktopRange: '>=0.1.0-rc.1 <0.2.0',
      dshRange: '>=0.1.0-rc.1 <0.2.0',
      nodeRange: '>=22.19 <25',
      artifacts: (['darwin-arm64', 'win32-x64'] as const).map(platform => ({
        platform,
        url: `https://cdn.deepseek.com/plugins/${summary.pluginId}/${summary.version}/${platform}.tgz`,
        sha256: 'a'.repeat(64),
        integrity: INTEGRITY,
        packedBytes: 4_096,
        unpackedBytes: 16_384,
        fileCount: 12,
      })),
      bundlePatch: './cordis.patch.yml',
      capabilities: ['host'],
      riskLevel: 'medium',
      riskSummary: 'Reviewed metadata does not provide process isolation.',
      executionAuthority: 'broad-application-authority',
      conflicts: { pluginIds: [], packageNames: [], entryIds: [] },
      expectedEntries: ['fixture.registry-plugin'],
      expectedClientModules: [],
      expectedSkillIds: [],
      supportedActions: ['install', 'update', 'enable', 'disable', 'uninstall'],
      restartRequired: true,
    },
    categoryIds: ['productivity'],
    artifactObjects: (['darwin-arm64', 'win32-x64'] as const).map(platform => ({
      platform,
      objectKey: `plugins/${summary.pluginId}/${summary.version}/${platform}.tgz`,
    })),
  }
}

function installEvent() {
  return {
    schemaVersion: 1,
    eventId: 'event.fixture.0001',
    pluginId: 'fixture.registry-plugin',
    version: '1.2.3',
    installationId: '0123456789abcdef0123456789abcdef',
    platform: 'darwin-arm64',
    desktopVersion: '0.1.0-rc.5',
    dshVersion: '0.1.0-rc.5',
    result: 'success',
    reason: 'none',
    durationBucket: '30s-2m',
    occurredAt: NOW,
    operatorTest: false,
  }
}

describe('registry production contracts', () => {
  it('decodes pending import, attributable moderation, and a deterministic featured window', () => {
    expect(decodeRegistryVersionImportRequest(importRequest()).preflight.eligible).toBe(false)
    expect(decodeRegistryModerationRequest({
      requestId: 'approve.fixture.registry-plugin.1.2.3',
      operatorId: 'operator.catalog',
      pluginId: 'fixture.registry-plugin',
      version: '1.2.3',
      action: 'approve',
      reason: 'Artifact and evidence reviewed.',
      evidenceRef: 'review.fixture.registry-plugin.1.2.3',
      occurredAt: NOW,
    }).action).toBe('approve')
    expect(decodeRegistryFeaturedPlacementRequest({
      requestId: 'feature.fixture.registry-plugin.1.2.3',
      operatorId: 'operator.catalog',
      pluginId: 'fixture.registry-plugin',
      version: '1.2.3',
      section: 'featured',
      position: 1,
      startsAt: NOW,
      endsAt: '2026-08-22T08:00:00.000Z',
      reason: 'Launch feature.',
    }).position).toBe(1)
  })

  it.each(['profilePath', 'workspace', 'prompt', 'credentials', 'configuration', 'arbitraryText'])(
    'rejects sensitive or unknown install-event field %s', (field) => {
      expect(() => decodeRegistryInstallEvent({ ...installEvent(), [field]: 'private' })).toThrow(CatalogContractError)
    },
  )

  it('keeps install telemetry replay-safe and coarse', () => {
    expect(decodeRegistryInstallEvent(installEvent())).toEqual(installEvent())
    expect(() => decodeRegistryInstallEvent({ ...installEvent(), installationId: '/Users/tester' }))
      .toThrow(CatalogContractError)
    expect(() => decodeRegistryInstallEvent({ ...installEvent(), result: 'success', reason: 'anomaly' }))
      .toThrow(CatalogContractError)
  })

  it('decodes auditable popularity inputs, stable operation results, errors, and health', () => {
    expect(decodeRegistryRankAudit({
      pluginId: 'fixture.registry-plugin',
      version: '1.2.3',
      formulaVersion: 'popular-v1',
      generatedAt: NOW,
      inputs: {
        uniqueSuccess7d: 12,
        uniqueSuccess24h: 4,
        previousSuccess7d: 6,
        attempt7d: 14,
        rollbackOrActivationFailure7d: 2,
        ageInDays: 7,
      },
      growth: 1,
      failureRate: 2 / 14,
      freshness: 23 / 30,
      score: 2.1,
      exclusionReasons: [],
      position: 1,
    }).formulaVersion).toBe('popular-v1')
    expect(decodeRegistryOperationResult({
      requestId: 'approve.fixture.registry-plugin.1.2.3',
      code: 'version-approved',
      pluginId: 'fixture.registry-plugin',
      version: '1.2.3',
    }).code).toBe('version-approved')
    expect(decodeRegistryErrorResult({
      error: { code: 'immutable-conflict', message: 'Exact version already exists.', requestId: 'req-1' },
    }).error.code).toBe('immutable-conflict')
    expect(decodeRegistryHealthResult({ status: 'ok', database: 'ready', currentCatalog: true }).status).toBe('ok')
  })
})
