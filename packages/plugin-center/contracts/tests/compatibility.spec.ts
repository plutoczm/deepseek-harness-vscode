import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_VERIFICATION_REASON_ORDER,
  CatalogContractError,
  COMPATIBILITY_ACTIONS,
  COMPATIBILITY_REASON_ORDER,
  decodeArtifactVerificationResult,
  decodeCatalogVersionPreflight,
  decodeCompatibilityDecision,
  decodeCompatibilityFingerprint,
  decodeCompatibilityRequest,
  decodePluginInstallRequest,
  decodePluginOperationSnapshot,
  decodePluginOperationStartResult,
} from '../src/index.ts'

const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`

function preflight() {
  return {
    pluginId: 'fixture.workspace-tools',
    version: '1.2.3',
    packageName: '@fixture/dsh-workspace-tools',
    catalogEtag: 'catalog-v1',
    reviewed: true,
    eligible: true,
    withdrawn: false,
    desktopRange: '>=0.1.0-rc.1 <0.2.0',
    dshRange: '>=0.1.0-rc.1 <0.2.0',
    nodeRange: '>=22 <23',
    artifacts: [{
      platform: 'darwin-arm64',
      url: 'https://cdn.deepseek.com/plugins/fixture.workspace-tools/1.2.3.tgz',
      sha256: 'a'.repeat(64),
      integrity: INTEGRITY,
      packedBytes: 4_096,
      unpackedBytes: 16_384,
      fileCount: 12,
    }],
    bundlePatch: './cordis.patch.yml',
    capabilities: ['host', 'client', 'filesystem'],
    riskLevel: 'medium',
    riskSummary: 'Reviewed code still runs with broad application authority.',
    executionAuthority: 'broad-application-authority',
    conflicts: { pluginIds: [], packageNames: [], entryIds: [] },
    expectedEntries: ['fixture.workspace-tools'],
    expectedClientModules: ['@fixture/dsh-client-ui-workspace-tools'],
    expectedSkillIds: [],
    supportedActions: ['install', 'update', 'enable', 'disable', 'uninstall'],
    restartRequired: true,
  }
}

function fingerprint() {
  return {
    desktopVersion: '0.1.0-rc.5',
    dshVersion: '0.1.0-rc.5',
    nodeVersion: '22.22.0',
    platform: 'darwin-arm64',
    catalogEtag: 'catalog-v1',
    catalogFreshness: 'fresh',
    profileRevision: 3,
    installedPlugins: [],
    protectedPackageNames: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    protectedEntryIds: ['agent-loop', 'ui-plugin-center'],
    activeOperation: false,
  }
}

describe('plugin center compatibility contract', () => {
  it('accepts only closed exact-action, catalog, and environment values', () => {
    expect(COMPATIBILITY_ACTIONS).toEqual(['install', 'update', 'enable', 'disable', 'uninstall'])
    expect(decodeCompatibilityRequest({
      pluginId: 'fixture.workspace-tools', version: '1.2.3', action: 'install',
    })).toEqual({ pluginId: 'fixture.workspace-tools', version: '1.2.3', action: 'install' })
    expect(decodeCatalogVersionPreflight(preflight())).toEqual(preflight())
    expect(decodeCatalogVersionPreflight({
      ...preflight(),
      artifacts: [{
        ...preflight().artifacts[0],
        url: 'https://registry.npmjs.org/@fixture/dsh-workspace-tools/-/dsh-workspace-tools-1.2.3.tgz',
      }],
    }).artifacts[0]?.url).toContain('registry.npmjs.org')
    expect(decodeCompatibilityFingerprint(fingerprint())).toEqual(fingerprint())
  })

  it('accepts only closed trusted-install intent and durable operation values', () => {
    const request = {
      pluginId: 'fixture.workspace-tools',
      version: '1.2.3',
      idempotencyKey: 'install:fixture.workspace-tools:019c',
    }
    const operation = {
      schemaVersion: 1,
      operationId: '019c1234-1234-1234-1234-123456789abc',
      idempotencyKey: request.idempotencyKey,
      profileName: 'web',
      action: 'install',
      pluginId: request.pluginId,
      version: request.version,
      phase: 'installing',
      startedAt: '2026-08-15T01:00:00.000Z',
      updatedAt: '2026-08-15T01:00:01.000Z',
      hostGeneration: 1,
      failureCode: null,
    }
    expect(decodePluginInstallRequest(request)).toEqual(request)
    expect(decodePluginOperationSnapshot(operation)).toEqual(operation)
    expect(decodePluginOperationStartResult({ kind: 'started', operation }))
      .toEqual({ kind: 'started', operation })
    expect(decodePluginOperationStartResult({ kind: 'busy', activeOperationId: operation.operationId }))
      .toEqual({ kind: 'busy', activeOperationId: operation.operationId })

    expect(() => decodePluginInstallRequest({ ...request, packageName: '@evil/package' }))
      .toThrow(CatalogContractError)
    expect(() => decodePluginInstallRequest({ ...request, idempotencyKey: '../../escape' }))
      .toThrow(CatalogContractError)
    expect(() => decodePluginOperationSnapshot({ ...operation, phase: 'failed', failureCode: null }))
      .toThrow(CatalogContractError)
    expect(() => decodePluginOperationSnapshot({ ...operation, command: 'pnpm add evil' }))
      .toThrow(CatalogContractError)
  })

  it.each([
    ['unknown renderer authority', () => decodeCompatibilityRequest({
      pluginId: 'fixture.workspace-tools', version: '1.2.3', action: 'install',
      url: 'https://cdn.deepseek.com/plugin.tgz',
    })],
    ['version range in an exact seat', () => decodeCompatibilityRequest({
      pluginId: 'fixture.workspace-tools', version: '^1.2.3', action: 'install',
    })],
    ['open action', () => decodeCompatibilityRequest({
      pluginId: 'fixture.workspace-tools', version: '1.2.3', action: 'run-command',
    })],
    ['sandbox authority claim', () => decodeCatalogVersionPreflight({
      ...preflight(), executionAuthority: 'sandboxed',
    })],
    ['unapproved artifact origin', () => decodeCatalogVersionPreflight({
      ...preflight(), artifacts: [{ ...preflight().artifacts[0], url: 'https://evil.example/plugin.tgz' }],
    })],
    ['duplicate platform artifact', () => decodeCatalogVersionPreflight({
      ...preflight(), artifacts: [preflight().artifacts[0], preflight().artifacts[0]],
    })],
    ['malformed digest', () => decodeCatalogVersionPreflight({
      ...preflight(), artifacts: [{ ...preflight().artifacts[0], sha256: 'ABC' }],
    })],
    ['escaping Bundle patch', () => decodeCatalogVersionPreflight({
      ...preflight(), bundlePatch: '../cordis.patch.yml',
    })],
    ['unsupported release platform', () => decodeCompatibilityFingerprint({
      ...fingerprint(), platform: 'linux-x64',
    })],
  ])('rejects %s', (_name, run) => {
    expect(run).toThrow(CatalogContractError)
  })

  it('enforces stable compatibility and artifact reason ordering', () => {
    expect(COMPATIBILITY_REASON_ORDER[0]).toBe('catalog-metadata-invalid')
    expect(ARTIFACT_VERIFICATION_REASON_ORDER[0]).toBe('packed-size-exceeded')
    const decision = {
      pluginId: 'fixture.workspace-tools',
      version: '1.2.3',
      action: 'install',
      allowed: false,
      fingerprint: fingerprint(),
      reasons: [
        { code: 'version-ineligible', subject: 'fixture.workspace-tools', actual: 'false', expected: 'true' },
        { code: 'artifact-missing', subject: 'darwin-arm64', actual: null, expected: 'darwin-arm64' },
      ],
      restartRequired: true,
      capabilities: ['host'],
      riskLevel: 'medium',
      riskSummary: 'Reviewed code still runs with broad application authority.',
      executionAuthority: 'broad-application-authority',
    }
    expect(decodeCompatibilityDecision(decision)).toEqual(decision)
    expect(() => decodeCompatibilityDecision({ ...decision, reasons: [...decision.reasons].reverse() }))
      .toThrow(CatalogContractError)

    const verification = {
      verified: false,
      reasons: [
        { code: 'sha256-mismatch', subject: '@fixture/dsh-workspace-tools' },
        { code: 'package-version-mismatch', subject: '@fixture/dsh-workspace-tools' },
      ],
      observedPackageName: '@fixture/dsh-workspace-tools',
      observedVersion: '1.2.2',
      observedBundlePatch: './cordis.patch.yml',
      entryCount: 12,
      unpackedBytes: 16_384,
    }
    expect(decodeArtifactVerificationResult(verification)).toEqual(verification)
    expect(() => decodeArtifactVerificationResult({ ...verification, reasons: [...verification.reasons].reverse() }))
      .toThrow(CatalogContractError)
  })
})
