/** Start the browser Desktop-composition preview with deterministic development bridges. */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const packageName = '@deepseek-ai/dsh-client-ui-plugin-center'
const webIndex = resolve(repositoryRoot, 'apps/web/dist/index.html')
const developmentHome = resolve(repositoryRoot, '.artifacts/desktop-web-preview-home')
const pnpmEntrypoint = process.env.npm_execpath

if (pnpmEntrypoint === undefined || pnpmEntrypoint.length === 0) {
  throw new Error('dev:desktop:web: invoke this command through `pnpm run dev:desktop:web`.')
}

function pnpmArgs(args: readonly string[]): string[] {
  return [pnpmEntrypoint as string, ...args]
}

function run(args: readonly string[]): void {
  const result = spawnSync(process.execPath, pnpmArgs(args), {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`dev:desktop:web: ${args.join(' ')} exited with ${String(result.status)}.`)
  }
}

function start(args: readonly string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  return spawn(process.execPath, pnpmArgs(args), {
    cwd: repositoryRoot,
    env,
    stdio: 'inherit',
  })
}

run(['exec', 'tsc', '-b', 'packages/client/ui-plugin-center/tsconfig.json'])
run(['--filter', packageName, 'run', 'bundle'])
if (!existsSync(webIndex)) run(['run', 'build:web'])

// All dsh.client packages participate in the Desktop composition. Their
// existing watcher rewrites only affected client bundles, and client-hmr
// reloads those bundles without rebuilding the Host or Electron application.
const watcher = start(['run', 'dev:web'])
const server = start(['dsh', 'web', '--host', '127.0.0.1', '--port', '3081'], {
  ...process.env,
  // Compose every Desktop-gated browser feature (skin, settings, Plugin
  // Center) while keeping native/system authority outside the browser.
  DSH_DESKTOP: '1',
  DSH_PLUGIN_CENTER_DEV: '1',
  DSH_HOME: developmentHome,
})
const children = [watcher, server]
let requestedExit: number | undefined

function stop(code: number): void {
  requestedExit ??= code
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
}

process.once('SIGINT', () => { stop(130) })
process.once('SIGTERM', () => { stop(0) })

const exited = (child: ChildProcess): Promise<{ child: ChildProcess; code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => { resolveExit({ child, code, signal }) })
  })

const first = await Promise.race(children.map(exited))
if (requestedExit === undefined) {
  const name = first.child === server ? 'Web server' : 'bundle watcher'
  console.error(`dev:desktop:web: ${name} stopped unexpectedly.`)
  stop(first.code ?? 1)
}
await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve()
  : exited(child).then(() => undefined)))
process.exitCode = requestedExit ?? 1
