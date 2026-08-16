import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CompatibilityFingerprint,
  PluginRuntimeEvidence,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import { BUNDLED_CATALOG } from '../src/plugin-center/catalog-fixture.ts'
import {
  deriveInstalledPluginProjection,
} from '../src/plugin-center/installed-projection.ts'

const roots: string[] = []
const WORKSPACE = BUNDLED_CATALOG.preflights.find(item => item.pluginId === 'fixture.workspace-tools')!
const SKILLS = BUNDLED_CATALOG.preflights.find(item => item.pluginId === 'fixture.skill-pack')!

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function packageDirectory(root: string, packageName: string): string {
  return join(root, 'node_modules', ...packageName.split('/'))
}

function writeBundle(
  root: string,
  packageName: string,
  version: string,
  entryId: string,
  pluginCenter: Record<string, unknown> = {},
): void {
  const directory = packageDirectory(root, packageName)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
    name: packageName,
    version,
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      pluginCenter,
    },
  }, undefined, 2)}\n`)
  writeFileSync(join(directory, 'cordis.patch.yml'), `- id: ${entryId}\n  disabled: false\n`)
}

function fixture(): { readonly profile: string; readonly anchor: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installed-projection-'))
  roots.push(root)
  const installation = join(root, 'installation')
  const profile = join(root, 'home/profiles/web')
  mkdirSync(installation, { recursive: true })
  mkdirSync(profile, { recursive: true })
  const systemPackage = '@deepseek-ai/dsh-base'
  writeBundle(installation, systemPackage, '0.1.0-rc.5', 'system.base')
  writeFileSync(join(packageDirectory(installation, systemPackage), 'cordis.patch.yml'), [
    '- id: system.base',
    '  disabled: false',
    '- id: system.optional',
    '  disabled: true',
    '',
  ].join('\n'))
  writeFileSync(join(installation, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '0.1.0-rc.5',
    dependencies: { [systemPackage]: '0.1.0-rc.5' },
  })}\n`)
  writeBundle(profile, WORKSPACE.packageName, WORKSPACE.version, 'fixture.workspace-tools', {
    expectedClientModules: WORKSPACE.expectedClientModules,
    expectedSkillIds: [],
    ownedData: [{ path: 'cache/index.json', label: '索引缓存' }],
  })
  writeBundle(profile, SKILLS.packageName, SKILLS.version, 'fixture.harness-basics-provider', {
    expectedClientModules: [],
    expectedSkillIds: SKILLS.expectedSkillIds,
  })
  writeBundle(profile, '@local/unknown-bundle', '0.3.0', 'local.unknown')
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: {
      [WORKSPACE.packageName]: WORKSPACE.version,
      [SKILLS.packageName]: SKILLS.version,
      '@local/unknown-bundle': '0.3.0',
      'plain-library': '1.0.0',
    },
    dsh: {
      profile: {
        bundles: [systemPackage, WORKSPACE.packageName, '@local/unknown-bundle'],
        disabledBundles: [SKILLS.packageName],
      },
    },
  }, undefined, 2)}\n`)
  return { profile, anchor: join(installation, 'package.json') }
}

function fingerprint(): CompatibilityFingerprint {
  return {
    desktopVersion: '0.1.0-rc.5',
    dshVersion: '0.1.0-rc.5',
    nodeVersion: '22.22.0',
    platform: 'darwin-arm64',
    catalogEtag: BUNDLED_CATALOG.etag,
    catalogFreshness: 'fresh',
    profileRevision: 17,
    installedPlugins: [
      {
        pluginId: WORKSPACE.pluginId,
        packageName: WORKSPACE.packageName,
        version: WORKSPACE.version,
        enabled: true,
        entryIds: ['fixture.workspace-tools'],
      },
      {
        pluginId: SKILLS.pluginId,
        packageName: SKILLS.packageName,
        version: SKILLS.version,
        enabled: false,
        entryIds: ['fixture.harness-basics-provider'],
      },
      {
        pluginId: null,
        packageName: '@local/unknown-bundle',
        version: '0.3.0',
        enabled: true,
        entryIds: ['local.unknown'],
      },
    ],
    protectedPackageNames: ['@deepseek-ai/dsh-base'],
    protectedEntryIds: ['system.base'],
    activeOperation: true,
  }
}

const runtime: PluginRuntimeEvidence = {
  entries: [
    { entryId: 'system.base', enabled: true, fiberPhase: 'active' },
    { entryId: 'system.optional', enabled: false, fiberPhase: null },
    { entryId: 'fixture.workspace-tools', enabled: true, fiberPhase: 'active' },
    { entryId: 'local.unknown', enabled: true, fiberPhase: 'failed' },
  ],
  clientModules: [...WORKSPACE.expectedClientModules],
  skillIds: [],
}

describe('authority derived projection', () => {
  it('keeps honest system, catalog, disabled, local, runtime, and pending facts in Profile order', () => {
    const current = fixture()
    const result = deriveInstalledPluginProjection({
      profileDirectory: current.profile,
      installAnchor: current.anchor,
      fingerprint: fingerprint(),
      catalog: {
        etag: BUNDLED_CATALOG.etag,
        freshness: 'fresh',
        entries: BUNDLED_CATALOG.entries,
        details: BUNDLED_CATALOG.details,
        preflights: BUNDLED_CATALOG.preflights,
      },
      systemComponents: { packageNames: ['@deepseek-ai/dsh-base'], entryIds: ['system.base'] },
      runtimeEvidence: runtime,
      operation: {
        schemaVersion: 1,
        operationId: '019c1234-1234-1234-1234-123456789abc',
        idempotencyKey: 'disable:fixture.workspace-tools:019c',
        profileName: 'web',
        action: 'disable',
        pluginId: WORKSPACE.pluginId,
        version: WORKSPACE.version,
        phase: 'stopping-host',
        startedAt: '2026-08-15T08:00:00.000Z',
        updatedAt: '2026-08-15T08:00:01.000Z',
        hostGeneration: 1,
        failureCode: null,
      },
    })

    expect(result.profileRevision).toBe(17)
    expect(result.items.map(item => [item.packageName, item.source, item.runtimeStatus])).toEqual([
      ['@deepseek-ai/dsh-base', 'system', 'running'],
      [WORKSPACE.packageName, 'catalog', 'running'],
      ['@local/unknown-bundle', 'local', 'failed'],
      [SKILLS.packageName, 'catalog', 'inactive'],
    ])
    expect(result.items[0]).toMatchObject({ protected: true, supportedActions: [], bundleOrder: 0 })
    expect(result.items[1]).toMatchObject({
      pluginId: WORKSPACE.pluginId,
      pendingAction: 'disable',
      supportedActions: ['disable', 'uninstall'],
    })
    expect(result.items[2]).toMatchObject({ pluginId: null, supportedActions: [] })
    expect(result.items[3]).toMatchObject({
      pluginId: SKILLS.pluginId,
      enabled: false,
      disabledOrder: 0,
      supportedActions: ['enable', 'uninstall'],
    })
    expect(result.items.some(item => item.packageName === 'plain-library')).toBe(false)
  })

  it('keeps a broken listed Bundle visible with unknown version and no mutation authority', () => {
    const current = fixture()
    rmSync(packageDirectory(current.profile, '@local/unknown-bundle'), { recursive: true })
    const result = deriveInstalledPluginProjection({
      profileDirectory: current.profile,
      installAnchor: current.anchor,
      fingerprint: fingerprint(),
      catalog: {
        etag: BUNDLED_CATALOG.etag,
        freshness: 'stale',
        entries: BUNDLED_CATALOG.entries,
        details: BUNDLED_CATALOG.details,
        preflights: BUNDLED_CATALOG.preflights,
      },
      systemComponents: { packageNames: ['@deepseek-ai/dsh-base'], entryIds: ['system.base'] },
      runtimeEvidence: null,
      operation: null,
    })
    expect(result.items.find(item => item.packageName === '@local/unknown-bundle')).toMatchObject({
      version: null,
      source: 'local',
      runtimeStatus: 'failed',
      supportedActions: [],
    })
    expect(result.catalogFreshness).toBe('stale')
  })
})
