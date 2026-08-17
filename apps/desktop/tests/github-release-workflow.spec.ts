import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const desktopPackage = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'apps/desktop/package.json'), 'utf8'),
) as { build: { publish: readonly Record<string, string>[] } }

describe('desktop GitHub update publishing', () => {
  it('publishes Desktop updates from the maintained GitHub repository', () => {
    expect(desktopPackage.build.publish).toEqual([{
      provider: 'github',
      owner: 'plutoczm',
      repo: 'deepseek-harness-vscode',
    }])
  })
})
