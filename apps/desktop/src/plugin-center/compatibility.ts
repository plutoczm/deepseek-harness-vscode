/** Deterministic exact-action compatibility evaluation with no local mutation. */

import { createRequire } from 'node:module'
import {
  COMPATIBILITY_REASON_ORDER,
  decodeCompatibilityDecision,
  type CatalogVersionPreflight,
  type CompatibilityAction,
  type CompatibilityDecision,
  type CompatibilityFingerprint,
  type CompatibilityReason,
  type CompatibilityReasonCode,
  type InstalledPluginIdentity,
} from '@deepseek-ai/dsh-plugin-center-contracts'

interface SemverApi {
  readonly valid: (version: string) => string | null
  readonly validRange: (range: string, options?: { includePrerelease?: boolean }) => string | null
  readonly gt: (left: string, right: string, options?: { includePrerelease?: boolean }) => boolean
  readonly satisfies: (version: string, range: string, options?: { includePrerelease?: boolean }) => boolean
}

const semver = createRequire(import.meta.url)('semver') as SemverApi
const SEMVER_OPTIONS = { includePrerelease: true } as const

/** Complete trusted input for one pure exact-action decision. */
export interface CompatibilityEvaluationInput {
  readonly candidate: CatalogVersionPreflight
  readonly fingerprint: CompatibilityFingerprint
  readonly action: CompatibilityAction
}

function currentPlugin(
  installed: readonly InstalledPluginIdentity[],
  pluginId: string,
): InstalledPluginIdentity | undefined {
  return installed.find(plugin => plugin.pluginId === pluginId)
}

function actionSupported(
  action: CompatibilityAction,
  candidate: CatalogVersionPreflight,
  installed: InstalledPluginIdentity | undefined,
): boolean {
  if (!candidate.supportedActions.includes(action)) return false
  if (action === 'install') return installed === undefined
  if (installed === undefined) return false
  if (installed.packageName !== candidate.packageName) return false
  if (action === 'update') {
    return semver.valid(installed.version) !== null
      && semver.gt(candidate.version, installed.version, SEMVER_OPTIONS)
  }
  if (installed.version !== candidate.version) return false
  if (action === 'enable') return !installed.enabled
  if (action === 'disable') return installed.enabled
  return true
}

/**
 * Evaluate one decoded catalog version against one immutable local fingerprint.
 * @param input - Catalog-owned metadata, Desktop-owned facts, and one closed action.
 * @returns An ordered allow or deny result scoped to every supplied input.
 */
export function evaluateCompatibility(input: CompatibilityEvaluationInput): CompatibilityDecision {
  const { candidate, fingerprint, action } = input
  const reasons: CompatibilityReason[] = []
  const observed = new Set<string>()
  const add = (
    code: CompatibilityReasonCode,
    subject: string,
    actual: string | null = null,
    expected: string | null = null,
  ): void => {
    const key = `${code}\u0000${subject}\u0000${actual ?? ''}\u0000${expected ?? ''}`
    if (observed.has(key)) return
    observed.add(key)
    reasons.push({ code, subject, actual, expected })
  }

  if (candidate.catalogEtag !== fingerprint.catalogEtag) {
    add('catalog-metadata-invalid', 'catalogEtag', candidate.catalogEtag, fingerprint.catalogEtag)
  }
  if (fingerprint.catalogFreshness === 'stale') {
    add('version-ineligible', 'catalogFreshness', 'stale', 'fresh-or-cached')
  }
  if (!candidate.reviewed) add('catalog-unverified', candidate.pluginId, 'false', 'true')
  if (candidate.withdrawn) add('version-withdrawn', candidate.version, 'true', 'false')
  if (!candidate.eligible) add('version-ineligible', candidate.version, 'false', 'true')

  if (fingerprint.protectedPackageNames.includes(candidate.packageName)) {
    add('protected-package', candidate.packageName)
  }
  for (const entryId of candidate.expectedEntries) {
    if (fingerprint.protectedEntryIds.includes(entryId)) add('protected-entry', entryId)
  }

  for (const [subject, actual, range, code] of [
    ['desktopVersion', fingerprint.desktopVersion, candidate.desktopRange, 'desktop-version-unsupported'],
    ['dshVersion', fingerprint.dshVersion, candidate.dshRange, 'dsh-version-unsupported'],
    ['nodeVersion', fingerprint.nodeVersion, candidate.nodeRange, 'node-version-unsupported'],
  ] as const) {
    if (semver.validRange(range, SEMVER_OPTIONS) === null) {
      add('catalog-metadata-invalid', subject, range, 'valid semantic-version range')
    } else if (!semver.satisfies(actual, range, SEMVER_OPTIONS)) {
      add(code, subject, actual, range)
    }
  }

  const artifact = candidate.artifacts.find(value => value.platform === fingerprint.platform)
  if (artifact === undefined) add('artifact-missing', fingerprint.platform)
  if (candidate.expectedEntries.length === 0
    && candidate.expectedClientModules.length === 0
    && candidate.expectedSkillIds.length === 0) {
    add('artifact-evidence-incomplete', candidate.pluginId)
  }

  const installed = currentPlugin(fingerprint.installedPlugins, candidate.pluginId)
  if (action === 'install' && installed !== undefined) {
    add('plugin-identity-conflict', candidate.pluginId, installed.version, candidate.version)
  }
  if (action !== 'install' && installed !== undefined && installed.packageName !== candidate.packageName) {
    add('package-identity-conflict', candidate.packageName, installed.packageName, candidate.packageName)
  }
  for (const plugin of fingerprint.installedPlugins) {
    if (plugin.pluginId !== candidate.pluginId && plugin.packageName === candidate.packageName) {
      add('package-identity-conflict', candidate.packageName, plugin.pluginId, candidate.pluginId)
    }
    if (plugin.pluginId === candidate.pluginId) continue
    for (const entryId of candidate.expectedEntries) {
      if (plugin.enabled && plugin.entryIds.includes(entryId)) {
        add('entry-identity-conflict', entryId, plugin.pluginId, candidate.pluginId)
      }
    }
  }

  const installedPluginIds = new Set(fingerprint.installedPlugins.map(plugin => plugin.pluginId))
  const installedPackageNames = new Set(fingerprint.installedPlugins.map(plugin => plugin.packageName))
  const activeEntryIds = new Set(fingerprint.installedPlugins.flatMap(plugin => plugin.enabled ? plugin.entryIds : []))
  for (const pluginId of candidate.conflicts.pluginIds) {
    if (installedPluginIds.has(pluginId)) add('declared-conflict', pluginId)
  }
  for (const packageName of candidate.conflicts.packageNames) {
    if (installedPackageNames.has(packageName)) add('declared-conflict', packageName)
  }
  for (const entryId of candidate.conflicts.entryIds) {
    if (activeEntryIds.has(entryId)) add('declared-conflict', entryId)
  }

  if (fingerprint.activeOperation) add('operation-busy', action)
  if (!actionSupported(action, candidate, installed)) {
    add('action-not-supported', action, installed === undefined ? 'not-installed' : installed.enabled ? 'enabled' : 'disabled')
  }

  const order = new Map(COMPATIBILITY_REASON_ORDER.map((code, index) => [code, index]))
  reasons.sort((left, right) => {
    const byCode = (order.get(left.code) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.code) ?? Number.MAX_SAFE_INTEGER)
    if (byCode !== 0) return byCode
    return left.subject.localeCompare(right.subject)
  })

  return decodeCompatibilityDecision({
    pluginId: candidate.pluginId,
    version: candidate.version,
    action,
    allowed: reasons.length === 0,
    fingerprint,
    reasons,
    restartRequired: candidate.restartRequired,
    capabilities: candidate.capabilities,
    riskLevel: candidate.riskLevel,
    riskSummary: candidate.riskSummary,
    executionAuthority: candidate.executionAuthority,
  })
}

/**
 * Return only reasons that make an exact installed Bundle unsafe to activate at startup.
 * @param input - Reviewed exact version and the fresh Desktop/Profile facts.
 * @returns Stable incompatibility reasons, excluding action availability and catalog-cache age.
 */
export function evaluateInstalledActivationCompatibility(input: {
  readonly candidate: CatalogVersionPreflight
  readonly fingerprint: CompatibilityFingerprint
}): readonly CompatibilityReason[] {
  const installed = currentPlugin(input.fingerprint.installedPlugins, input.candidate.pluginId)
  if (installed === undefined) {
    return [{
      code: 'action-not-supported',
      subject: input.candidate.pluginId,
      actual: 'not-installed',
      expected: 'installed exact catalog version',
    }]
  }
  const decision = evaluateCompatibility({
    ...input,
    action: installed.enabled ? 'disable' : 'enable',
  })
  return decision.reasons.filter(reason => reason.code !== 'action-not-supported'
    && reason.code !== 'operation-busy'
    && !(reason.code === 'version-ineligible' && reason.subject === 'catalogFreshness'))
}
