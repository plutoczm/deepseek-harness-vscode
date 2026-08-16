/**
 * Start the desktop app from verified workspace outputs, rebuilding only when
 * the inputs that produce those outputs have changed.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  globSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, resolve, sep } from 'node:path'

const BUILD_STATE_VERSION = 1
const MAX_BUILD_ATTEMPTS = 2
const ROOT_BUILD_INPUTS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'tsconfig.client.json',
  'tsconfig.host.json',
  'tsdown.config.ts',
] as const
const BUILD_INPUT_ROOTS = [
  'apps/cli',
  'apps/desktop',
  'apps/web',
  'native',
  'packages',
  'patches',
  'vendor',
] as const
const EXCLUDED_SEGMENTS = new Set([
  '.artifacts',
  '.cache',
  '.git',
  'coverage',
  'dist',
  'fixtures',
  'lib',
  'node_modules',
  'runtime-host',
  'stress-tests',
  'test',
  'tests',
  'tmp',
])

/** Disposable build-state record used by the desktop development launcher. */
export const DESKTOP_BUILD_STATE_RELATIVE_PATH = 'apps/desktop/lib/.dev-desktop-build.json'

/** Outputs that must exist before the desktop process can reuse a build. */
export const DESKTOP_REQUIRED_OUTPUTS = [
  'apps/desktop/lib/main.js',
  'apps/desktop/lib/preload.cjs',
  'apps/cli/lib/bin.js',
  'apps/web/dist/index.html',
] as const

interface BuildFingerprint {
  fingerprint: string
  inputCount: number
}

interface BuildState extends BuildFingerprint {
  version: number
  builtAt: string
}

interface EnsureDesktopBuildOptions {
  repoRoot: string
  force?: boolean
  runtimeSignature?: string
  build?: () => Promise<void>
  report?: (message: string) => void
}

/**
 * Ensure all desktop development outputs match the current workspace inputs.
 * @param options - repository location plus optional test and force controls.
 * @returns whether this invocation rebuilt or reused the workspace outputs.
 */
export async function ensureDesktopBuild(
  options: EnsureDesktopBuildOptions,
): Promise<'rebuilt' | 'reused'> {
  const statePath = resolve(options.repoRoot, DESKTOP_BUILD_STATE_RELATIVE_PATH)
  const report = options.report ?? console.log
  const runtimeSignature = options.runtimeSignature ?? currentRuntimeSignature()
  const initialFingerprint = fingerprintBuildInputs(options.repoRoot, runtimeSignature)
  const state = readBuildState(statePath)
  const missingOutputs = findMissingOutputs(options.repoRoot)

  if (
    options.force !== true
    && state?.fingerprint === initialFingerprint.fingerprint
    && missingOutputs.length === 0
  ) {
    report(
      `dev:desktop: inputs unchanged; reusing ${state.inputCount} verified build inputs from ${state.builtAt}.`,
    )
    return 'reused'
  }

  report(rebuildReason(options.force === true, state, initialFingerprint, missingOutputs))
  rmSync(statePath, { force: true })
  const build = options.build ?? (() => runWorkspaceBuild(options.repoRoot))
  let expectedFingerprint = initialFingerprint

  for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt += 1) {
    await build()
    const nextMissingOutputs = findMissingOutputs(options.repoRoot)
    if (nextMissingOutputs.length > 0) {
      throw new Error(
        `dev:desktop: workspace build completed without required outputs: ${nextMissingOutputs.join(', ')}`,
      )
    }

    const completedFingerprint = fingerprintBuildInputs(options.repoRoot, runtimeSignature)
    if (completedFingerprint.fingerprint === expectedFingerprint.fingerprint) {
      writeBuildState(statePath, completedFingerprint)
      report(`dev:desktop: workspace build is current across ${completedFingerprint.inputCount} inputs.`)
      return 'rebuilt'
    }

    rmSync(statePath, { force: true })
    if (attempt === MAX_BUILD_ATTEMPTS) {
      throw new Error(
        'dev:desktop: build inputs changed during both build attempts; stopped without recording a reusable build.',
      )
    }
    report('dev:desktop: inputs changed during the build; rebuilding once against the new snapshot.')
    expectedFingerprint = completedFingerprint
  }

  throw new Error('dev:desktop: unreachable build state')
}

function rebuildReason(
  force: boolean,
  state: BuildState | undefined,
  fingerprint: BuildFingerprint,
  missingOutputs: readonly string[],
): string {
  if (force) return 'dev:desktop: forced workspace rebuild requested.'
  if (missingOutputs.length > 0) {
    return `dev:desktop: required outputs are missing (${missingOutputs.join(', ')}); rebuilding workspace.`
  }
  if (state === undefined) return 'dev:desktop: no reusable build record; rebuilding workspace.'
  if (state.fingerprint !== fingerprint.fingerprint) {
    return 'dev:desktop: relevant build inputs changed; rebuilding workspace.'
  }
  return 'dev:desktop: build record is not reusable; rebuilding workspace.'
}

function fingerprintBuildInputs(repoRoot: string, runtimeSignature: string): BuildFingerprint {
  const hash = createHash('sha256')
  const inputPaths = discoverBuildInputs(repoRoot)
  hash.update(`desktop-dev-build-state:${BUILD_STATE_VERSION}\0${runtimeSignature}\0`)

  for (const relativePath of inputPaths) {
    const absolutePath = resolve(repoRoot, relativePath)
    hash.update(`${relativePath}\0`)
    const stat = lstatSync(absolutePath)
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${readlinkSync(absolutePath)}\0`)
    } else if (stat.isFile()) {
      hash.update('file\0')
      hash.update(readFileSync(absolutePath))
      hash.update('\0')
    }
  }

  return { fingerprint: hash.digest('hex'), inputCount: inputPaths.length }
}

function discoverBuildInputs(repoRoot: string): string[] {
  const gitResult = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '-co', '--exclude-standard', '-z', '--', ...ROOT_BUILD_INPUTS, ...BUILD_INPUT_ROOTS],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const candidates = gitResult.status === 0
    ? gitResult.stdout.split('\0').filter(Boolean)
    : globSync(
      [
        ...ROOT_BUILD_INPUTS,
        ...BUILD_INPUT_ROOTS.map(inputRoot => `${inputRoot}/**/*`),
      ],
      { cwd: repoRoot },
    )

  return [...new Set(candidates.map(posixPath))]
    .filter(relativePath => isBuildInput(repoRoot, relativePath))
    .sort()
}

function isBuildInput(repoRoot: string, relativePath: string): boolean {
  const segments = relativePath.split('/')
  if (segments.some(segment => EXCLUDED_SEGMENTS.has(segment))) return false
  if (basename(relativePath).endsWith('.i18n.yaml')) return false
  if (/^(?:README(?:\.[^.]+)?|AGENTS|CLAUDE)\.md$/i.test(basename(relativePath))) return false
  if (!existsSync(resolve(repoRoot, relativePath))) return false
  return lstatSync(resolve(repoRoot, relativePath)).isFile()
    || lstatSync(resolve(repoRoot, relativePath)).isSymbolicLink()
}

function posixPath(path: string): string {
  return path.split(sep).join('/')
}

function currentRuntimeSignature(): string {
  const buildEnvironment = Object.entries(process.env)
    .filter(([name]) => name === 'NODE_ENV' || name.startsWith('VITE_') || name.startsWith('DSH_BUILD_'))
    .sort(([left], [right]) => left.localeCompare(right))
  return JSON.stringify({
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    buildEnvironment,
  })
}

function findMissingOutputs(repoRoot: string): string[] {
  return DESKTOP_REQUIRED_OUTPUTS.filter(relativePath => !existsSync(resolve(repoRoot, relativePath)))
}

function readBuildState(statePath: string): BuildState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<BuildState>
    if (
      parsed.version === BUILD_STATE_VERSION
      && typeof parsed.fingerprint === 'string'
      && typeof parsed.inputCount === 'number'
      && typeof parsed.builtAt === 'string'
    ) return parsed as BuildState
  } catch {
    return undefined
  }
  return undefined
}

function writeBuildState(statePath: string, fingerprint: BuildFingerprint): void {
  const state: BuildState = {
    version: BUILD_STATE_VERSION,
    ...fingerprint,
    builtAt: new Date().toISOString(),
  }
  mkdirSync(dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(state, undefined, 2)}\n`)
  renameSync(temporaryPath, statePath)
}

async function runWorkspaceBuild(repoRoot: string): Promise<void> {
  const entrypoint = process.env.npm_execpath
  if (entrypoint !== undefined && /\.(?:c?js|mjs)$/u.test(entrypoint)) {
    await runProcess(process.execPath, [entrypoint, 'run', 'build'], repoRoot)
    return
  }
  const command = entrypoint ?? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  await runProcess(command, ['run', 'build'], repoRoot)
}

async function launchElectron(desktopRoot: string): Promise<number> {
  const electronExecutable = createRequire(import.meta.url)('electron') as unknown
  if (typeof electronExecutable !== 'string') {
    throw new TypeError('dev:desktop: the Electron package did not resolve to an executable path.')
  }
  return runProcess(
    electronExecutable,
    ['.'],
    desktopRoot,
    true,
    resolveDesktopLaunchEnvironment(process.env, process.execPath),
  )
}

/**
 * Preserve the Node runtime that owns the development launcher for trusted child processes.
 * @param inheritedEnvironment - Environment inherited by the launcher.
 * @param nodeExecutable - Absolute Node executable running the launcher.
 * @returns the Electron environment with an explicit Desktop Node runtime.
 */
export function resolveDesktopLaunchEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv,
  nodeExecutable: string,
): NodeJS.ProcessEnv {
  return {
    ...inheritedEnvironment,
    DSH_DESKTOP_NODE_EXECUTABLE: nodeExecutable,
  }
}

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  returnExitCode = false,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise(0)
      } else if (returnExitCode && code !== null) {
        resolvePromise(code)
      } else {
        reject(new Error(
          `dev:desktop: ${command} exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`}.`,
        ))
      }
    })
  })
}

async function main(args: readonly string[]): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--rebuild')) {
    throw new Error('dev:desktop: usage: pnpm run dev:desktop [--rebuild]')
  }
  const repoRoot = resolve(import.meta.dirname, '../../..')
  await ensureDesktopBuild({ repoRoot, force: args[0] === '--rebuild' })
  return launchElectron(resolve(repoRoot, 'apps/desktop'))
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  })
}
