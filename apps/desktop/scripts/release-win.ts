/** Build the Windows x64 installer, shortening NSIS template paths on macOS. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

/**
 * NSIS still uses a fixed 260-character buffer for POSIX include paths. pnpm's
 * content-addressed app-builder-lib path can exceed it, so macOS cross-builds
 * expose the same templates through a short temporary symlink.
 */
export function releaseWin(extraArgs: readonly string[] = []): void {
  const environment = { ...process.env }
  let temporaryRoot: string | undefined
  try {
    if (process.platform === 'darwin') {
      const localRequire = createRequire(import.meta.url)
      const electronBuilderPackage = localRequire.resolve('electron-builder/package.json')
      const builderRequire = createRequire(electronBuilderPackage)
      const appBuilderPackage = builderRequire.resolve('app-builder-lib/package.json')
      const templateSource = join(dirname(appBuilderPackage), 'templates', 'nsis')
      temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-nsis-'))
      const shortTemplates = join(temporaryRoot, 'nsis')
      symlinkSync(templateSource, shortTemplates, 'dir')
      environment.ELECTRON_BUILDER_NSIS_TEMPLATE_DIR = shortTemplates
    }
    run('pnpm', ['exec', 'electron-builder', '--win', 'nsis', '--x64', ...extraArgs], environment)
  } finally {
    if (temporaryRoot !== undefined) rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

try {
  releaseWin(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
