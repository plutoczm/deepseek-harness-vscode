/** Desktop-owned compatibility lookup that resolves renderer intent back to trusted catalog and Profile facts. */

import {
  decodeCompatibilityDecision,
  decodeCompatibilityRequest,
  type CompatibilityDecision,
  type CompatibilityFingerprint,
  type CompatibilityRequest,
  type CatalogVersionPreflight,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import { evaluateCompatibility } from './compatibility.ts'
import type { CatalogPreflightSelection } from './catalog-client.ts'

/** Catalog operations consumed by the read-only preflight service. */
export interface CompatibilityCatalogSource {
  resolvePreflight(request: CompatibilityRequest): Promise<CatalogPreflightSelection>
}

/** Rebuild current Desktop and selected-Profile facts for one catalog snapshot. */
export type CompatibilityFingerprintReader = (
  selection: CatalogPreflightSelection,
) => CompatibilityFingerprint | Promise<CompatibilityFingerprint>

/** Complete trusted resolution reused by one mutation after renderer intent is decoded. */
export interface ResolvedCompatibility {
  readonly request: CompatibilityRequest
  readonly candidate: CatalogVersionPreflight | null
  readonly selection: CatalogPreflightSelection
  readonly fingerprint: CompatibilityFingerprint
  readonly decision: CompatibilityDecision
}

/** Resolve one exact renderer action without accepting or changing package authority. */
export class PluginCompatibilityService {
  /**
   * @param catalog - Trusted exact-version metadata owner.
   * @param readFingerprint - Fresh local fact reader invoked for every request.
   */
  constructor(
    private readonly catalog: CompatibilityCatalogSource,
    private readonly readFingerprint: CompatibilityFingerprintReader,
  ) {}

  /**
   * Recompute one exact-action decision from current trusted inputs.
   * @param value - Untrusted renderer value containing only plugin id, exact version, and closed action.
   * @returns A deterministic allow or deny decision; no decision changes local state.
   */
  async check(value: unknown): Promise<CompatibilityDecision> {
    return (await this.resolve(value)).decision
  }

  /** Resolve the exact catalog candidate and local fingerprint without projecting away authority. */
  async resolve(value: unknown): Promise<ResolvedCompatibility> {
    const request = decodeCompatibilityRequest(value)
    const selection = await this.catalog.resolvePreflight(request)
    const fingerprint = await this.readFingerprint(selection)
    if (selection.candidate !== null) {
      return {
        request,
        candidate: selection.candidate,
        selection,
        fingerprint,
        decision: evaluateCompatibility({ candidate: selection.candidate, fingerprint, action: request.action }),
      }
    }
    const decision = decodeCompatibilityDecision({
      pluginId: request.pluginId,
      version: request.version,
      action: request.action,
      allowed: false,
      fingerprint,
      reasons: [{
        code: 'catalog-metadata-invalid',
        subject: `${request.pluginId}@${request.version}`,
        actual: 'missing',
        expected: 'validated exact catalog version',
      }],
      restartRequired: false,
      capabilities: [],
      riskLevel: 'high',
      riskSummary: 'Reviewed risk metadata is unavailable for this exact version.',
      executionAuthority: 'broad-application-authority',
    })
    return { request, candidate: null, selection, fingerprint, decision }
  }
}
