import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initProfile, readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import type {
  CatalogVersionPreflight,
  CompatibilityFingerprint,
  InstalledPluginIdentity,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import { reconcileApplicationUpdateCompatibility } from '../src/plugin-center/app-update-compatibility.ts'
import { BUNDLED_CATALOG } from '../src/plugin-center/catalog-fixture.ts'

const roots: string[] = []
const COMPATIBLE_PACKAGE = '@fixture/compatible'
const INCOMPATIBLE_PACKAGE = '@fixture/incompatible'
const DISABLED_PACKAGE = '@fixture/already-disabled'
const LOCAL_PACKAGE = '@local/developer-bundle'
const SYSTEM_PACKAGE = '@deepseek-ai/dsh-web-app'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function candidate(pluginId: string, packageName: string, desktopRange: string): CatalogVersionPreflight {
  return {
    ...BUNDLED_CATALOG.preflights[0]!,
    pluginId,
    packageName,
    version: '1.0.0',
    desktopRange,
    expectedEntries: [pluginId],
    expectedClientModules: [],
    expectedSkillIds: [],
  }
}

function installed(pluginId: string | null, packageName: string, enabled: boolean): InstalledPluginIdentity {
  return {
    pluginId,
    packageName,
    version: '1.0.0',
    enabled,
    entryIds: [pluginId ?? 'local.developer-bundle'],
  }
}

function fingerprint(installedPlugins: readonly InstalledPluginIdentity[]): CompatibilityFingerprint {
  return {
    desktopVersion: '0.1.0-rc.5',
    dshVersion: '0.1.0-rc.5',
    nodeVersion: '22.22.0',
    platform: 'darwin-arm64',
    catalogEtag: BUNDLED_CATALOG.etag,
    catalogFreshness: 'fresh',
    profileRevision: 1,
    installedPlugins,
    protectedPackageNames: [SYSTEM_PACKAGE],
    protectedEntryIds: ['agent-loop'],
    activeOperation: false,
  }
}

describe('application-update Plugin Center compatibility', () => {
  it('deactivates only incompatible reviewed external Bundles before Host start and preserves the result', async () => {
    const root = join(tmpdir(), `dsh-plugin-app-update-${process.pid}-${String(roots.length)}`)
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    roots.push(root)
    const profile = join(root, 'profile')
    initProfile(profile, [])
    const manifest = readProfileManifest('test', profile)
    manifest.dependencies = {
      [COMPATIBLE_PACKAGE]: '1.0.0',
      [INCOMPATIBLE_PACKAGE]: '1.0.0',
      [DISABLED_PACKAGE]: '1.0.0',
      [LOCAL_PACKAGE]: '1.0.0',
      [SYSTEM_PACKAGE]: '1.0.0',
    }
    manifest.dsh = {
      ...manifest.dsh,
      profile: {
        bundles: [SYSTEM_PACKAGE, COMPATIBLE_PACKAGE, INCOMPATIBLE_PACKAGE, LOCAL_PACKAGE],
        disabledBundles: [DISABLED_PACKAGE],
      },
    }
    await writeFile(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

    const candidates = [
      candidate('fixture.compatible', COMPATIBLE_PACKAGE, '>=0.1.0-rc.1 <1.0.0'),
      candidate('fixture.incompatible', INCOMPATIBLE_PACKAGE, '>=9.0.0'),
      candidate('fixture.already-disabled', DISABLED_PACKAGE, '>=0.1.0-rc.1 <1.0.0'),
    ]
    const before = [
      installed('fixture.compatible', COMPATIBLE_PACKAGE, true),
      installed('fixture.incompatible', INCOMPATIBLE_PACKAGE, true),
      installed('fixture.already-disabled', DISABLED_PACKAGE, false),
      installed(null, LOCAL_PACKAGE, true),
    ]
    const result = await reconcileApplicationUpdateCompatibility({
      profileDirectory: profile,
      fingerprint: fingerprint(before),
      candidates,
    })
    const observedAtHostStart = readProfileManifest('test', profile)

    expect(result.deactivated).toEqual([expect.objectContaining({
      pluginId: 'fixture.incompatible',
      packageName: INCOMPATIBLE_PACKAGE,
      reasons: [expect.objectContaining({ code: 'desktop-version-unsupported' })],
    })])
    expect(observedAtHostStart.dependencies).toEqual(manifest.dependencies)
    expect(observedAtHostStart.dsh?.profile).toEqual({
      bundles: [SYSTEM_PACKAGE, COMPATIBLE_PACKAGE, LOCAL_PACKAGE],
      disabledBundles: [DISABLED_PACKAGE, INCOMPATIBLE_PACKAGE],
    })

    const after = before.map(value => value.packageName === INCOMPATIBLE_PACKAGE
      ? { ...value, enabled: false }
      : value)
    await expect(reconcileApplicationUpdateCompatibility({
      profileDirectory: profile,
      fingerprint: fingerprint(after),
      candidates,
    })).resolves.toEqual({ deactivated: [] })
    expect(readProfileManifest('test', profile).dsh?.profile).toEqual(observedAtHostStart.dsh?.profile)
  })
})
