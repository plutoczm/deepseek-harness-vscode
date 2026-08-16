/** Localized compatibility copy shared by catalog detail and installed management views. */

import type { CompatibilityReasonCode } from '@deepseek-ai/dsh-plugin-center-contracts'
import type { PluginCenterTabProps } from './PluginCenterTab.tsx'
import type { PluginCenterLocaleKey } from './locales.ts'

const REASON_KEYS = {
  'catalog-metadata-invalid': 'reasonCatalogMetadataInvalid',
  'catalog-unverified': 'reasonCatalogUnverified',
  'version-withdrawn': 'reasonVersionWithdrawn',
  'version-ineligible': 'reasonVersionIneligible',
  'protected-package': 'reasonProtectedPackage',
  'protected-entry': 'reasonProtectedEntry',
  'desktop-version-unsupported': 'reasonDesktopVersionUnsupported',
  'dsh-version-unsupported': 'reasonDshVersionUnsupported',
  'node-version-unsupported': 'reasonNodeVersionUnsupported',
  'platform-unsupported': 'reasonPlatformUnsupported',
  'artifact-missing': 'reasonArtifactMissing',
  'artifact-evidence-incomplete': 'reasonArtifactEvidenceIncomplete',
  'plugin-identity-conflict': 'reasonPluginIdentityConflict',
  'package-identity-conflict': 'reasonPackageIdentityConflict',
  'entry-identity-conflict': 'reasonEntryIdentityConflict',
  'declared-conflict': 'reasonDeclaredConflict',
  'operation-busy': 'reasonOperationBusy',
  'action-not-supported': 'reasonActionNotSupported',
} as const satisfies Record<CompatibilityReasonCode, PluginCenterLocaleKey>

function isCompatibilityReasonCode(value: string): value is CompatibilityReasonCode {
  return Object.hasOwn(REASON_KEYS, value)
}

/**
 * Resolve a structured compatibility reason to its localized copy key.
 * @param code - Stable reason code returned by the compatibility evaluator.
 * @returns Locale key for the user-facing reason label.
 */
export function compatibilityReasonKey(code: CompatibilityReasonCode): PluginCenterLocaleKey {
  return REASON_KEYS[code]
}

/**
 * Replace Desktop projection reason codes with concise product copy while retaining unknown prose.
 * @param reason - Semicolon-delimited Desktop compatibility summary.
 * @param t - Plugin Center locale resolver.
 * @returns Localized summary for the installed row, or null when no reason is present.
 */
export function installedCompatibilityReason(
  reason: string | null,
  t: PluginCenterTabProps['t'],
): string | null {
  if (reason === null) return null
  const labels = reason.split('; ').map((part) => {
    const separator = part.indexOf(':')
    const code = (separator === -1 ? part : part.slice(0, separator)).trim()
    return isCompatibilityReasonCode(code) ? t(REASON_KEYS[code]) : part
  })
  return [...new Set(labels)].join('、')
}
