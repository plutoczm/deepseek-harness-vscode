/** Authority-derived installed Plugin Center projection; no duplicate persistence. */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  readProfileBundleState,
  readProfileManifest,
  resolveBundleDir,
} from '@deepseek-ai/dsh-app-boot'
import {
  decodeInstalledPluginListResult,
  type CatalogDetail,
  type CatalogSummary,
  type CatalogVersionPreflight,
  type CompatibilityFingerprint,
  type InstalledPluginListResult,
  type InstalledPluginOwnedData,
  type InstalledPluginProjection,
  type InstalledPluginRuntimeProjection,
  type PluginOperationSnapshot,
  type PluginManagementAction,
  type PluginRuntimeEvidence,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import type { CatalogInstalledAuthority } from './catalog-client.ts'
import type { ProtectedSystemComponents } from './system-components.ts'
import {
  evaluateCompatibility,
  evaluateInstalledActivationCompatibility,
} from './compatibility.ts'

interface SemverApi {
  valid(version: string): string | null
  gt(left: string, right: string): boolean
  rcompare(left: string, right: string): number
}

const semver = createRequire(import.meta.url)('semver') as SemverApi
const TERMINAL_PHASES = new Set(['committed', 'failed', 'rolled-back', 'recovery-failed'])
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const STABLE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u

interface PackageObservation {
  readonly version: string | null
  readonly entryIds: readonly string[]
  readonly expectedClientModules: readonly string[]
  readonly expectedSkillIds: readonly string[]
  readonly ownedData: readonly InstalledPluginOwnedData[]
  readonly bundle: boolean
  readonly failed: boolean
}

/** Exact package-owned data declarations captured before a trusted uninstall. */
export interface InstalledOwnedDataAuthority {
  readonly version: string
  readonly declarations: readonly InstalledPluginOwnedData[]
}

/** Desktop-owned inputs for one fresh installed projection. */
export interface InstalledProjectionInput {
  readonly profileDirectory: string
  readonly installAnchor: string
  readonly fingerprint: CompatibilityFingerprint
  readonly catalog: CatalogInstalledAuthority
  readonly systemComponents: ProtectedSystemComponents
  readonly runtimeEvidence: PluginRuntimeEvidence | null
  readonly operation: PluginOperationSnapshot | null
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function strings(value: unknown, accept: (item: string) => boolean): readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? [...new Set(value.filter(item => accept(item)))]
    : []
}

function ownedData(value: unknown): readonly InstalledPluginOwnedData[] {
  if (!Array.isArray(value)) return []
  const result: InstalledPluginOwnedData[] = []
  const paths = new Set<string>()
  for (const item of value) {
    const source = record(item)
    const path = source?.['path']
    const label = source?.['label']
    if (typeof path !== 'string' || path.length > 256 || typeof label !== 'string' || label.length > 120
      || label.trim() !== label || label === ''
      || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/u.test(path) || path.includes('\\')
      || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
      || paths.has(path)) continue
    paths.add(path)
    result.push({ path, label })
  }
  return result
}

function patchEntryIds(patch: string): readonly string[] {
  const values = new Set<string>()
  for (const line of patch.split(/\r?\n/u)) {
    const matched = line.match(/^\s*-\s+id:\s+(.+?)\s*$/u)?.[1]
    if (matched === undefined) continue
    const value = ((matched.startsWith("'") && matched.endsWith("'"))
      || (matched.startsWith('"') && matched.endsWith('"'))) ? matched.slice(1, -1) : matched
    if (/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(value)) values.add(value)
  }
  return [...values].sort()
}

function observePackage(
  profileDirectory: string,
  installAnchor: string,
  packageName: string,
): PackageObservation {
  try {
    const directory = resolveBundleDir('desktop', packageName, installAnchor, profileDirectory)
    const manifestPath = join(directory, 'package.json')
    const manifest = record(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown)
    const version = manifest?.['name'] === packageName && typeof manifest['version'] === 'string'
      && EXACT_VERSION.test(manifest['version']) && semver.valid(manifest['version']) !== null
      ? manifest['version'] : null
    const dsh = record(manifest?.['dsh'])
    const bundle = record(dsh?.['bundle'])
    const patch = bundle?.['patch']
    if (typeof patch !== 'string' || patch === '') {
      return {
        version,
        entryIds: [],
        expectedClientModules: [],
        expectedSkillIds: [],
        ownedData: [],
        bundle: false,
        failed: false,
      }
    }
    const patchPath = resolve(directory, patch)
    const fromRoot = relative(directory, patchPath)
    if (fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\')
      || !existsSync(patchPath)) throw new Error('Bundle patch is outside or missing')
    const pluginCenter = record(dsh?.['pluginCenter'])
    return {
      version,
      entryIds: patchEntryIds(readFileSync(patchPath, 'utf8')),
      expectedClientModules: strings(pluginCenter?.['expectedClientModules'], item => PACKAGE_NAME.test(item)),
      expectedSkillIds: strings(pluginCenter?.['expectedSkillIds'], item => STABLE_ID.test(item)),
      ownedData: ownedData(pluginCenter?.['ownedData']),
      bundle: true,
      failed: version === null,
    }
  } catch {
    return {
      version: null,
      entryIds: [],
      expectedClientModules: [],
      expectedSkillIds: [],
      ownedData: [],
      bundle: false,
      failed: true,
    }
  }
}

/**
 * Read declarations only when the installed package still has the reviewed exact identity.
 * @param input - Profile/package identity that must exist before uninstall.
 * @returns Exact-version declarations safe to bind to the uninstall operation.
 */
export function readInstalledOwnedDataAuthority(input: {
  readonly profileDirectory: string
  readonly installAnchor: string
  readonly packageName: string
  readonly version: string
}): InstalledOwnedDataAuthority {
  const observation = observePackage(input.profileDirectory, input.installAnchor, input.packageName)
  if (observation.version !== input.version || !observation.bundle || observation.failed) {
    throw new Error('installed package cannot supply exact owned-data authority')
  }
  return { version: observation.version, declarations: observation.ownedData }
}

function exactCatalog(
  packageName: string,
  version: string | null,
  catalog: CatalogInstalledAuthority,
): { readonly candidate: CatalogVersionPreflight; readonly summary: CatalogSummary; readonly detail: CatalogDetail } | null {
  if (version === null) return null
  const candidate = catalog.preflights.find(item =>
    item.packageName === packageName && item.version === version && item.reviewed,
  )
  if (candidate === undefined) return null
  const summary = catalog.entries.find(item =>
    item.pluginId === candidate.pluginId && item.version === candidate.version && item.scope === 'public' && item.verified,
  )
  const detail = catalog.details.find(item =>
    item.summary.pluginId === candidate.pluginId && item.summary.version === candidate.version,
  )
  return summary === undefined || detail === undefined ? null : { candidate, summary, detail }
}

function availableUpdate(
  current: CatalogVersionPreflight,
  catalog: CatalogInstalledAuthority,
  fingerprint: CompatibilityFingerprint,
): InstalledPluginProjection['update'] {
  const target = catalog.preflights.filter(item =>
    item.pluginId === current.pluginId
    && item.packageName === current.packageName
    && item.reviewed
    && item.eligible
    && !item.withdrawn
    && semver.gt(item.version, current.version),
  ).filter(item => evaluateCompatibility({ candidate: item, fingerprint, action: 'update' }).allowed,
  ).sort((left, right) => semver.rcompare(left.version, right.version))[0]
  if (target === undefined) return null
  const detail = catalog.details.find(item =>
    item.summary.pluginId === target.pluginId && item.summary.version === target.version,
  )
  return detail === undefined ? null : {
    version: target.version,
    changelog: detail.changelog,
    riskLevel: target.riskLevel,
    riskSummary: target.riskSummary,
  }
}

function pluginRuntime(
  evidence: PluginRuntimeEvidence | null,
  expectedEntries: readonly string[],
  expectedClientModules: readonly string[],
  expectedSkillIds: readonly string[],
): InstalledPluginRuntimeProjection {
  if (evidence === null) return { entries: [], clientModules: [], skillIds: [] }
  return {
    entries: evidence.entries.filter(entry => expectedEntries.some(expected =>
      entry.entryId === expected || entry.entryId === `include:${expected}`)),
    clientModules: evidence.clientModules.filter(module => expectedClientModules.includes(module)),
    skillIds: evidence.skillIds.filter(skillId => expectedSkillIds.includes(skillId)),
  }
}

function runtimeStatus(
  enabled: boolean,
  failed: boolean,
  requireActiveEntries: boolean,
  evidence: PluginRuntimeEvidence | null,
  runtime: InstalledPluginRuntimeProjection,
  expectedEntries: readonly string[],
  expectedClientModules: readonly string[],
  expectedSkillIds: readonly string[],
): InstalledPluginProjection['runtimeStatus'] {
  if (failed) return 'failed'
  if (evidence === null) return 'unknown'
  const anyObserved = runtime.entries.length + runtime.clientModules.length + runtime.skillIds.length > 0
  if (!enabled) return anyObserved ? 'failed' : 'inactive'
  const expectedCount = expectedEntries.length + expectedClientModules.length + expectedSkillIds.length
  if (expectedCount === 0) return 'unknown'
  const entriesActive = expectedEntries.every(expected => runtime.entries.some((entry) => {
    if (entry.entryId !== expected && entry.entryId !== `include:${expected}`) return false
    if (requireActiveEntries) return entry.enabled && entry.fiberPhase === 'active'
    return entry.enabled ? entry.fiberPhase === 'active' : entry.fiberPhase === null
  }))
  const clientsActive = expectedClientModules.every(module => runtime.clientModules.includes(module))
  const skillsActive = expectedSkillIds.every(skillId => runtime.skillIds.includes(skillId))
  return entriesActive && clientsActive && skillsActive ? 'running' : 'failed'
}

function supportedActions(
  enabled: boolean,
  candidate: CatalogVersionPreflight,
  update: InstalledPluginProjection['update'],
): readonly PluginManagementAction[] {
  const supported = new Set(candidate.supportedActions)
  return [
    ...update !== null && supported.has('update') ? ['update' as const] : [],
    ...enabled && supported.has('disable') ? ['disable' as const] : [],
    ...!enabled && supported.has('enable') ? ['enable' as const] : [],
    ...supported.has('uninstall') ? ['uninstall' as const] : [],
  ]
}

/** Join current Profile, package, catalog, journal, and runtime facts without writing state. */
export function deriveInstalledPluginProjection(input: InstalledProjectionInput): InstalledPluginListResult {
  const manifest = readProfileManifest('desktop', input.profileDirectory)
  const bundleState = readProfileBundleState(manifest)
  const dependencies = Object.keys(manifest.dependencies ?? {})
  const names = [...new Set([...bundleState.bundles, ...bundleState.disabledBundles, ...dependencies])]
  const protectedNames = new Set(input.systemComponents.packageNames)
  const pending = input.operation !== null && !TERMINAL_PHASES.has(input.operation.phase)
    ? input.operation
    : null
  const items: InstalledPluginProjection[] = []

  for (const packageName of names) {
    const observation = observePackage(input.profileDirectory, input.installAnchor, packageName)
    const activeIndex = bundleState.bundles.indexOf(packageName)
    const disabledIndex = bundleState.disabledBundles.indexOf(packageName)
    const listed = activeIndex !== -1 || disabledIndex !== -1
    if (!listed && !observation.bundle) continue
    const system = protectedNames.has(packageName)
    const catalog = system ? null : exactCatalog(packageName, observation.version, input.catalog)
    const expectedEntries = catalog?.candidate.expectedEntries ?? observation.entryIds
    const expectedClientModules = catalog?.candidate.expectedClientModules ?? observation.expectedClientModules
    const expectedSkillIds = catalog?.candidate.expectedSkillIds ?? observation.expectedSkillIds
    const runtime = pluginRuntime(
      input.runtimeEvidence,
      expectedEntries,
      expectedClientModules,
      expectedSkillIds,
    )
    const enabled = activeIndex !== -1
    const activationReasons = catalog === null
      ? []
      : evaluateInstalledActivationCompatibility({ candidate: catalog.candidate, fingerprint: input.fingerprint })
    const update = catalog === null ? null : availableUpdate(catalog.candidate, input.catalog, input.fingerprint)
    items.push({
      pluginId: catalog?.candidate.pluginId ?? null,
      packageName,
      version: observation.version,
      displayName: catalog?.summary.displayName ?? packageName,
      icon: catalog?.summary.icon ?? null,
      brandColor: catalog?.summary.brandColor ?? null,
      catalogKind: catalog?.summary.catalogKind ?? null,
      source: system ? 'system' : catalog === null ? 'local' : 'catalog',
      protected: system,
      enabled,
      bundleOrder: enabled ? activeIndex : null,
      disabledOrder: disabledIndex === -1 ? null : disabledIndex,
      runtimeStatus: runtimeStatus(
        enabled,
        observation.failed || (!enabled && disabledIndex === -1),
        catalog !== null,
        input.runtimeEvidence,
        runtime,
        expectedEntries,
        expectedClientModules,
        expectedSkillIds,
      ),
      runtime,
      expectedEntries,
      expectedClientModules,
      expectedSkillIds,
      compatibility: activationReasons.length > 0 ? 'incompatible' : catalog?.summary.compatibility.status ?? 'unknown',
      compatibilityReason: activationReasons.length > 0
        ? activationReasons.map(reason => `${reason.code}: ${reason.subject}`).join('; ')
        : catalog?.summary.compatibility.reason
        ?? (system ? '系统组件由当前桌面发行版保护。' : '未匹配已验证目录中的确定版本。'),
      update,
      pendingAction: pending !== null && catalog !== null && pending.pluginId === catalog.candidate.pluginId
        ? pending.action
        : null,
      supportedActions: catalog === null
        ? []
        : supportedActions(enabled, catalog.candidate, update)
          .filter(action => action !== 'enable' || activationReasons.length === 0),
      configurationEntryIds: expectedEntries,
      ownedData: catalog === null ? [] : observation.ownedData,
    })
  }

  return decodeInstalledPluginListResult({
    profileName: 'web',
    profileRevision: input.fingerprint.profileRevision,
    catalogFreshness: input.catalog.freshness,
    items,
  })
}
