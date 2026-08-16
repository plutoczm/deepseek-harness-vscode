// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginCenterTab, type PluginCenterTabProps } from '../src/client/PluginCenterTab.tsx'
import { en, type PluginCenterLocaleKey } from '../src/client/locales.ts'
import {
  compatibilityDecision,
  detail,
  detailResult,
  installedListResult,
  listResult,
  operation,
} from './fixtures.ts'

afterEach(cleanup)

const t = ((key: PluginCenterLocaleKey): string => en[key]) as PluginCenterTabProps['t']

function props(values: Partial<PluginCenterTabProps> = {}): PluginCenterTabProps {
  return {
    available: true,
    development: true,
    list: async query => listResult(query),
    refresh: async query => listResult(query),
    detail: async () => detailResult(detail()),
    checkCompatibility: async () => compatibilityDecision(),
    listInstalled: async () => installedListResult(),
    openPluginSettings: () => {},
    mutationsEnabled: true,
    install: async () => { throw new Error('not used') },
    manage: async request => ({
      kind: 'started',
      operation: { ...operation(), action: request.action, version: request.version, idempotencyKey: request.idempotencyKey },
    }),
    getOwnedDataOffer: async () => null,
    removeOwnedData: async request => ({
      operationId: request.operationId,
      pluginId: request.pluginId,
      removedPaths: request.paths,
    }),
    retainOwnedData: async request => ({
      operationId: request.operationId,
      pluginId: request.pluginId,
      retained: true,
    }),
    getOperation: async () => null,
    onOperationState: () => () => {},
    t,
    ...values,
  } as PluginCenterTabProps
}

function row(name: string): HTMLElement {
  for (const label of screen.getAllByText(name)) {
    const match = label.closest('li[data-source]')
    if (match !== null) return match as HTMLElement
  }
  throw new Error(`installed row not found: ${name}`)
}

describe('retained management paths', () => {
  it('shows authority-derived system, catalog, disabled, and local rows and keeps existing Settings links reachable', async () => {
    const openPluginSettings = vi.fn<PluginCenterTabProps['openPluginSettings']>()
    render(<PluginCenterTab {...props({ openPluginSettings })} />)

    fireEvent.click(await screen.findByRole('button', { name: en.manageInstalled }))
    expect(await screen.findByText('Harness system')).toBeTruthy()
    expect(within(row('Harness system')).getByText(en.installedSourceSystem)).toBeTruthy()
    expect(within(row('Harness system')).getByText(en.protectedPlugin)).toBeTruthy()
    expect(within(row('Workspace tools')).getByText(en.installedSourceCatalog)).toBeTruthy()
    expect(row('Workspace tools').getAttribute('data-installed-plugin')).toBe('fixture.workspace-tools')
    expect(row('Workspace tools').getAttribute('data-installed-package')).toBe('@fixture/workspace-tools')
    expect(row('Workspace tools').querySelector(
      'img[src="https://avatars.githubusercontent.com/fixture?s=128"]',
    )).not.toBeNull()
    expect(within(row('Harness basics')).getByText(en.bundleDisabled)).toBeTruthy()
    expect(within(row('Harness basics')).getByText(en.runtimeInactive)).toBeTruthy()
    expect(within(row('Harness basics')).getByText(/Incompatible with this release/u)).toBeTruthy()
    expect(within(row('Harness basics')).getByText(/Desktop version is unsupported/u)).toBeTruthy()
    expect(within(row('Harness basics')).queryByText('desktop-version-unsupported: desktopVersion')).toBeNull()
    expect(within(row('Local developer Bundle')).getByText(en.installedSourceLocal)).toBeTruthy()
    expect(within(row('Local developer Bundle')).getByText(en.runtimeFailed)).toBeTruthy()
    expect(within(row('Harness system')).queryByRole('button', { name: en.uninstallPlugin })).toBeNull()
    expect(within(row('Local developer Bundle')).queryByRole('button', { name: en.uninstallPlugin })).toBeNull()

    fireEvent.click(within(row('Workspace tools')).getByRole('button', { name: en.openConfiguration }))
    expect(openPluginSettings).toHaveBeenCalledWith('configurable')
    fireEvent.click(within(row('Workspace tools')).getByRole('button', { name: en.openRuntimeInventory }))
    expect(openPluginSettings).toHaveBeenCalledWith('all')
    expect(screen.getByText('Harness basics')).toBeTruthy()
  })

  it('requires exact update and uninstall confirmation before starting the shared operation', async () => {
    const manage = vi.fn<PluginCenterTabProps['manage']>(async request => ({
      kind: 'started',
      operation: {
        ...operation('committed'),
        action: request.action,
        version: request.version,
        idempotencyKey: request.idempotencyKey,
      },
    }))
    render(<PluginCenterTab {...props({ manage })} />)
    fireEvent.click(await screen.findByRole('button', { name: en.manageInstalled }))
    await waitFor(() => { expect(row('Workspace tools')).toBeTruthy() })

    fireEvent.click(within(row('Workspace tools')).getByRole('button', { name: en.updatePlugin }))
    const confirmation = screen.getByRole('dialog', { name: `${en.confirmUpdateTitle} · Workspace tools` })
    expect(within(confirmation).getByRole('heading', { name: `${en.confirmUpdateTitle} · Workspace tools` })).toBeTruthy()
    expect(screen.getByText('1.1.0')).toBeTruthy()
    expect(screen.getByText('Adds file write authority.')).toBeTruthy()
    expect(manage).not.toHaveBeenCalled()
    const updateConfirm = within(confirmation).getByRole('button', { name: en.updatePlugin })
    expect(updateConfirm).toHaveProperty('disabled', true)
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: en.confirmUpdateAcknowledge }))
    fireEvent.click(updateConfirm)
    await waitFor(() => {
      expect(manage).toHaveBeenCalledWith(expect.objectContaining({
        pluginId: 'fixture.workspace-tools', action: 'update', version: '1.1.0',
      }))
    })
    expect(await screen.findByRole('heading', { name: en.updateComplete })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.done }))

    fireEvent.click(within(row('Workspace tools')).getByRole('button', { name: en.uninstallPlugin }))
    expect(screen.getByText(en.configurationRetained)).toBeTruthy()
    expect(screen.getByText(en.ownedDataRetained)).toBeTruthy()
    expect(manage).toHaveBeenCalledTimes(1)
  })

  it('offers declared owned-data deletion only after uninstall commits and requires a separate confirmation', async () => {
    const manage = vi.fn<PluginCenterTabProps['manage']>(async request => ({
      kind: 'started',
      operation: {
        ...operation('committed'),
        action: request.action,
        version: request.version,
        idempotencyKey: request.idempotencyKey,
      },
    }))
    const removeOwnedData = vi.fn<PluginCenterTabProps['removeOwnedData']>(async request => ({
      operationId: request.operationId,
      pluginId: request.pluginId,
      removedPaths: request.paths,
    }))
    render(<PluginCenterTab {...props({ manage, removeOwnedData })} />)
    fireEvent.click(await screen.findByRole('button', { name: en.manageInstalled }))
    await waitFor(() => { expect(row('Workspace tools')).toBeTruthy() })

    fireEvent.click(within(row('Workspace tools')).getByRole('button', { name: en.uninstallPlugin }))
    const uninstall = screen.getByRole('dialog', { name: `${en.confirmUninstallTitle} · Workspace tools` })
    fireEvent.click(within(uninstall).getByRole('checkbox', { name: en.confirmUninstallAcknowledge }))
    fireEvent.click(within(uninstall).getByRole('button', { name: en.uninstallPlugin }))
    expect(await screen.findByRole('heading', { name: en.uninstallComplete })).toBeTruthy()
    expect(removeOwnedData).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.done }))

    const deletion = await screen.findByRole('dialog', { name: `${en.ownedDataRemovalTitle} · Workspace tools` })
    expect(within(deletion).getByRole('checkbox', { name: /Workspace cache/u })).toHaveProperty('checked', true)
    const remove = within(deletion).getByRole('button', { name: en.removeSelectedOwnedData })
    expect(remove).toHaveProperty('disabled', true)
    fireEvent.click(within(deletion).getByRole('checkbox', { name: en.confirmOwnedDataRemoval }))
    fireEvent.click(remove)
    await waitFor(() => {
      expect(removeOwnedData).toHaveBeenCalledWith({
        operationId: 'operation-1',
        pluginId: 'fixture.workspace-tools',
        paths: ['cache'],
        confirmation: 'remove-owned-data',
      })
    })
    expect(await within(deletion).findByText(`${en.ownedDataRemoved} 1`)).toBeTruthy()
  })

  it('restores a committed uninstall offer after renderer reload and durably retains data', async () => {
    const committed = {
      ...operation('committed'),
      action: 'uninstall',
      idempotencyKey: 'uninstall:fixture.workspace-tools:1.0.0:1',
    } as const
    const getOwnedDataOffer = vi.fn<NonNullable<PluginCenterTabProps['getOwnedDataOffer']>>(async () => ({
      operationId: committed.operationId,
      pluginId: committed.pluginId,
      packageName: '@fixture/dsh-workspace-tools',
      version: committed.version,
      declarations: [{ path: 'cache', label: 'Workspace cache' }],
    }))
    const retainOwnedData = vi.fn<NonNullable<PluginCenterTabProps['retainOwnedData']>>(async request => ({
      operationId: request.operationId,
      pluginId: request.pluginId,
      retained: true,
    }))
    render(<PluginCenterTab {...props({
      getOperation: async () => committed,
      getOwnedDataOffer,
      retainOwnedData,
    })} />)

    const deletion = await screen.findByRole('dialog', {
      name: `${en.ownedDataRemovalTitle} · @fixture/dsh-workspace-tools`,
    })
    expect(getOwnedDataOffer).toHaveBeenCalledOnce()
    fireEvent.click(within(deletion).getByRole('button', { name: en.retainOwnedData }))
    await waitFor(() => {
      expect(retainOwnedData).toHaveBeenCalledWith({
        operationId: committed.operationId,
        pluginId: committed.pluginId,
        confirmation: 'retain-owned-data',
      })
      expect(screen.queryByRole('dialog', {
        name: `${en.ownedDataRemovalTitle} · @fixture/dsh-workspace-tools`,
      })).toBeNull()
    })
  })

  it('refreshes after uninstall and allows the same plugin to be installed again', async () => {
    let removed = false
    const listInstalled = vi.fn<PluginCenterTabProps['listInstalled']>(async () => {
      const result = installedListResult()
      return {
        ...result,
        items: result.items.flatMap(item => item.pluginId === 'fixture.workspace-tools'
          ? removed ? [] : [{ ...item, ownedData: [] }]
          : [item]),
      }
    })
    const manage = vi.fn<PluginCenterTabProps['manage']>(async (request) => {
      removed = true
      return {
        kind: 'started',
        operation: {
          ...operation('committed'),
          action: request.action,
          version: request.version,
          idempotencyKey: request.idempotencyKey,
        },
      }
    })
    const install = vi.fn<PluginCenterTabProps['install']>(async request => ({
      kind: 'started',
      operation: { ...operation(), idempotencyKey: request.idempotencyKey },
    }))
    render(<PluginCenterTab {...props({ listInstalled, manage, install })} />)

    fireEvent.click(await screen.findByRole('button', { name: en.manageInstalled }))
    await waitFor(() => { expect(row('Workspace tools')).toBeTruthy() })
    fireEvent.click(within(row('Workspace tools')).getByRole('button', { name: en.uninstallPlugin }))
    const confirmation = screen.getByRole('dialog', { name: `${en.confirmUninstallTitle} · Workspace tools` })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: en.confirmUninstallAcknowledge }))
    fireEvent.click(within(confirmation).getByRole('button', { name: en.uninstallPlugin }))

    expect(await screen.findByRole('heading', { name: en.uninstallComplete })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.done }))
    const quickInstall = (await screen.findAllByRole('button', { name: en.install }))[0]!
    fireEvent.click(quickInstall)
    const installConfirmation = await screen.findByRole('dialog', {
      name: `${en.confirmInstallTitle} · Workspace tools`,
    })
    fireEvent.click(within(installConfirmation).getByRole('checkbox', { name: en.confirmInstallAcknowledge }))
    fireEvent.click(within(installConfirmation).getByRole('button', { name: en.confirmInstall }))

    await waitFor(() => {
      expect(manage).toHaveBeenCalledWith(expect.objectContaining({
        pluginId: 'fixture.workspace-tools', action: 'uninstall', version: '1.0.0',
      }))
      expect(install).toHaveBeenCalledWith(expect.objectContaining({
        pluginId: 'fixture.workspace-tools', version: '1.0.0',
      }))
    })
  })
})
