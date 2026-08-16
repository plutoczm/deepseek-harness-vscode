import { describe, expect, it } from 'vitest'
import {
  CatalogContractError,
  decodeInstalledPluginListResult,
  decodePluginManagementRequest,
  decodePluginOwnedDataOffer,
  decodePluginOwnedDataRemovalRequest,
  decodePluginOwnedDataRemovalResult,
  decodePluginOwnedDataRetentionRequest,
  decodePluginOwnedDataRetentionResult,
} from '../src/index.ts'

const CATALOG_ITEM = {
  pluginId: 'fixture.workspace-tools',
  packageName: '@fixture/dsh-workspace-tools',
  version: '1.2.3',
  displayName: 'Workspace tools',
  icon: {
    url: 'https://avatars.githubusercontent.com/fixture?s=128',
    alt: 'Fixture publisher avatar',
    width: 128,
    height: 128,
  },
  brandColor: '#2563EB',
  catalogKind: 'plugin',
  source: 'catalog',
  protected: false,
  enabled: false,
  bundleOrder: null,
  disabledOrder: 0,
  runtimeStatus: 'inactive',
  runtime: { entries: [], clientModules: [], skillIds: [] },
  expectedEntries: ['fixture.workspace-tools'],
  expectedClientModules: ['@fixture/dsh-client-ui-workspace-tools'],
  expectedSkillIds: [],
  compatibility: 'compatible',
  compatibilityReason: null,
  update: {
    version: '1.3.0',
    changelog: 'Adds reviewed workspace actions.',
    riskLevel: 'medium',
    riskSummary: 'Runs with broad application authority.',
  },
  pendingAction: null,
  supportedActions: ['update', 'enable', 'uninstall'],
  configurationEntryIds: ['fixture.workspace-tools'],
  ownedData: [{ path: 'cache/index.json', label: '索引缓存' }],
} as const

function installedResult() {
  return {
    profileName: 'web',
    profileRevision: 7,
    catalogFreshness: 'fresh',
    items: [CATALOG_ITEM, {
      ...CATALOG_ITEM,
      pluginId: null,
      packageName: '@local/developer-bundle',
      version: '0.1.0',
      displayName: '@local/developer-bundle',
      icon: null,
      brandColor: null,
      catalogKind: null,
      source: 'local',
      protected: false,
      enabled: true,
      bundleOrder: 3,
      disabledOrder: null,
      runtimeStatus: 'failed',
      compatibility: 'unknown',
      compatibilityReason: '未经过目录审核。',
      update: null,
      supportedActions: [],
      expectedClientModules: [],
      configurationEntryIds: [],
      ownedData: [],
    }],
  } as const
}

describe('installed management contract', () => {
  it('keeps package, Bundle, source, update, runtime, protection, and owned-data facts distinct', () => {
    expect(decodeInstalledPluginListResult(installedResult())).toEqual(installedResult())
    expect(decodePluginManagementRequest({
      pluginId: 'fixture.workspace-tools',
      version: '1.3.0',
      action: 'update',
      idempotencyKey: 'update:fixture.workspace-tools:1.3.0:019c',
    })).toEqual({
      pluginId: 'fixture.workspace-tools',
      version: '1.3.0',
      action: 'update',
      idempotencyKey: 'update:fixture.workspace-tools:1.3.0:019c',
    })
  })

  it('accepts the stable runtime identities emitted by the real Host inventory', () => {
    const item = {
      ...CATALOG_ITEM,
      enabled: true,
      bundleOrder: 0,
      disabledOrder: null,
      runtimeStatus: 'running',
      runtime: {
        entries: [
          { entryId: 'include:fixture.workspace-tools', enabled: true, fiberPhase: 'active' },
          { entryId: 'module:@deepseek-ai/dsh-host-directory-picker-native', enabled: true, fiberPhase: 'active' },
        ],
        clientModules: [],
        skillIds: [],
      },
    } as const

    expect(decodeInstalledPluginListResult({ ...installedResult(), items: [item] }).items[0]?.runtime.entries)
      .toEqual(item.runtime.entries)
  })

  it('requires separate exact confirmation for plugin-owned data', () => {
    const request = {
      operationId: '019c1234-1234-1234-1234-123456789abc',
      pluginId: 'fixture.workspace-tools',
      paths: ['cache/index.json'],
      confirmation: 'remove-owned-data',
    } as const
    expect(decodePluginOwnedDataRemovalRequest(request)).toEqual(request)
    expect(decodePluginOwnedDataRemovalResult({
      operationId: request.operationId,
      pluginId: request.pluginId,
      removedPaths: request.paths,
    })).toEqual({ operationId: request.operationId, pluginId: request.pluginId, removedPaths: request.paths })
    expect(() => decodePluginOwnedDataRemovalRequest({ ...request, paths: ['../workspace'] }))
      .toThrow(CatalogContractError)
    expect(() => decodePluginOwnedDataRemovalRequest({ ...request, confirmation: 'yes' }))
      .toThrow(CatalogContractError)
  })

  it('restores and durably closes one committed-uninstall owned-data offer', () => {
    const offer = {
      operationId: '019c1234-1234-1234-1234-123456789abc',
      pluginId: 'fixture.workspace-tools',
      packageName: '@fixture/dsh-workspace-tools',
      version: '1.2.3',
      declarations: [{ path: 'cache/index.json', label: '索引缓存' }],
    } as const
    expect(decodePluginOwnedDataOffer(offer)).toEqual(offer)
    expect(() => decodePluginOwnedDataOffer({ ...offer, declarations: [...offer.declarations, ...offer.declarations] }))
      .toThrow(CatalogContractError)

    const request = {
      operationId: offer.operationId,
      pluginId: offer.pluginId,
      confirmation: 'retain-owned-data',
    } as const
    expect(decodePluginOwnedDataRetentionRequest(request)).toEqual(request)
    expect(decodePluginOwnedDataRetentionResult({
      operationId: offer.operationId,
      pluginId: offer.pluginId,
      retained: true,
    })).toEqual({ operationId: offer.operationId, pluginId: offer.pluginId, retained: true })
    expect(() => decodePluginOwnedDataRetentionRequest({ ...request, confirmation: 'yes' }))
      .toThrow(CatalogContractError)
  })

  it.each([
    ['active and disabled overlap', { ...CATALOG_ITEM, enabled: true, bundleOrder: 2 }],
    ['local mutation authority', { ...CATALOG_ITEM, source: 'local' }],
    ['absolute owned path', { ...CATALOG_ITEM, ownedData: [{ path: '/tmp/cache', label: 'cache' }] }],
    ['unapproved icon origin', {
      ...CATALOG_ITEM,
      icon: { ...CATALOG_ITEM.icon, url: 'https://example.com/icon.png' },
    }],
  ])('rejects %s', (_name, item) => {
    expect(() => decodeInstalledPluginListResult({ ...installedResult(), items: [item] }))
      .toThrow(CatalogContractError)
  })
})
