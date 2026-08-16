/** Deterministic browser-only catalog used by the dedicated development command. */

import type {
  CompatibilityDecision,
  CompatibilityRequest,
  CatalogDetail,
  CatalogDetailQuery,
  CatalogDetailResult,
  CatalogListQuery,
  CatalogListResult,
  CatalogSection,
  CatalogSummary,
  InstalledPluginListResult,
  PluginInstallRequest,
  PluginManagementRequest,
  PluginMutationRequest,
  PluginOperationPhase,
  PluginOperationSnapshot,
  PluginOperationStartResult,
  PluginOwnedDataRemovalRequest,
  PluginOwnedDataRemovalResult,
  PluginDiagnosticExportRequest,
  PluginDiagnosticExportResult,
  PluginRecoveryRetryRequest,
  PluginRecoverySnapshot,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import { COMPATIBILITY_ACTIONS } from '@deepseek-ai/dsh-plugin-center-contracts'
import type { DesktopCatalogBridge } from './bridge.ts'
import { PLUGIN_OPERATION_PHASES, isTrustedInstallPhase } from './operation-phases.ts'

type DevelopmentScenario = 'normal' | 'empty' | 'stale' | 'compatibility-denied' | 'error'

const GENERATED_AT = '2026-08-15T04:00:00.000Z'
const ETAG = 'web-development-f003-v1'
const OPERATION_STORAGE_KEY = 'dsh.plugin-center.development-operation.v1'
const INSTALLED_STORAGE_KEY = 'dsh.plugin-center.development-installed.v1'
const OPERATION_INTERVAL_MS = 180

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
  compatibility: {
    status: 'compatible',
    reason: null,
    platforms: ['darwin-arm64', 'win32-x64'],
  },
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
  compatibility: {
    status: 'compatible',
    reason: null,
    platforms: ['darwin-arm64', 'win32-x64'],
  },
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
  compatibility: {
    status: 'unknown',
    reason: '本地 Bundle 未经过目录审核。',
    platforms: ['darwin-arm64', 'win32-x64'],
  },
  updatedAt: '2026-08-15T01:00:00.000Z',
  installed: true,
} as const satisfies CatalogSummary

const ENTRIES: readonly CatalogSummary[] = [WORKSPACE_TOOLS, SKILL_PACK, LOCAL_BUNDLE]
const SECTION_IDS: Readonly<Record<CatalogSection, readonly string[]>> = {
  featured: [WORKSPACE_TOOLS.pluginId, SKILL_PACK.pluginId],
  popular: [SKILL_PACK.pluginId, WORKSPACE_TOOLS.pluginId],
  recent: [WORKSPACE_TOOLS.pluginId, SKILL_PACK.pluginId],
}

function detail(
  summary: CatalogSummary,
  values: Pick<CatalogDetail, 'description' | 'permissions' | 'riskSummary' | 'expectedEntries' | 'expectedClientModules' | 'expectedSkillIds' | 'eligible'>,
): CatalogDetail {
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

const DETAILS: readonly CatalogDetail[] = [
  detail(WORKSPACE_TOOLS, {
    description: '展示普通插件的确定版本、发布者、能力、兼容性与风险信息；Web 开发模式不会修改当前 Profile。',
    permissions: ['读取用户明确选择的工作区。'],
    riskSummary: '该条目是开发 fixture；“已验证”不代表进程隔离。',
    expectedEntries: ['fixture.workspace-tools'],
    expectedClientModules: ['@fixture/dsh-client-ui-workspace-tools'],
    expectedSkillIds: [],
    eligible: true,
  }),
  detail(SKILL_PACK, {
    description: '展示 Skill Pack 如何作为一个 DSH Bundle 进入同一目录与后续事务。',
    permissions: ['安装后向 Harness 注册已审核 Skill 定义。'],
    riskSummary: '该 Skill Pack 复用插件兼容与安装边界，不产生第二套安装权威。',
    expectedEntries: [],
    expectedClientModules: [],
    expectedSkillIds: ['fixture.harness-basics'],
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
]

function scenario(): DevelopmentScenario {
  const value = new URLSearchParams(globalThis.location.search).get('pluginCenterScenario')
  return value === 'empty' || value === 'stale' || value === 'compatibility-denied' || value === 'error'
    ? value
    : 'normal'
}

function matches(entry: CatalogSummary, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  return needle.length === 0 || [entry.displayName, entry.summary, entry.publisher, ...entry.keywords]
    .some(value => value.toLocaleLowerCase().includes(needle))
}

function listResult(
  query: CatalogListQuery,
  selected: DevelopmentScenario,
  installed: DevelopmentInstalledRuntime,
): CatalogListResult {
  const entries = selected === 'empty'
    ? []
    : ENTRIES.filter(entry =>
      entry.catalogKind === query.catalogKind
      && entry.scope === query.scope
      && matches(entry, query.query),
    ).map(entry => ({ ...entry, installed: installed.has(entry.pluginId, entry.version) }))
  const byId = new Map(entries.map(entry => [entry.pluginId, entry]))
  const project = (section: CatalogSection): readonly CatalogSummary[] => {
    const ordered = query.scope === 'local'
      ? entries
      : SECTION_IDS[section].flatMap((pluginId) => {
        const entry = byId.get(pluginId)
        return entry === undefined ? [] : [entry]
      })
    return ordered.slice(0, query.limit)
  }
  const freshness = selected === 'stale' ? 'stale' : 'fresh'
  return {
    etag: ETAG,
    generatedAt: GENERATED_AT,
    freshness,
    source: freshness === 'stale' ? 'cache' : 'bundled',
    sections: {
      featured: project('featured'),
      popular: query.scope === 'local' ? [] : project('popular'),
      recent: query.scope === 'local' ? [] : project('recent'),
    },
  }
}

function detailResult(query: CatalogDetailQuery, selected: DevelopmentScenario): CatalogDetailResult {
  const found = selected === 'empty'
    ? null
    : DETAILS.find(item => item.summary.pluginId === query.pluginId && item.summary.version === query.version) ?? null
  const freshness = selected === 'stale' ? 'stale' : 'fresh'
  return {
    etag: ETAG,
    generatedAt: GENERATED_AT,
    freshness,
    source: freshness === 'stale' ? 'cache' : 'bundled',
    detail: found,
  }
}

function compatibilityDecision(value: CompatibilityRequest, selected: DevelopmentScenario): CompatibilityDecision {
  const request = value
  const found = selected === 'empty'
    ? undefined
    : DETAILS.find(item => item.summary.pluginId === request.pluginId && item.summary.version === request.version)
  const catalogFreshness = selected === 'stale' ? 'stale' : 'fresh'
  const fingerprint = {
    desktopVersion: '0.1.0-rc.5',
    dshVersion: '0.1.0-rc.5',
    nodeVersion: '22.22.0',
    platform: 'darwin-arm64',
    catalogEtag: ETAG,
    catalogFreshness,
    profileRevision: 7,
    installedPlugins: [],
    protectedPackageNames: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    protectedEntryIds: ['agent-loop', 'ui-plugin-center'],
    activeOperation: false,
  } as const
  const reasons = found === undefined
    ? [{
      code: 'catalog-metadata-invalid' as const,
      subject: `${request.pluginId}@${request.version}`,
      actual: 'missing',
      expected: 'reviewed exact catalog version',
    }]
    : selected === 'compatibility-denied'
      ? [
        {
          code: 'desktop-version-unsupported' as const,
          subject: 'desktopVersion',
          actual: fingerprint.desktopVersion,
          expected: '>=0.2.0',
        },
        {
          code: 'platform-unsupported' as const,
          subject: fingerprint.platform,
          actual: fingerprint.platform,
          expected: 'win32-x64',
        },
      ]
      : selected === 'stale'
        ? [{
          code: 'version-ineligible' as const,
          subject: 'catalogFreshness',
          actual: 'stale',
          expected: 'fresh-or-cached',
        }]
        : !found.summary.verified || !found.eligible
          ? [
            ...(!found.summary.verified ? [{
              code: 'catalog-unverified' as const,
              subject: request.pluginId,
              actual: 'false',
              expected: 'true',
            }] : []),
            ...(!found.eligible ? [{
              code: 'version-ineligible' as const,
              subject: request.version,
              actual: 'false',
              expected: 'true',
            }] : []),
            {
              code: 'action-not-supported' as const,
              subject: request.action,
              actual: 'not-installed',
              expected: null,
            },
          ]
          : request.action !== 'install'
            ? [{
              code: 'action-not-supported' as const,
              subject: request.action,
              actual: 'not-installed',
              expected: null,
            }]
            : []
  return {
    pluginId: request.pluginId,
    version: request.version,
    action: request.action,
    allowed: reasons.length === 0,
    fingerprint,
    reasons,
    restartRequired: found?.summary.scope === 'public',
    capabilities: found?.summary.capabilities ?? [],
    riskLevel: found?.riskLevel ?? 'high',
    riskSummary: found?.riskSummary ?? 'Reviewed risk metadata is unavailable for this exact version.',
    executionAuthority: 'broad-application-authority',
  }
}

interface DevelopmentInstalledState {
  readonly revision: number
  readonly workspaceVersion: string | null
  readonly workspaceEnabled: boolean
  readonly skillInstalled: boolean
  readonly skillEnabled: boolean
}

/** Session-backed browser fixture for cumulative install and management journeys. */
class DevelopmentInstalledRuntime {
  private state: DevelopmentInstalledState

  constructor() {
    this.state = this.readStored()
  }

  has(pluginId: string, version: string): boolean {
    if (pluginId === WORKSPACE_TOOLS.pluginId) return this.state.workspaceVersion === version
    if (pluginId === SKILL_PACK.pluginId) return this.state.skillInstalled && version === SKILL_PACK.version
    return pluginId === LOCAL_BUNDLE.pluginId
  }

  commit(operation: PluginOperationSnapshot): void {
    if (operation.phase !== 'committed') return
    const before = this.state
    let next = before
    if (operation.pluginId === WORKSPACE_TOOLS.pluginId) {
      if (operation.action === 'install') next = { ...before, workspaceVersion: operation.version, workspaceEnabled: true }
      else if (operation.action === 'update' && before.workspaceVersion !== null) {
        next = { ...before, workspaceVersion: operation.version }
      } else if (operation.action === 'enable' && before.workspaceVersion !== null) {
        next = { ...before, workspaceEnabled: true }
      } else if (operation.action === 'disable' && before.workspaceVersion !== null) {
        next = { ...before, workspaceEnabled: false }
      } else if (operation.action === 'uninstall') {
        next = { ...before, workspaceVersion: null, workspaceEnabled: false }
      }
    } else if (operation.pluginId === SKILL_PACK.pluginId) {
      if (operation.action === 'enable') next = { ...before, skillInstalled: true, skillEnabled: true }
      else if (operation.action === 'disable') next = { ...before, skillInstalled: true, skillEnabled: false }
      else if (operation.action === 'uninstall') next = { ...before, skillInstalled: false, skillEnabled: false }
    }
    if (JSON.stringify(next) === JSON.stringify(before)) return
    this.state = { ...next, revision: before.revision + 1 }
    try { globalThis.sessionStorage.setItem(INSTALLED_STORAGE_KEY, JSON.stringify(this.state)) } catch {}
  }

  result(operation: PluginOperationSnapshot | null): InstalledPluginListResult {
    const pending = operation !== null && !isTerminal(operation.phase) ? operation : null
    const workspaceInstalled = this.state.workspaceVersion !== null
    const workspaceEnabled = this.state.workspaceEnabled
    const skillEnabled = this.state.skillEnabled
    const appUpdateIncompatible = scenario() === 'compatibility-denied'
    const activeCatalogCount = Number(workspaceInstalled && workspaceEnabled) + Number(this.state.skillInstalled && skillEnabled)
    return {
      profileName: 'web',
      profileRevision: this.state.revision,
      catalogFreshness: scenario() === 'stale' ? 'stale' : 'fresh',
      items: [
        {
          pluginId: null,
          packageName: '@deepseek-ai/dsh-web-app',
          version: '0.1.0-rc.5',
          displayName: 'Harness Web 系统组件',
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
            entries: [{ entryId: 'ui-plugin-center', enabled: true, fiberPhase: 'active' }],
            clientModules: [],
            skillIds: [],
          },
          expectedEntries: ['ui-plugin-center'],
          expectedClientModules: [],
          expectedSkillIds: [],
          compatibility: 'compatible',
          compatibilityReason: '系统组件由当前桌面发行版保护。',
          update: null,
          pendingAction: null,
          supportedActions: [],
          configurationEntryIds: ['ui-plugin-center'],
          ownedData: [],
        },
        ...workspaceInstalled ? [{
          pluginId: WORKSPACE_TOOLS.pluginId,
          packageName: '@deepseek-ai/dsh-plugin-center-fixture',
          version: this.state.workspaceVersion,
          displayName: WORKSPACE_TOOLS.displayName,
          icon: WORKSPACE_TOOLS.icon,
          brandColor: WORKSPACE_TOOLS.brandColor,
          catalogKind: WORKSPACE_TOOLS.catalogKind,
          source: 'catalog' as const,
          protected: false,
          enabled: workspaceEnabled,
          bundleOrder: workspaceEnabled ? 1 : null,
          disabledOrder: workspaceEnabled ? null : 0,
          runtimeStatus: workspaceEnabled ? 'running' as const : 'inactive' as const,
          runtime: workspaceEnabled ? {
            entries: [{ entryId: 'fixture.workspace-tools', enabled: true, fiberPhase: 'active' }],
            clientModules: ['@deepseek-ai/dsh-plugin-center-fixture'],
            skillIds: [],
          } : { entries: [], clientModules: [], skillIds: [] },
          expectedEntries: ['fixture.workspace-tools'],
          expectedClientModules: ['@deepseek-ai/dsh-plugin-center-fixture'],
          expectedSkillIds: [],
          compatibility: 'compatible' as const,
          compatibilityReason: null,
          update: this.state.workspaceVersion === WORKSPACE_TOOLS.version ? {
            version: '0.1.0-rc.6',
            changelog: '新增一组经过审核的工作区批量操作。',
            riskLevel: 'medium' as const,
            riskSummary: '新版本新增文件写入能力，仍在应用进程中运行。',
          } : null,
          pendingAction: pending?.pluginId === WORKSPACE_TOOLS.pluginId ? pending.action : null,
          supportedActions: [
            ...this.state.workspaceVersion === WORKSPACE_TOOLS.version ? ['update' as const] : [],
            workspaceEnabled ? 'disable' as const : 'enable' as const,
            'uninstall' as const,
          ],
          configurationEntryIds: ['fixture.workspace-tools'],
          ownedData: [{ path: 'cache', label: '工作区缓存' }],
        }] : [],
        ...this.state.skillInstalled ? [{
          pluginId: SKILL_PACK.pluginId,
          packageName: '@deepseek-ai/dsh-plugin-center-skill-fixture',
          version: SKILL_PACK.version,
          displayName: SKILL_PACK.displayName,
          icon: SKILL_PACK.icon,
          brandColor: SKILL_PACK.brandColor,
          catalogKind: SKILL_PACK.catalogKind,
          source: 'catalog' as const,
          protected: false,
          enabled: skillEnabled,
          bundleOrder: skillEnabled ? 1 + Number(workspaceInstalled && workspaceEnabled) : null,
          disabledOrder: skillEnabled ? null : Number(workspaceInstalled && !workspaceEnabled),
          runtimeStatus: skillEnabled ? 'running' as const : 'inactive' as const,
          runtime: skillEnabled ? {
            entries: [{ entryId: 'fixture.harness-basics-provider', enabled: true, fiberPhase: 'active' }],
            clientModules: [],
            skillIds: ['fixture-harness-basics'],
          } : { entries: [], clientModules: [], skillIds: [] },
          expectedEntries: ['fixture.harness-basics-provider'],
          expectedClientModules: [],
          expectedSkillIds: ['fixture-harness-basics'],
          compatibility: appUpdateIncompatible ? 'incompatible' as const : 'compatible' as const,
          compatibilityReason: appUpdateIncompatible
            ? 'desktop-version-unsupported: desktopVersion'
            : null,
          update: null,
          pendingAction: pending?.pluginId === SKILL_PACK.pluginId ? pending.action : null,
          supportedActions: [
            ...appUpdateIncompatible ? [] : [skillEnabled ? 'disable' as const : 'enable' as const],
            'uninstall' as const,
          ],
          configurationEntryIds: ['fixture.harness-basics-provider'],
          ownedData: [],
        }] : [],
        {
          pluginId: null,
          packageName: '@local/developer-bundle',
          version: '0.1.0',
          displayName: LOCAL_BUNDLE.displayName,
          icon: LOCAL_BUNDLE.icon,
          brandColor: LOCAL_BUNDLE.brandColor,
          catalogKind: null,
          source: 'local' as const,
          protected: false,
          enabled: true,
          bundleOrder: 1 + activeCatalogCount,
          disabledOrder: null,
          runtimeStatus: 'failed' as const,
          runtime: {
            entries: [{ entryId: 'local.developer-bundle', enabled: true, fiberPhase: 'failed' }],
            clientModules: [],
            skillIds: [],
          },
          expectedEntries: ['local.developer-bundle'],
          expectedClientModules: [],
          expectedSkillIds: [],
          compatibility: 'unknown' as const,
          compatibilityReason: '本地 Bundle 未经过目录审核。',
          update: null,
          pendingAction: null,
          supportedActions: [],
          configurationEntryIds: ['local.developer-bundle'],
          ownedData: [],
        },
      ],
    }
  }

  private readStored(): DevelopmentInstalledState {
    const fallback: DevelopmentInstalledState = {
      revision: 7,
      workspaceVersion: null,
      workspaceEnabled: false,
      skillInstalled: true,
      skillEnabled: false,
    }
    try {
      const raw = globalThis.sessionStorage.getItem(INSTALLED_STORAGE_KEY)
      if (raw === null) return fallback
      const value = JSON.parse(raw) as Partial<DevelopmentInstalledState>
      return typeof value.revision === 'number'
        && (value.workspaceVersion === null || typeof value.workspaceVersion === 'string')
        && typeof value.workspaceEnabled === 'boolean'
        && typeof value.skillInstalled === 'boolean'
        && typeof value.skillEnabled === 'boolean'
        ? value as DevelopmentInstalledState
        : fallback
    } catch {
      return fallback
    }
  }
}

function rejectUnavailable(): Promise<never> {
  return Promise.reject(new Error('Plugin Center Web development scenario is unavailable'))
}

function isTerminal(phase: PluginOperationPhase): boolean {
  return !isTrustedInstallPhase(phase) || phase === 'committed' || phase === 'failed'
}

function nextGeneration(phase: PluginOperationPhase): number | null {
  if (!isTrustedInstallPhase(phase)) return null
  const index = PLUGIN_OPERATION_PHASES.indexOf(phase)
  return index >= PLUGIN_OPERATION_PHASES.indexOf('reloading') ? 2
    : index >= PLUGIN_OPERATION_PHASES.indexOf('stopping-host') ? 1
      : null
}

interface DevelopmentMarker {
  readonly version?: unknown
  installedRuntime?: DevelopmentInstalledRuntime
  operationRuntime?: DevelopmentOperationRuntime
  recoveryRuntime?: DevelopmentRecoveryRuntime
}

/** Browser-only replay of the Desktop journal/event contract; it never mutates a Profile. */
class DevelopmentOperationRuntime {
  private operation: PluginOperationSnapshot | null
  private readonly listeners = new Set<(operation: PluginOperationSnapshot) => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private sequence = 0

  constructor(private readonly installed: DevelopmentInstalledRuntime) {
    this.operation = this.readStored()
    if (this.operation !== null) installed.commit(this.operation)
    if (this.operation !== null && !isTerminal(this.operation.phase)) this.scheduleNext()
  }

  getOperation(): Promise<PluginOperationSnapshot | null> {
    return Promise.resolve(this.operation)
  }

  current(): PluginOperationSnapshot | null {
    return this.operation
  }

  onState(listener: (operation: PluginOperationSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  install(value: PluginInstallRequest): Promise<PluginOperationStartResult> {
    return this.start({ ...value, action: 'install' })
  }

  manage(value: PluginManagementRequest): Promise<PluginOperationStartResult> {
    return this.start(value)
  }

  private start(request: PluginMutationRequest): Promise<PluginOperationStartResult> {
    const current = this.operation
    if (current?.idempotencyKey === request.idempotencyKey) {
      return Promise.resolve({ kind: 'joined', operation: current })
    }
    if (current !== null && !isTerminal(current.phase)) {
      return Promise.resolve({
        kind: 'busy',
        activeOperationId: current.operationId,
      })
    }
    this.sequence += 1
    const timestamp = new Date().toISOString()
    const operation: PluginOperationSnapshot = {
      schemaVersion: 1,
      operationId: `dev-${request.action}-${String(this.sequence)}`,
      idempotencyKey: request.idempotencyKey,
      profileName: 'web',
      action: request.action,
      pluginId: request.pluginId,
      version: request.version,
      phase: 'preflight',
      startedAt: timestamp,
      updatedAt: timestamp,
      hostGeneration: null,
      failureCode: null,
    }
    this.publish(operation)
    this.scheduleNext()
    return Promise.resolve({ kind: 'started', operation })
  }

  private scheduleNext(): void {
    if (this.timer !== undefined
      || this.operation === null
      || !isTrustedInstallPhase(this.operation.phase)
      || isTerminal(this.operation.phase)) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const current = this.operation
      if (current === null || !isTrustedInstallPhase(current.phase) || isTerminal(current.phase)) return
      const phase = PLUGIN_OPERATION_PHASES[PLUGIN_OPERATION_PHASES.indexOf(current.phase) + 1]
      if (phase === undefined || phase === 'failed') return
      this.publish({
        ...current,
        phase,
        updatedAt: new Date().toISOString(),
        hostGeneration: nextGeneration(phase),
        failureCode: null,
      })
      this.scheduleNext()
    }, OPERATION_INTERVAL_MS)
  }

  private publish(operation: PluginOperationSnapshot): void {
    this.operation = operation
    this.installed.commit(operation)
    try { globalThis.sessionStorage.setItem(OPERATION_STORAGE_KEY, JSON.stringify(operation)) } catch {}
    for (const listener of this.listeners) listener(operation)
  }

  private readStored(): PluginOperationSnapshot | null {
    try {
      const stored = globalThis.sessionStorage.getItem(OPERATION_STORAGE_KEY)
      if (stored === null) return null
      const value = JSON.parse(stored) as Partial<PluginOperationSnapshot>
      return value.schemaVersion === 1
        && value.profileName === 'web'
        && typeof value.action === 'string'
        && COMPATIBILITY_ACTIONS.includes(value.action)
        && typeof value.operationId === 'string'
        && typeof value.idempotencyKey === 'string'
        && typeof value.pluginId === 'string'
        && typeof value.version === 'string'
        && typeof value.phase === 'string'
        && isTrustedInstallPhase(value.phase)
        && typeof value.startedAt === 'string'
        && typeof value.updatedAt === 'string'
        ? value as PluginOperationSnapshot
        : null
    } catch {
      return null
    }
  }
}

/** Browser-only recovery fixture used to accept the failure/retry UI without touching Desktop state. */
class DevelopmentRecoveryRuntime {
  private snapshot: PluginRecoverySnapshot | null
  private readonly listeners = new Set<(snapshot: PluginRecoverySnapshot) => void>()

  constructor() {
    const selected = new URLSearchParams(globalThis.location.search).get('pluginCenterRecovery')
    this.snapshot = selected === 'failed' || selected === 'recovering'
      ? {
        schemaVersion: 1,
        operationId: 'dev-recovery-1',
        phase: selected === 'failed' ? 'recovery-failed' : 'recovering',
        recoveryPhase: selected === 'recovering' ? 'recovery-restoring-profile' : null,
        operationFailureCode: 'package-mutation-failed',
        recoveryReasonCode: selected === 'failed' ? 'runtime-verification-failed' : null,
        attempt: 1,
        updatedAt: new Date().toISOString(),
        canRetry: selected === 'failed',
        canExportDiagnostics: true,
      }
      : null
  }

  getState(): Promise<PluginRecoverySnapshot | null> {
    return Promise.resolve(this.snapshot)
  }

  onState(listener: (snapshot: PluginRecoverySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async retry(request: PluginRecoveryRetryRequest): Promise<PluginRecoverySnapshot | null> {
    if (this.snapshot === null || request.operationId !== this.snapshot.operationId) {
      throw new Error('development recovery operation is unavailable')
    }
    this.publish({
      ...this.snapshot,
      phase: 'recovering',
      recoveryPhase: 'recovery-stopping-host',
      recoveryReasonCode: null,
      attempt: this.snapshot.attempt + 1,
      updatedAt: new Date().toISOString(),
      canRetry: false,
    })
    await new Promise<void>(resolve => setTimeout(resolve, OPERATION_INTERVAL_MS))
    this.publish({
      ...this.snapshot,
      phase: 'rolled-back',
      recoveryPhase: null,
      recoveryReasonCode: null,
      updatedAt: new Date().toISOString(),
      canRetry: false,
    })
    return this.snapshot
  }

  exportDiagnostics(request: PluginDiagnosticExportRequest): Promise<PluginDiagnosticExportResult> {
    if (this.snapshot === null || request.operationId !== this.snapshot.operationId) {
      return Promise.reject(new Error('development recovery operation is unavailable'))
    }
    return Promise.resolve({
      operationId: request.operationId,
      status: 'saved',
      filename: `dsh-plugin-recovery-${request.operationId}.json`,
      sha256: 'd'.repeat(64),
      bytes: 2_048,
    })
  }

  private publish(snapshot: PluginRecoverySnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener(snapshot)
  }
}

/**
 * Return a fixture bridge only when the Host injected the explicit marker.
 * @returns The deterministic development bridge when explicitly enabled.
 */
export function developmentCatalogBridge(): DesktopCatalogBridge | undefined {
  const marker = (globalThis as typeof globalThis & {
    __DSH_PLUGIN_CENTER_DEV__?: DevelopmentMarker
  }).__DSH_PLUGIN_CENTER_DEV__
  if (marker?.version !== 1) return undefined
  const selected = scenario()
  const installed = marker.installedRuntime ??= new DevelopmentInstalledRuntime()
  const operations = marker.operationRuntime ??= new DevelopmentOperationRuntime(installed)
  const recovery = marker.recoveryRuntime ??= new DevelopmentRecoveryRuntime()
  return {
    catalog: {
      list: query => selected === 'error'
        ? rejectUnavailable()
        : Promise.resolve(listResult(query, selected, installed)),
      refresh: query => selected === 'error'
        ? rejectUnavailable()
        : Promise.resolve(listResult(query, selected, installed)),
      detail: query => selected === 'error' ? rejectUnavailable() : Promise.resolve(detailResult(query, selected)),
      checkCompatibility: request => selected === 'error'
        ? rejectUnavailable()
        : Promise.resolve(compatibilityDecision(request, selected)),
    },
    installedPlugins: {
      list: () => selected === 'error'
        ? rejectUnavailable()
        : Promise.resolve(installed.result(operations.current())),
    },
    pluginOperations: {
      mutationsEnabled: true,
      install: request => operations.install(request),
      manage: request => operations.manage(request),
      getOperation: () => operations.getOperation(),
      onState: listener => operations.onState(listener),
    },
    pluginOwnedData: {
      getOffer: () => Promise.resolve(null),
      remove: (request: PluginOwnedDataRemovalRequest): Promise<PluginOwnedDataRemovalResult> => Promise.resolve({
        operationId: request.operationId,
        pluginId: request.pluginId,
        removedPaths: request.paths,
      }),
      retain: request => Promise.resolve({
        operationId: request.operationId,
        pluginId: request.pluginId,
        retained: true,
      }),
    },
    pluginRecovery: {
      getState: () => recovery.getState(),
      retry: request => recovery.retry(request),
      exportDiagnostics: request => recovery.exportDiagnostics(request),
      onState: listener => recovery.onState(listener),
    },
  }
}
