/** Bundled verified fixture used until the catalog operator service ships in F006. */

import {
  decodeCatalogSnapshot,
  type CatalogArtifactEvidence,
  type CatalogSnapshot,
  type CatalogSummary,
  type CatalogVersionPreflight,
} from '@deepseek-ai/dsh-plugin-center-contracts'

const CATALOG_ETAG = 'bundled-f003-2026-08-15'

const COMPATIBILITY = {
  status: 'compatible',
  reason: null,
  platforms: ['darwin-arm64', 'win32-x64'],
} as const

const WORKSPACE_TOOLS = {
  pluginId: 'fixture.workspace-tools',
  version: '0.1.0-rc.5',
  catalogKind: 'plugin',
  scope: 'public',
  displayName: '工作区效率工具',
  summary: '用于验证插件发现、搜索与详情流程的内置示例 Bundle。',
  publisher: 'DeepSeek Harness Fixture',
  verified: true,
  keywords: ['workspace', 'tools', '工作区', '效率'],
  capabilities: ['host', 'client', 'tool'],
  icon: null,
  brandColor: '#5B8CFF',
  compatibility: COMPATIBILITY,
  updatedAt: '2026-08-15T03:00:00.000Z',
  installed: false,
} as const satisfies CatalogSummary

const SKILL_PACK = {
  pluginId: 'fixture.skill-pack',
  version: '0.1.0-rc.5',
  catalogKind: 'skill-pack',
  scope: 'public',
  displayName: 'Harness 基础技能包',
  summary: '以 DSH Bundle 封装的示例 Skill Pack，用于验证技能发现链路。',
  publisher: 'DeepSeek Harness Fixture',
  verified: true,
  keywords: ['skill', 'skills', '技能', 'bundle'],
  capabilities: ['skill'],
  icon: null,
  brandColor: '#8B5CF6',
  compatibility: COMPATIBILITY,
  updatedAt: '2026-08-15T02:00:00.000Z',
  installed: false,
} as const satisfies CatalogSummary

const LOCAL_BUNDLE = {
  pluginId: 'local.developer-bundle',
  version: '0.1.0',
  catalogKind: 'plugin',
  scope: 'local',
  displayName: '本地开发 Bundle',
  summary: '从当前 Profile 投影出的本地示例；F001 仅展示，不提供变更动作。',
  publisher: 'Local profile',
  verified: false,
  keywords: ['local', 'profile', '本地'],
  capabilities: ['host'],
  icon: null,
  brandColor: '#64748B',
  compatibility: { ...COMPATIBILITY, status: 'unknown', reason: '本地 Bundle 未经过目录审核。' },
  updatedAt: '2026-08-15T01:00:00.000Z',
  installed: true,
} as const satisfies CatalogSummary

function detail(
  summary: CatalogSummary,
  values: {
    readonly description: string
    readonly permissions: readonly string[]
    readonly riskSummary: string
    readonly expectedEntries: readonly string[]
    readonly expectedClientModules: readonly string[]
    readonly expectedSkillIds: readonly string[]
    readonly eligible: boolean
  },
) {
  return {
    summary,
    description: values.description,
    screenshots: [],
    permissions: values.permissions,
    riskLevel: summary.scope === 'local' ? 'medium' : 'low',
    riskSummary: values.riskSummary,
    changelog: '首个用于插件中心发现闭环的确定版本。',
    publishedAt: summary.updatedAt,
    expectedEntries: values.expectedEntries,
    expectedClientModules: values.expectedClientModules,
    expectedSkillIds: values.expectedSkillIds,
    eligible: values.eligible,
    withdrawn: false,
  }
}

function preflight(
  summary: CatalogSummary,
  packageName: string,
  values: {
    readonly riskSummary: string
    readonly expectedEntries: readonly string[]
    readonly expectedClientModules: readonly string[]
    readonly expectedSkillIds: readonly string[]
    readonly eligible: boolean
    readonly artifact?: {
      readonly sha256: string
      readonly integrity: string
      readonly packedBytes: number
      readonly unpackedBytes: number
      readonly fileCount: number
    }
  },
): CatalogVersionPreflight {
  const artifact = values.artifact
  const artifacts: readonly CatalogArtifactEvidence[] = summary.scope === 'public' && artifact !== undefined
    ? (['darwin-arm64', 'win32-x64'] as const).map(platform => ({
      platform,
      url: `https://cdn.deepseek.com/plugins/${summary.pluginId}/${summary.version}/${platform}.tgz`,
      ...artifact,
    }))
    : []
  return {
    pluginId: summary.pluginId,
    version: summary.version,
    packageName,
    catalogEtag: CATALOG_ETAG,
    reviewed: summary.verified,
    eligible: values.eligible,
    withdrawn: false,
    desktopRange: '>=0.1.0-rc.1 <0.2.0',
    dshRange: '>=0.1.0-rc.1 <0.2.0',
    nodeRange: '>=22.19 <25',
    artifacts,
    bundlePatch: './cordis.patch.yml',
    capabilities: summary.capabilities,
    riskLevel: summary.scope === 'local' ? 'medium' : 'low',
    riskSummary: values.riskSummary,
    executionAuthority: 'broad-application-authority',
    conflicts: { pluginIds: [], packageNames: [], entryIds: [] },
    expectedEntries: values.expectedEntries,
    expectedClientModules: values.expectedClientModules,
    expectedSkillIds: values.expectedSkillIds,
    supportedActions: summary.scope === 'public' ? ['install', 'update', 'enable', 'disable', 'uninstall'] : [],
    restartRequired: true,
  }
}

/** Product-owned fixture is decoded through the same strict boundary as remote data. */
export const BUNDLED_CATALOG: CatalogSnapshot = decodeCatalogSnapshot({
  schemaVersion: 1,
  etag: CATALOG_ETAG,
  generatedAt: '2026-08-15T04:00:00.000Z',
  maxAgeSeconds: 86_400,
  sections: {
    featured: [WORKSPACE_TOOLS.pluginId, SKILL_PACK.pluginId],
    popular: [SKILL_PACK.pluginId, WORKSPACE_TOOLS.pluginId],
    recent: [WORKSPACE_TOOLS.pluginId, SKILL_PACK.pluginId],
  },
  entries: [WORKSPACE_TOOLS, SKILL_PACK, LOCAL_BUNDLE],
  details: [
    detail(WORKSPACE_TOOLS, {
      description: '受审查的安装测试 Bundle；安装后会激活一个 Host 条目，并在侧边栏提供可见的“工作区工具”页面。',
      permissions: ['读取用户明确选择的工作区。'],
      riskSummary: '该条目是内置已审核 fixture；“已验证”不代表进程隔离。',
      expectedEntries: ['fixture.workspace-tools'],
      expectedClientModules: ['@deepseek-ai/dsh-plugin-center-fixture'],
      expectedSkillIds: [],
      eligible: true,
    }),
    detail(SKILL_PACK, {
      description: '展示 Skill Pack 如何继续作为一个 DSH Bundle 进入同一目录与后续事务，而不是接受任意 Skill 文件夹或 Git 仓库。',
      permissions: ['安装后向 Harness 注册已审核 Skill 定义。'],
      riskSummary: '该 Skill Pack 复用插件兼容与安装边界，不产生第二套安装权威。',
      expectedEntries: ['fixture.harness-basics-provider'],
      expectedClientModules: [],
      expectedSkillIds: ['fixture-harness-basics'],
      eligible: true,
    }),
    detail(LOCAL_BUNDLE, {
      description: '本地 Profile 示例，仅用于验证本地范围和不受目录管理的只读状态。',
      permissions: ['权限信息由本地作者自行负责。'],
      riskSummary: '本地条目未经目录审核，插件中心不会为它提供安装或卸载授权。',
      expectedEntries: ['local.developer-bundle'],
      expectedClientModules: [],
      expectedSkillIds: [],
      eligible: false,
    }),
  ],
  preflights: [
    preflight(WORKSPACE_TOOLS, '@deepseek-ai/dsh-plugin-center-fixture', {
      riskSummary: '该条目是内置已审核 fixture；“已验证”不代表进程隔离。',
      expectedEntries: ['fixture.workspace-tools'],
      expectedClientModules: ['@deepseek-ai/dsh-plugin-center-fixture'],
      expectedSkillIds: [],
      eligible: true,
      artifact: {
        sha256: 'c7ed790a74a9ba74fa5c9037642a3233fe67a2624a84c8bd368452c09b205e81',
        integrity: 'sha512-nI72LPDEDLQflFIbq7/kxh889TvJMpGkSslu+Vwq1+Xs1LbknlUHl5UWyJX6dhE7jsh9BzohvghCWjgowWxC3Q==',
        packedBytes: 4_368,
        unpackedBytes: 10_450,
        fileCount: 13,
      },
    }),
    preflight(SKILL_PACK, '@deepseek-ai/dsh-plugin-center-skill-fixture', {
      riskSummary: '该 Skill Pack 复用插件兼容与安装边界，不产生第二套安装权威。',
      expectedEntries: ['fixture.harness-basics-provider'],
      expectedClientModules: [],
      expectedSkillIds: ['fixture-harness-basics'],
      eligible: true,
      artifact: {
        sha256: 'c7cea08358a5b64e1944c9ec49c436eda16c84e78151bb5e52d58bcba36492c2',
        integrity: 'sha512-4vw9vM5HEnp0ZaSBY8hQGENODss4lCK528McFoz0kheqjqb+KxBNAXr+Tr+bKTF+bP/2stTUiyttQjn2eZZVRA==',
        packedBytes: 3_064,
        unpackedBytes: 5_887,
        fileCount: 10,
      },
    }),
    preflight(LOCAL_BUNDLE, '@local/developer-bundle', {
      riskSummary: '本地条目未经目录审核，插件中心不会为它提供安装或卸载授权。',
      expectedEntries: ['local.developer-bundle'],
      expectedClientModules: [],
      expectedSkillIds: [],
      eligible: false,
    }),
  ],
})
