import type {
  CatalogDetail,
  CatalogDetailResult,
  CatalogKind,
  CatalogListQuery,
  CatalogListResult,
  CatalogScope,
  CatalogSummary,
  CompatibilityDecision,
  InstalledPluginListResult,
  PluginOperationPhase,
  PluginOperationSnapshot,
} from '@deepseek-ai/dsh-plugin-center-contracts'

export function installedListResult(): InstalledPluginListResult {
  return {
    profileName: 'web',
    profileRevision: 7,
    catalogFreshness: 'fresh',
    items: [
      {
        pluginId: null,
        packageName: '@deepseek-ai/dsh-web-app',
        version: '1.0.0',
        displayName: 'Harness system',
        icon: null,
        brandColor: null,
        catalogKind: null,
        source: 'system',
        protected: true,
        enabled: true,
        bundleOrder: 0,
        disabledOrder: null,
        runtimeStatus: 'running',
        runtime: {
          entries: [{ entryId: 'agent-loop', enabled: true, fiberPhase: 'active' }],
          clientModules: [],
          skillIds: [],
        },
        expectedEntries: ['agent-loop'],
        expectedClientModules: [],
        expectedSkillIds: [],
        compatibility: 'compatible',
        compatibilityReason: 'Protected by the Desktop release.',
        update: null,
        pendingAction: null,
        supportedActions: [],
        configurationEntryIds: ['agent-loop'],
        ownedData: [],
      },
      {
        pluginId: 'fixture.workspace-tools',
        packageName: '@fixture/workspace-tools',
        version: '1.0.0',
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
        enabled: true,
        bundleOrder: 1,
        disabledOrder: null,
        runtimeStatus: 'running',
        runtime: {
          entries: [{ entryId: 'fixture.workspace-tools', enabled: true, fiberPhase: 'active' }],
          clientModules: ['@fixture/workspace-tools/client'],
          skillIds: [],
        },
        expectedEntries: ['fixture.workspace-tools'],
        expectedClientModules: ['@fixture/workspace-tools/client'],
        expectedSkillIds: [],
        compatibility: 'compatible',
        compatibilityReason: null,
        update: {
          version: '1.1.0',
          changelog: 'Adds reviewed workspace actions.',
          riskLevel: 'medium',
          riskSummary: 'Adds file write authority.',
        },
        pendingAction: null,
        supportedActions: ['update', 'disable', 'uninstall'],
        configurationEntryIds: ['fixture.workspace-tools'],
        ownedData: [{ path: 'cache', label: 'Workspace cache' }],
      },
      {
        pluginId: 'fixture.skill-pack',
        packageName: '@fixture/skill-pack',
        version: '1.0.0',
        displayName: 'Harness basics',
        icon: null,
        brandColor: '#7C3AED',
        catalogKind: 'skill-pack',
        source: 'catalog',
        protected: false,
        enabled: false,
        bundleOrder: null,
        disabledOrder: 0,
        runtimeStatus: 'inactive',
        runtime: { entries: [], clientModules: [], skillIds: [] },
        expectedEntries: ['fixture.skill-pack'],
        expectedClientModules: [],
        expectedSkillIds: ['fixture-harness-basics'],
        compatibility: 'incompatible',
        compatibilityReason: 'desktop-version-unsupported: desktopVersion',
        update: null,
        pendingAction: null,
        supportedActions: ['uninstall'],
        configurationEntryIds: [],
        ownedData: [],
      },
      {
        pluginId: null,
        packageName: '@local/developer-bundle',
        version: '0.1.0',
        displayName: 'Local developer Bundle',
        icon: null,
        brandColor: null,
        catalogKind: null,
        source: 'local',
        protected: false,
        enabled: true,
        bundleOrder: 2,
        disabledOrder: null,
        runtimeStatus: 'failed',
        runtime: {
          entries: [{ entryId: 'local.developer-bundle', enabled: true, fiberPhase: 'failed' }],
          clientModules: [],
          skillIds: [],
        },
        expectedEntries: ['local.developer-bundle'],
        expectedClientModules: [],
        expectedSkillIds: [],
        compatibility: 'unknown',
        compatibilityReason: 'Local source has no catalog authority.',
        update: null,
        pendingAction: null,
        supportedActions: [],
        configurationEntryIds: ['local.developer-bundle'],
        ownedData: [],
      },
    ],
  }
}

export function summary(
  catalogKind: CatalogKind = 'plugin',
  scope: CatalogScope = 'public',
): CatalogSummary {
  const skill = catalogKind === 'skill-pack'
  return {
    pluginId: skill ? 'fixture.skill-pack' : scope === 'local' ? 'local.developer-bundle' : 'fixture.workspace-tools',
    version: skill ? '0.2.0' : '1.0.0',
    catalogKind,
    scope,
    displayName: skill ? 'Harness basics' : scope === 'local' ? 'Local developer Bundle' : 'Workspace tools',
    summary: skill ? 'Reviewed Skill Bundle.' : 'Reviewed workspace utilities.',
    publisher: skill || scope === 'public' ? 'Harness Fixture' : 'Local profile',
    verified: scope === 'public',
    keywords: skill ? ['skill'] : ['workspace'],
    capabilities: skill ? ['skill'] : ['host', 'client'],
    icon: scope === 'public' ? {
      url: 'https://avatars.githubusercontent.com/fixture?s=128',
      alt: 'Fixture publisher avatar',
      width: 128,
      height: 128,
    } : null,
    brandColor: skill ? '#8B5CF6' : '#5B8CFF',
    compatibility: {
      status: scope === 'local' ? 'unknown' : 'compatible',
      reason: scope === 'local' ? 'Local source has no catalog decision.' : null,
      platforms: ['darwin-arm64'],
    },
    updatedAt: '2026-08-15T04:00:00.000Z',
    installed: scope === 'local',
  }
}

export function listResult(query: CatalogListQuery, freshness: CatalogListResult['freshness'] = 'fresh'): CatalogListResult {
  const entry = summary(query.catalogKind, query.scope)
  const matches = query.query === '' || entry.displayName.toLocaleLowerCase().includes(query.query.toLocaleLowerCase())
  const entries = matches ? [entry] : []
  return {
    etag: 'fixture-v1',
    generatedAt: '2026-08-15T04:00:00.000Z',
    freshness,
    source: freshness === 'fresh' ? 'network' : 'cache',
    sections: {
      featured: entries,
      popular: query.scope === 'public' ? entries : [],
      recent: query.scope === 'public' ? entries : [],
    },
  }
}

export function detail(entry: CatalogSummary = summary()): CatalogDetail {
  return {
    summary: entry,
    description: 'Complete fixture detail.',
    screenshots: [],
    permissions: ['Reads the selected workspace.'],
    riskLevel: 'low',
    riskSummary: 'Reviewed but not sandboxed.',
    changelog: 'Initial exact version.',
    publishedAt: entry.updatedAt,
    expectedEntries: ['fixture.workspace-tools'],
    expectedClientModules: ['@fixture/client'],
    expectedSkillIds: [],
    eligible: entry.scope === 'public',
    withdrawn: false,
  }
}

export function detailResult(value: CatalogDetail | null): CatalogDetailResult {
  return {
    etag: 'fixture-v1',
    generatedAt: '2026-08-15T04:00:00.000Z',
    freshness: 'fresh',
    source: 'network',
    detail: value,
  }
}

export function compatibilityDecision(
  overrides: Partial<CompatibilityDecision> = {},
): CompatibilityDecision {
  return {
    pluginId: 'fixture.workspace-tools',
    version: '1.0.0',
    action: 'install',
    allowed: true,
    fingerprint: {
      desktopVersion: '0.1.0-rc.5',
      dshVersion: '0.1.0-rc.5',
      nodeVersion: '22.22.0',
      platform: 'darwin-arm64',
      catalogEtag: 'fixture-v1',
      catalogFreshness: 'fresh',
      profileRevision: 7,
      installedPlugins: [],
      protectedPackageNames: ['@deepseek-ai/dsh-base'],
      protectedEntryIds: ['agent-loop'],
      activeOperation: false,
    },
    reasons: [],
    restartRequired: true,
    capabilities: ['host', 'client'],
    riskLevel: 'low',
    riskSummary: 'Reviewed but not sandboxed.',
    executionAuthority: 'broad-application-authority',
    ...overrides,
  }
}

export function operation(phase: PluginOperationPhase = 'preflight'): PluginOperationSnapshot {
  return {
    schemaVersion: 1,
    operationId: 'operation-1',
    idempotencyKey: 'install:fixture.workspace-tools:1',
    profileName: 'web',
    action: 'install',
    pluginId: 'fixture.workspace-tools',
    version: '1.0.0',
    phase,
    startedAt: '2026-08-15T05:00:00.000Z',
    updatedAt: phase === 'preflight' ? '2026-08-15T05:00:00.000Z' : '2026-08-15T05:00:01.000Z',
    hostGeneration: phase === 'reloading' || phase === 'health-checking'
      || phase === 'verifying-runtime' || phase === 'committed' ? 2 : null,
    failureCode: phase === 'failed' ? 'internal' : null,
  }
}
