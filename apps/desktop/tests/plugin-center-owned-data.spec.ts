import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CompatibilityFingerprint, PluginRuntimeEvidence } from '@deepseek-ai/dsh-plugin-center-contracts'
import { PluginOperationController } from '../src/plugin-center/operation-controller.ts'
import { PluginOperationJournal } from '../src/plugin-center/operation-journal.ts'
import {
  PluginOwnedDataAuthorityStore,
  PluginOwnedDataRemover,
} from '../src/plugin-center/owned-data.ts'

const roots: string[] = []
const OPERATION_ID = 'owned-operation-1'
const PLUGIN_ID = 'fixture.owned-data'
const PACKAGE_NAME = '@fixture/owned-data'
const VERSION = '1.0.0'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function clock(): () => Date {
  let second = 0
  return () => new Date(`2026-08-15T07:00:${String(second++).padStart(2, '0')}.000Z`)
}

function runtimeEvidence(): PluginRuntimeEvidence {
  return {
    entries: [{ entryId: 'unrelated.runtime', enabled: true, fiberPhase: 'active' }],
    clientModules: ['@fixture/unrelated-client'],
    skillIds: ['unrelated-skill'],
  }
}

function fingerprint(installed: boolean): CompatibilityFingerprint {
  return {
    desktopVersion: '0.1.0-rc.5',
    dshVersion: '0.1.0-rc.5',
    nodeVersion: '22.22.0',
    platform: 'darwin-arm64',
    catalogEtag: 'fixture-owned-v1',
    catalogFreshness: 'fresh',
    profileRevision: installed ? 1 : 2,
    installedPlugins: installed ? [{
      pluginId: PLUGIN_ID,
      packageName: PACKAGE_NAME,
      version: VERSION,
      enabled: true,
      entryIds: [PLUGIN_ID],
    }] : [],
    protectedPackageNames: ['@deepseek-ai/dsh-base'],
    protectedEntryIds: ['agent-loop'],
    activeOperation: false,
  }
}

async function harness(): Promise<{
  readonly root: string
  readonly storageRoot: string
  readonly authority: PluginOwnedDataAuthorityStore
  readonly remover: PluginOwnedDataRemover
}> {
  const root = join(tmpdir(), `dsh-plugin-owned-data-${process.pid}-${String(roots.length)}`)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  roots.push(root)
  const journal = new PluginOperationJournal(join(root, 'journal'))
  const controller = new PluginOperationController(
    journal,
    async (_request, controls) => {
      await controls.recordFoundation(fingerprint(true), {
        snapshotId: 'owned-snapshot-1',
        snapshotSha256: 'a'.repeat(64),
        profileIdentity: { profileName: 'web', rootSha256: 'b'.repeat(64) },
        runtimeEvidence: runtimeEvidence(),
      })
      return {
        hostGeneration: 2,
        fingerprint: fingerprint(false),
        runtimeEvidence: runtimeEvidence(),
      }
    },
    () => ({ profileName: 'web', rootSha256: 'b'.repeat(64) }),
    async () => {},
    clock(),
    () => OPERATION_ID,
  )
  await controller.initialize()
  const started = await controller.manage({
    pluginId: PLUGIN_ID,
    version: VERSION,
    action: 'uninstall',
    idempotencyKey: 'uninstall:fixture.owned-data:1',
  })
  expect(started.kind).toBe('started')
  await controller.whenSettled()
  expect(controller.getOperation()).toMatchObject({ action: 'uninstall', phase: 'committed' })

  const authority = new PluginOwnedDataAuthorityStore(join(root, 'authority'))
  await authority.capture({
    operationId: OPERATION_ID,
    pluginId: PLUGIN_ID,
    packageName: PACKAGE_NAME,
    version: VERSION,
    declarations: [
      { path: 'cache', label: 'Generated cache' },
      { path: 'logs', label: 'Plugin logs' },
    ],
  })
  const storageRoot = join(root, 'plugin-data')
  return {
    root,
    storageRoot,
    authority,
    remover: new PluginOwnedDataRemover(storageRoot, journal, authority),
  }
}

describe('post-uninstall plugin-owned data removal', () => {
  it('restores the committed offer after a renderer reload and durably records retention', async () => {
    const value = await harness()
    await expect(value.remover.currentOffer()).resolves.toEqual({
      operationId: OPERATION_ID,
      pluginId: PLUGIN_ID,
      packageName: PACKAGE_NAME,
      version: VERSION,
      declarations: [
        { path: 'cache', label: 'Generated cache' },
        { path: 'logs', label: 'Plugin logs' },
      ],
    })
    await expect(value.remover.retain({
      operationId: OPERATION_ID,
      pluginId: PLUGIN_ID,
      confirmation: 'retain-owned-data',
    })).resolves.toEqual({ operationId: OPERATION_ID, pluginId: PLUGIN_ID, retained: true })
    await expect(value.remover.currentOffer()).resolves.toBeNull()
  })

  it('deletes only separately confirmed declared paths and retains other plugin and application data', async () => {
    const value = await harness()
    const pluginRoot = join(value.storageRoot, PLUGIN_ID)
    const applicationConfig = join(value.root, 'config', 'plugins', `${PLUGIN_ID}.json`)
    await mkdir(join(pluginRoot, 'cache'), { recursive: true })
    await mkdir(join(pluginRoot, 'logs'), { recursive: true })
    await mkdir(join(value.root, 'config', 'plugins'), { recursive: true })
    await writeFile(join(pluginRoot, 'cache', 'index.bin'), 'cache')
    await writeFile(join(pluginRoot, 'logs', 'current.log'), 'keep')
    await writeFile(applicationConfig, '{"retained":true}\n')

    await expect(value.remover.remove({
      operationId: OPERATION_ID,
      pluginId: PLUGIN_ID,
      paths: ['cache'],
      confirmation: 'remove-owned-data',
    })).resolves.toEqual({
      operationId: OPERATION_ID,
      pluginId: PLUGIN_ID,
      removedPaths: ['cache'],
    })
    await expect(readFile(join(pluginRoot, 'cache', 'index.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(pluginRoot, 'logs', 'current.log'), 'utf8')).resolves.toBe('keep')
    await expect(readFile(applicationConfig, 'utf8')).resolves.toBe('{"retained":true}\n')
  })

  it('rejects traversal, undeclared paths, missing confirmation, and system or local identities', async () => {
    const value = await harness()
    await expect(value.remover.remove({
      operationId: OPERATION_ID,
      pluginId: PLUGIN_ID,
      paths: ['../config'],
      confirmation: 'remove-owned-data',
    })).rejects.toThrow('portable relative owned-data path')
    await expect(value.remover.remove({
      operationId: OPERATION_ID,
      pluginId: PLUGIN_ID,
      paths: ['secrets'],
      confirmation: 'remove-owned-data',
    })).rejects.toThrow('undeclared')
    await expect(value.remover.remove({
      operationId: OPERATION_ID,
      pluginId: PLUGIN_ID,
      paths: ['cache'],
      confirmation: 'retain-owned-data',
    })).rejects.toThrow('must equal remove-owned-data')
    await expect(value.remover.remove({
      operationId: OPERATION_ID,
      pluginId: 'system.base',
      paths: ['cache'],
      confirmation: 'remove-owned-data',
    })).rejects.toThrow('matching committed uninstall')
    await expect(value.remover.remove({
      operationId: OPERATION_ID,
      pluginId: 'local.bundle',
      paths: ['cache'],
      confirmation: 'remove-owned-data',
    })).rejects.toThrow('matching committed uninstall')
  })

  it('refuses a selected tree containing a symbolic link without touching its target', async () => {
    const value = await harness()
    const pluginRoot = join(value.storageRoot, PLUGIN_ID)
    const outside = join(value.root, 'outside.txt')
    await mkdir(join(pluginRoot, 'cache'), { recursive: true })
    await writeFile(outside, 'outside')
    await symlink(outside, join(pluginRoot, 'cache', 'outside-link'))

    await expect(value.remover.remove({
      operationId: OPERATION_ID,
      pluginId: PLUGIN_ID,
      paths: ['cache'],
      confirmation: 'remove-owned-data',
    })).rejects.toThrow('refuses symbolic links')
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside')
  })
})
