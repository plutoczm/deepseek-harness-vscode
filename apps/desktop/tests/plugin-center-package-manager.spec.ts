import { describe, expect, it } from 'vitest'
import {
  PACKAGE_MANAGER_REGISTRY,
  createPackageManagerInvocation,
  createPackageRemoveInvocation,
  installTrustedPackage,
  removeTrustedPackage,
  type PackageManagerInvocation,
  type PackageManagerProcessAdapter,
} from '../src/plugin-center/package-manager.ts'

const target = {
  packageName: '@fixture/dsh-workspace-tools',
  version: '1.0.0',
  artifactPath: '/private/cache/reviewed-fixture.tgz',
}

describe('fixed Plugin Center package manager', () => {
  it.each([
    {
      name: 'macOS packaged runtime',
      platform: 'darwin' as const,
      executable: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      entry: '/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/pnpm/bin/pnpm.cjs',
      profile: '/Users/fixture/.dsh/profiles/web',
      store: '/Users/fixture/Library/Application Support/DeepSeek Harness/plugin-store',
      home: '/Users/fixture',
      electronRunAsNode: true,
      inherited: { TMPDIR: '/private/tmp', SECRET_TOKEN: 'must-not-cross' },
    },
    {
      name: 'Windows packaged runtime',
      platform: 'win32' as const,
      executable: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
      entry: 'C:\\Program Files\\DeepSeek Harness\\resources\\host\\node_modules\\pnpm\\bin\\pnpm.cjs',
      profile: 'C:\\Users\\fixture\\.dsh\\profiles\\web',
      store: 'C:\\Users\\fixture\\AppData\\Local\\DeepSeek Harness\\plugin-store',
      home: 'C:\\Users\\fixture',
      electronRunAsNode: true,
      inherited: { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', SECRET_TOKEN: 'must-not-cross' },
    },
  ])('uses fixed exact argv and a scrubbed environment on $name', (fixture) => {
    const invocation = createPackageManagerInvocation({
      executable: fixture.executable,
      packageManagerEntry: fixture.entry,
      profileDirectory: fixture.profile,
      storeDirectory: fixture.store,
      homeDirectory: fixture.home,
      electronRunAsNode: fixture.electronRunAsNode,
      platform: fixture.platform,
      inheritedEnvironment: fixture.inherited,
    }, target)

    expect(invocation).toMatchObject({
      executable: fixture.executable,
      cwd: fixture.profile,
      shell: false,
      windowsHide: true,
      timeoutMs: 120_000,
      maxOutputChars: 32_768,
    })
    expect(invocation.args).toEqual([
      fixture.entry,
      'add',
      '--save-exact',
      '--ignore-scripts',
      '--config.shared-workspace-lockfile=false',
      '--config.manage-package-manager-versions=false',
      '--reporter=append-only',
      '--store-dir',
      fixture.store,
      '--registry',
      PACKAGE_MANAGER_REGISTRY,
      '--',
      target.artifactPath,
    ])
    expect(invocation.env).not.toHaveProperty('SECRET_TOKEN')
    expect(invocation.env).toMatchObject({
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      ELECTRON_RUN_AS_NODE: '1',
      CI: 'true',
      NO_COLOR: '1',
    })
  })

  it('passes only the Desktop-built invocation to the process adapter', async () => {
    const captured: PackageManagerInvocation[] = []
    const processAdapter: PackageManagerProcessAdapter = {
      run: async (invocation) => {
        captured.push(invocation)
        return { code: 0, signal: null, stdout: 'done', stderr: '' }
      },
    }
    await installTrustedPackage({
      executable: '/runtime/node',
      packageManagerEntry: '/runtime/pnpm.cjs',
      profileDirectory: '/profile/web',
      storeDirectory: '/private/store',
      homeDirectory: '/home/fixture',
      electronRunAsNode: false,
      platform: 'darwin',
      inheritedEnvironment: { PATH: '/attacker/bin', NPM_CONFIG_REGISTRY: 'https://evil.example' },
      processAdapter,
    }, target)

    expect(captured).toHaveLength(1)
    expect(captured[0]?.env).not.toHaveProperty('NPM_CONFIG_REGISTRY')
    expect(captured[0]?.env.PATH).toBe('/runtime')
  })

  it('removes only the catalog-owned package name through fixed no-shell argv', async () => {
    const options = {
      executable: '/runtime/node',
      packageManagerEntry: '/runtime/pnpm.cjs',
      profileDirectory: '/profile/web',
      storeDirectory: '/private/store',
      homeDirectory: '/home/fixture',
      electronRunAsNode: false,
      platform: 'darwin' as const,
      inheritedEnvironment: { NPM_CONFIG_REGISTRY: 'https://evil.example' },
    }
    const invocation = createPackageRemoveInvocation(options, { packageName: target.packageName })
    expect(invocation.args).toEqual([
      options.packageManagerEntry,
      'remove',
      '--config.ignore-scripts=true',
      '--config.shared-workspace-lockfile=false',
      '--config.manage-package-manager-versions=false',
      '--reporter=append-only',
      '--store-dir',
      options.storeDirectory,
      `--config.registry=${PACKAGE_MANAGER_REGISTRY}`,
      '--',
      target.packageName,
    ])
    expect(invocation).toMatchObject({ shell: false, cwd: options.profileDirectory })
    expect(invocation.env).not.toHaveProperty('NPM_CONFIG_REGISTRY')

    const captured: PackageManagerInvocation[] = []
    await removeTrustedPackage({
      ...options,
      processAdapter: { run: async (value) => {
        captured.push(value)
        return { code: 0, signal: null, stdout: 'removed', stderr: '' }
      } },
    }, { packageName: target.packageName })
    expect(captured).toEqual([invocation])
  })
})
