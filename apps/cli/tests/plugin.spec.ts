/** Focused wiring tests for the CLI profile package-manager forwarder. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  initProfile: vi.fn(),
  readProfileManifest: vi.fn(),
  reconcileProfileBundles: vi.fn(),
  resolveBundleDir: vi.fn(),
  resolveProfileDir: vi.fn(),
  spawnSync: vi.fn(),
  writeProfileManifest: vi.fn(),
}))

vi.mock('node:child_process', () => ({ spawnSync: mocks.spawnSync }))
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }))
vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  DEFAULT_PROFILE_BUNDLES: ['base'],
  PROFILE_TEMPLATES: {},
  initProfile: mocks.initProfile,
  readProfileManifest: mocks.readProfileManifest,
  reconcileProfileBundles: mocks.reconcileProfileBundles,
  resolveBundleDir: mocks.resolveBundleDir,
  resolveProfileDir: mocks.resolveProfileDir,
  writeProfileManifest: mocks.writeProfileManifest,
}))
vi.mock('../src/profile-boot.ts', () => ({ INSTALL_ANCHOR: '/install/package.json' }))

import { runPlugin } from '../src/plugin.ts'

beforeEach(() => {
  mocks.existsSync.mockReturnValue(true)
  mocks.resolveProfileDir.mockReturnValue('/profiles/demo')
  mocks.resolveBundleDir.mockReturnValue('/packages/installed-bundle')
  mocks.spawnSync.mockReturnValue({ status: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const mock of Object.values(mocks)) mock.mockReset()
})

describe('dsh plugin reconciliation', () => {
  it('uses shared reconcile profile bundles output for warnings and persistence', () => {
    const before = { dependencies: {}, dsh: { profile: { bundles: ['base'] } } }
    const after = {
      dependencies: { 'installed-bundle': '1.0.0', 'plain-library': '1.0.0' },
      dsh: { profile: { bundles: ['base'] } },
    }
    const reconciled = {
      ...after,
      dsh: { profile: { bundles: ['base', 'installed-bundle'] } },
    }
    mocks.readProfileManifest
      .mockReturnValueOnce(before)
      .mockReturnValueOnce(after)
      .mockReturnValueOnce({ dsh: { bundle: { patch: './cordis.patch.yml' } } })
    mocks.reconcileProfileBundles.mockImplementation((
      receivedBefore: typeof before,
      receivedAfter: typeof after,
      inspect: (packageName: string) => boolean,
    ) => {
      expect(receivedBefore).toBe(before)
      expect(receivedAfter).toBe(after)
      expect(inspect('installed-bundle')).toBe(true)
      return {
        manifest: reconciled,
        changed: true,
        addedBundles: ['installed-bundle'],
        removedBundles: [],
        addedPlainDependencies: ['plain-library'],
      }
    })
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    expect(runPlugin('demo', ['add', 'installed-bundle'])).toBe(0)

    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'pnpm',
      ['add', 'installed-bundle'],
      expect.objectContaining({ cwd: '/profiles/demo', stdio: 'inherit' }),
    )
    expect(mocks.resolveBundleDir).toHaveBeenCalledWith(
      'dsh', 'installed-bundle', '/install/package.json', '/profiles/demo',
    )
    expect(mocks.writeProfileManifest).toHaveBeenCalledWith('/profiles/demo', reconciled)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('plain-library declares no dsh.bundle'))
  })
})
