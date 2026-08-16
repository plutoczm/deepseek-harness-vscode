import { readFile, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, composeEntries, loadProfile } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-modules'
import PluginInventoryGateway from '../../../host/plugin-inventory/src/index.ts'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '../src/index.ts'

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const fixtureDirectory = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const skillFixtureDirectory = join(repositoryRoot, 'packages/examples/plugin-center-skill-fixture')
const roots: string[] = []

async function linkPackage(profile: string, packageName: string, target: string): Promise<void> {
  const segments = packageName.split('/')
  const destination = join(profile, 'node_modules', ...segments)
  await mkdir(dirname(destination), { recursive: true })
  await symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Plugin Center reviewed fixture real profile activation', () => {
  it('boots Bundle patches and exposes joined Host, client, and Skill evidence', async () => {
    const home = join(tmpdir(), `dsh-plugin-fixture-${process.pid}-${String(roots.length)}`)
    roots.push(home)
    const profile = join(home, 'profiles/web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-web-fixture',
      private: true,
      dependencies: {
        '@deepseek-ai/dsh-plugin-center-fixture': '0.1.0-rc.5',
        '@deepseek-ai/dsh-plugin-center-skill-fixture': '0.1.0-rc.5',
      },
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-plugin-center-fixture',
            '@deepseek-ai/dsh-plugin-center-skill-fixture',
          ],
        },
      },
    }, null, 2)}\n`)
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    const packageTargets = {
      '@deepseek-ai/dsh-plugin-center-fixture': fixtureDirectory,
      '@deepseek-ai/dsh-plugin-center-skill-fixture': skillFixtureDirectory,
      '@deepseek-ai/dsh-client-modules': join(repositoryRoot, 'packages/client/modules'),
      '@deepseek-ai/dsh-skill': join(repositoryRoot, 'packages/skill/skill'),
      '@deepseek-ai/dsh-host-plugin-inventory': join(repositoryRoot, 'packages/host/plugin-inventory'),
    }
    for (const [packageName, target] of Object.entries(packageTargets)) {
      await linkPackage(profile, packageName, target)
    }

    const loaded = loadProfile('fixture-test', 'web', join(profile, 'package.json'), home)
    const composed = composeEntries(loaded.layers.map(layer => layer.patches))
    expect(composed.map(entry => entry.id)).toEqual([
      'fixture.workspace-tools',
      'fixture.harness-basics-provider',
    ])

    const config = join(profile, 'cordis.yml')
    await writeFile(config, [
      '- id: skills',
      "  name: '@deepseek-ai/dsh-skill'",
      '- id: client-modules',
      "  name: '@deepseek-ai/dsh-client-modules'",
      '- id: plugin-inventory',
      "  name: '@deepseek-ai/dsh-host-plugin-inventory'",
      '',
    ].join('\n'))
    const ctx = await boot(
      'fixture-test',
      config,
      loaded.layers.flatMap(layer => layer.patches),
      (root) => {
        root.provide('webServer', {
          register: () => () => {},
          tapIndex: () => () => {},
        } as unknown as Context['webServer'])
      },
    )
    try {
      const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
      const evidence = await inventory.list()
      expect(evidence.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ entryId: 'include:fixture.workspace-tools', fiberPhase: 'active' }),
        expect.objectContaining({ entryId: 'include:fixture.harness-basics-provider', fiberPhase: 'active' }),
      ]))
      expect(evidence.clientModules).toContain('@deepseek-ai/dsh-plugin-center-fixture')
      expect(evidence.skillIds).toContain('fixture-harness-basics')
      expect(ctx.get('pluginCenterFixture')).toEqual({ status: 'running', capability: 'workspace-tools' })
      expect(await readFile(join(fixtureDirectory, 'lib/client.js'), 'utf8'))
        .toContain('data-plugin-center-fixture-capability')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
