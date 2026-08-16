import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { afterPack } from '../scripts/verify-packaged-runtime.ts'

function context(appOutDir: string, electronPlatformName = 'darwin') {
  return {
    appOutDir,
    electronPlatformName,
    packager: { appInfo: { productFilename: 'DeepSeek Harness' } },
  } as Parameters<typeof afterPack>[0]
}

describe('packaged desktop runtime verification', () => {
  it('accepts the packaged Host entrypoints and Desktop image assets', async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), 'dsh-packaged-runtime-'))
    try {
      const resources = join(appOutDir, 'DeepSeek Harness.app', 'Contents', 'Resources', 'host', 'node_modules')
      const cli = join(resources, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      const web = join(resources, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
      const background = join(resources, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'dsh-desktop', 'default-background.webp')
      const catBackground = join(resources, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'dsh-desktop', 'cloud-cat-background.webp')
      const logo = join(resources, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'dsh-desktop', 'beyondata-logo.png')
      const packageManager = join(resources, 'pnpm', 'bin', 'pnpm.cjs')
      const packageManagerManifest = join(resources, 'pnpm', 'package.json')
      await mkdir(join(cli, '..'), { recursive: true })
      await mkdir(join(web, '..'), { recursive: true })
      await mkdir(join(background, '..'), { recursive: true })
      await mkdir(join(packageManager, '..'), { recursive: true })
      await writeFile(cli, '')
      await writeFile(web, '')
      await writeFile(background, '')
      await writeFile(catBackground, '')
      await writeFile(logo, '')
      await writeFile(packageManager, '')
      await writeFile(packageManagerManifest, JSON.stringify({ version: '11.7.0' }))

      await expect(afterPack(context(appOutDir))).resolves.toBeUndefined()
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
    }
  })

  it('rejects a packaged shell whose package manager is absent or not pinned', async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), 'dsh-packaged-runtime-pnpm-'))
    try {
      const modules = join(appOutDir, 'DeepSeek Harness.app', 'Contents', 'Resources', 'host', 'node_modules')
      const required = [
        ['@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'],
        ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'dsh-desktop', 'default-background.webp'],
        ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'dsh-desktop', 'cloud-cat-background.webp'],
        ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'dsh-desktop', 'beyondata-logo.png'],
        ['pnpm', 'bin', 'pnpm.cjs'],
      ]
      for (const segments of required) {
        const file = join(modules, ...segments)
        await mkdir(join(file, '..'), { recursive: true })
        await writeFile(file, '')
      }
      await mkdir(join(modules, 'pnpm'), { recursive: true })
      await writeFile(join(modules, 'pnpm/package.json'), JSON.stringify({ version: '11.6.0' }))

      await expect(afterPack(context(appOutDir))).rejects.toThrow('packaged pnpm version must be 11.7.0')
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
    }
  })

  it('rejects a shell whose Host dependency tree was filtered out', async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), 'dsh-packaged-runtime-'))
    try {
      await expect(afterPack(context(appOutDir))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
    }
  })

  it('requires Windows x64 native modules in a Windows package', async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), 'dsh-packaged-runtime-win-'))
    try {
      const modules = join(appOutDir, 'resources', 'host', 'node_modules')
      const required = [
        ['@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'],
        ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'dsh-desktop', 'default-background.webp'],
        ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'dsh-desktop', 'cloud-cat-background.webp'],
        ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'dsh-desktop', 'beyondata-logo.png'],
        ['pnpm', 'bin', 'pnpm.cjs'],
        ['@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'],
        ['node-addon-require-builtin-win32-x64-msvc', 'prebuilt', 'win32-x64-msvc-napi-v9.node'],
        ['node-pty', 'prebuilds', 'win32-x64', 'pty.node'],
        ['node-pty', 'prebuilds', 'win32-x64', 'conpty.node'],
        ['@img', 'sharp-win32-x64', 'lib', 'sharp-win32-x64-test.node'],
      ]
      for (const segments of required) {
        const file = join(modules, ...segments)
        await mkdir(join(file, '..'), { recursive: true })
        await writeFile(file, '')
      }
      await writeFile(join(modules, 'pnpm/package.json'), JSON.stringify({ version: '11.7.0' }))

      await expect(afterPack(context(appOutDir, 'win32'))).resolves.toBeUndefined()
      await rm(join(modules, 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'))
      await expect(afterPack(context(appOutDir, 'win32'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
    }
  })
})
