import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_BUILD_STATE_RELATIVE_PATH,
  DESKTOP_REQUIRED_OUTPUTS,
  ensureDesktopBuild,
  resolveDesktopLaunchEnvironment,
} from '../scripts/dev-desktop.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('desktop development build cache', () => {
  it('builds cold, reuses unchanged outputs, and invalidates on source changes or an explicit rebuild', async () => {
    const root = createFixture()
    let buildCount = 0
    const build = async (): Promise<void> => {
      buildCount += 1
      writeRequiredOutputs(root)
    }

    await expect(ensureDesktopBuild({ repoRoot: root, build, runtimeSignature: 'test' }))
      .resolves.toBe('rebuilt')
    await expect(ensureDesktopBuild({ repoRoot: root, build, runtimeSignature: 'test' }))
      .resolves.toBe('reused')
    expect(buildCount).toBe(1)

    writeFixtureFile(root, 'docs/plugin-center-spec.md', '# Concurrent product spec\n')
    await expect(ensureDesktopBuild({ repoRoot: root, build, runtimeSignature: 'test' }))
      .resolves.toBe('reused')

    writeFixtureFile(root, 'apps/desktop/src/main.ts', 'export const revision = 2\n')
    await expect(ensureDesktopBuild({ repoRoot: root, build, runtimeSignature: 'test' }))
      .resolves.toBe('rebuilt')
    await expect(ensureDesktopBuild({
      repoRoot: root,
      build,
      runtimeSignature: 'test',
      force: true,
    })).resolves.toBe('rebuilt')
    expect(buildCount).toBe(3)
  })

  it('removes the reusable record before a failed rebuild', async () => {
    const root = createFixture()
    const successfulBuild = async (): Promise<void> => {
      writeRequiredOutputs(root)
    }
    await ensureDesktopBuild({ repoRoot: root, build: successfulBuild, runtimeSignature: 'test' })
    const statePath = resolve(root, DESKTOP_BUILD_STATE_RELATIVE_PATH)
    expect(readFileSync(statePath, 'utf8')).toContain('"version": 1')

    writeFixtureFile(root, 'apps/desktop/src/main.ts', 'export const revision = 3\n')
    await expect(ensureDesktopBuild({
      repoRoot: root,
      runtimeSignature: 'test',
      build: async () => {
        throw new Error('synthetic build failure')
      },
    })).rejects.toThrow('synthetic build failure')
    expect(() => readFileSync(statePath, 'utf8')).toThrow()

    await expect(ensureDesktopBuild({ repoRoot: root, build: successfulBuild, runtimeSignature: 'test' }))
      .resolves.toBe('rebuilt')
  })

  it('rebuilds once when an input changes during the first build', async () => {
    const root = createFixture()
    let buildCount = 0
    const messages: string[] = []

    await expect(ensureDesktopBuild({
      repoRoot: root,
      runtimeSignature: 'test',
      report: message => messages.push(message),
      build: async () => {
        buildCount += 1
        writeRequiredOutputs(root)
        if (buildCount === 1) {
          writeFixtureFile(root, 'apps/web/src/main.ts', 'export const revision = 2\n')
        }
      },
    })).resolves.toBe('rebuilt')

    expect(buildCount).toBe(2)
    expect(messages).toContain(
      'dev:desktop: inputs changed during the build; rebuilding once against the new snapshot.',
    )
  })
})

describe('desktop development launch environment', () => {
  it('pins the launcher Node executable for Host and package-manager child processes', () => {
    expect(resolveDesktopLaunchEnvironment({ CUSTOM_VALUE: 'kept' }, '/absolute/node')).toEqual({
      CUSTOM_VALUE: 'kept',
      DSH_DESKTOP_NODE_EXECUTABLE: '/absolute/node',
    })
  })
})

function createFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'dsh-dev-desktop-'))
  temporaryRoots.push(root)
  writeFixtureFile(root, 'package.json', '{"private":true}\n')
  writeFixtureFile(root, 'apps/cli/src/bin.ts', 'export const cli = true\n')
  writeFixtureFile(root, 'apps/desktop/src/main.ts', 'export const revision = 1\n')
  writeFixtureFile(root, 'apps/web/src/main.ts', 'export const revision = 1\n')
  writeFixtureFile(root, 'packages/core/agent/src/index.ts', 'export const agent = true\n')
  return root
}

function writeRequiredOutputs(root: string): void {
  for (const relativePath of DESKTOP_REQUIRED_OUTPUTS) {
    writeFixtureFile(root, relativePath, `output:${relativePath}\n`)
  }
}

function writeFixtureFile(root: string, relativePath: string, contents: string): void {
  const absolutePath = resolve(root, relativePath)
  mkdirSync(resolve(absolutePath, '..'), { recursive: true })
  writeFileSync(absolutePath, contents)
}
