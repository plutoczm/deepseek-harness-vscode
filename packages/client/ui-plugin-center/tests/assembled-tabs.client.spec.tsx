// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { PluginCenterNavItem, type PluginCenterNavProps } from '../src/client/PluginCenterNavItem.tsx'
import { PluginCenterTab, type PluginCenterTabProps } from '../src/client/PluginCenterTab.tsx'
import { en, type PluginCenterLocaleKey } from '../src/client/locales.ts'
import { compatibilityDecision, installedListResult, listResult } from './fixtures.ts'

afterEach(cleanup)

const t = ((key: PluginCenterLocaleKey): string => en[key]) as PluginCenterTabProps['t']
const neverHook = (() => { throw new Error('test component must not read global hooks') }) as never

function AssembledFirstLevelPage() {
  const [primaryPage, setPrimaryPage] = useState<string | null>(null)
  const common = { useSessions: neverHook, useWorkspaces: neverHook }
  const pageProps = {
    ...common,
    available: true,
    development: false,
    list: async query => listResult(query),
    refresh: async query => listResult(query),
    detail: async () => ({
      etag: 'fixture-v1', generatedAt: '2026-08-15T04:00:00.000Z', freshness: 'fresh', source: 'network', detail: null,
    } as const),
    checkCompatibility: async () => compatibilityDecision(),
    listInstalled: async () => installedListResult(),
    openPluginSettings: () => {},
    mutationsEnabled: false,
    install: async () => { throw new Error('release gated') },
    manage: async () => { throw new Error('release gated') },
    getOperation: async () => null,
    onOperationState: () => () => {},
    t,
  } as PluginCenterTabProps
  const navProps = {
    ...common,
    wide: true,
    primaryPage,
    pageId: 'plugin-center',
    open: () => { setPrimaryPage('plugin-center') },
    t,
  } as PluginCenterNavProps
  return (
    <>
      <PluginCenterNavItem {...navProps} />
      {primaryPage === 'plugin-center' ? <PluginCenterTab {...pageProps} /> : <div>Conversation</div>}
    </>
  )
}

it('opens the independent Plugin page from the first-level sidebar action', async () => {
  render(<AssembledFirstLevelPage />)
  const entry = screen.getByRole('button', { name: en.nav })
  expect(entry.getAttribute('aria-current')).toBeNull()
  expect(screen.getByText('Conversation')).toBeTruthy()

  fireEvent.click(entry)
  expect(screen.queryByText('Conversation')).toBeNull()
  expect(screen.getByRole('button', { name: en.nav }).getAttribute('aria-current')).toBe('page')
  const search = await screen.findByRole('searchbox', { name: en.searchPlugins })
  fireEvent.change(search, { target: { value: 'Workspace' } })
  expect((search as HTMLInputElement).value).toBe('Workspace')
})
