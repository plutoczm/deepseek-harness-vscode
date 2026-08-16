/** Reject a packaged desktop shell that omitted the staged Host entrypoints. */

import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AfterPackContext } from 'electron-builder'
import {
  PACKAGE_MANAGER_ENTRY_SEGMENTS,
  PINNED_PACKAGE_MANAGER_VERSION,
} from '../src/plugin-center/package-manager.ts'

const REQUIRED_HOST_FILES = [
  ['@deepseek-ai', 'dsh', 'lib', 'bin.js'],
  ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'],
  ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'dsh-desktop', 'default-background.webp'],
  ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'dsh-desktop', 'cloud-cat-background.webp'],
  ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'dsh-desktop', 'beyondata-logo.png'],
] as const

const REQUIRED_WINDOWS_HOST_FILES = [
  ['@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'],
  ['node-addon-require-builtin-win32-x64-msvc', 'prebuilt', 'win32-x64-msvc-napi-v9.node'],
  ['node-pty', 'prebuilds', 'win32-x64', 'pty.node'],
  ['node-pty', 'prebuilds', 'win32-x64', 'conpty.node'],
] as const

/**
 * Verify the Host files required before the signed application can start.
 * @param context - Electron Builder's completed application directory.
 * @returns A promise that rejects when a staged Host entrypoint is absent.
 */
export async function afterPack(context: AfterPackContext): Promise<void> {
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  for (const segments of REQUIRED_HOST_FILES) {
    await access(join(resources, 'host', 'node_modules', ...segments))
  }
  const modules = join(resources, 'host', 'node_modules')
  await access(join(modules, ...PACKAGE_MANAGER_ENTRY_SEGMENTS))
  const packageManager = JSON.parse(await readFile(join(modules, 'pnpm/package.json'), 'utf8')) as {
    readonly version?: unknown
  }
  if (packageManager.version !== PINNED_PACKAGE_MANAGER_VERSION) {
    throw new Error(`packaged pnpm version must be ${PINNED_PACKAGE_MANAGER_VERSION}`)
  }
  if (context.electronPlatformName === 'win32') {
    for (const segments of REQUIRED_WINDOWS_HOST_FILES) {
      await access(join(modules, ...segments))
    }
    const sharpFiles = await readdir(join(modules, '@img', 'sharp-win32-x64', 'lib'))
    if (!sharpFiles.some(file => /^sharp-win32-x64-.*\.node$/.test(file))) {
      throw new Error('Windows x64 Sharp native module is missing from the packaged Host runtime')
    }
  }
}

export default afterPack
