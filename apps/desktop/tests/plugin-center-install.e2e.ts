import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { initProfile, loadProfile, readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { BUNDLED_CATALOG } from '../src/plugin-center/catalog-fixture.ts'
import { resolveSupportedPluginPlatform } from '../src/plugin-center/environment.ts'
import {
  createPackageManagerInvocation,
  installTrustedPackage,
  type TrustedPackageManagerOptions,
} from '../src/plugin-center/package-manager.ts'
import { readProfileCompatibilityFingerprint } from '../src/plugin-center/profile-compatibility.ts'
import { reconcileAndValidateInstalledBundle } from '../src/plugin-center/profile-installation.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = join(tmpdir(), `dsh-plugin-relaunch-${process.pid}-${String(roots.length)}`)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('trusted installation relaunch persistence', () => {
  it('relaunch without system pnpm retains the exact Bundle projection', async () => {
    const root = await temporaryRoot()
    const home = join(root, 'dsh-home')
    const profile = join(home, 'profiles', 'web')
    const candidate = BUNDLED_CATALOG.preflights.find(value => value.pluginId === 'fixture.workspace-tools')
    expect(candidate).toBeDefined()
    initProfile(profile, [])
    const before = readProfileManifest('desktop-test', profile)
    const artifactPath = fileURLToPath(new URL(
      '../resources/plugin-center/fixtures/deepseek-ai-dsh-plugin-center-fixture-0.1.0-rc.5.tgz',
      import.meta.url,
    ))
    const packageManagerEntry = fileURLToPath(new URL('../runtime/node_modules/pnpm/bin/pnpm.cjs', import.meta.url))
    const installAnchor = fileURLToPath(new URL('../../../package.json', import.meta.url))
    const options: TrustedPackageManagerOptions = {
      executable: process.execPath,
      packageManagerEntry,
      profileDirectory: profile,
      storeDirectory: join(root, 'plugin-store'),
      homeDirectory: join(root, 'clean-home'),
      electronRunAsNode: false,
      platform: process.platform,
      inheritedEnvironment: {
        PATH: join(root, 'no-system-node-or-pnpm'),
        TMPDIR: join(root, 'tmp'),
      },
    }
    await mkdir(options.homeDirectory, { recursive: true })
    await mkdir(options.inheritedEnvironment!.TMPDIR!, { recursive: true })
    const target = {
      packageName: candidate!.packageName,
      version: candidate!.version,
      artifactPath,
    }
    const invocation = createPackageManagerInvocation(options, target)
    expect(invocation.env.PATH).toBe(dirname(process.execPath))
    expect(invocation.env.PATH).not.toContain('no-system-node-or-pnpm')

    await installTrustedPackage(options, target)
    await reconcileAndValidateInstalledBundle({
      before,
      profileDirectory: profile,
      installAnchor,
      candidate: candidate!,
    })

    const readProjection = () => readProfileCompatibilityFingerprint({
      homeDirectory: home,
      profileName: 'web',
      desktopVersion: '0.1.0-rc.5',
      dshVersion: '0.1.0-rc.5',
      nodeVersion: process.versions.node,
      os: process.platform,
      architecture: process.arch,
      catalogEtag: BUNDLED_CATALOG.etag,
      catalogFreshness: 'fresh',
      candidates: BUNDLED_CATALOG.preflights,
      systemComponents: { packageNames: [], entryIds: [] },
      activeOperation: false,
    })
    const first = readProjection()
    expect(first.platform).toBe(resolveSupportedPluginPlatform(process.platform, process.arch))
    expect(first.installedPlugins).toEqual([{
      pluginId: candidate!.pluginId,
      version: candidate!.version,
      packageName: candidate!.packageName,
      enabled: true,
      entryIds: ['fixture.workspace-tools'],
    }])

    const relaunchedProfile = loadProfile(
      'desktop-relaunch-test',
      'web',
      installAnchor,
      home,
    )
    const relaunched = readProjection()
    expect(relaunchedProfile.layers.map(layer => layer.packageName)).toEqual([candidate!.packageName])
    expect(relaunched).toEqual(first)
  }, 120_000)
})
