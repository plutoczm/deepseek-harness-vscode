/** Visible browser capability contributed by the reviewed fixture Bundle. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

const PAGE_ID = 'fixture-workspace-tools'
const NS = 'pluginCenterFixture'

type FixtureLocaleKey = 'nav' | 'title' | 'description' | 'running'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    pluginCenterFixture: FixtureLocaleKey
  }
}

interface NavInjected {
  readonly pageId: string
  readonly open: () => void
}

type NavProps = PropsRuntime<'sidebar.primary.action'> & PropsLocale<'pluginCenterFixture'> & InjectFace<NavInjected>
type PageProps = PropsRuntime<'main.page'> & PropsLocale<'pluginCenterFixture'>

function FixtureNav({ wide, primaryPage, pageId, open, t }: NavProps) {
  return (
    <button
      type="button"
      aria-current={primaryPage === pageId ? 'page' : undefined}
      aria-label={t('nav')}
      data-plugin-center-fixture-nav="workspace-tools"
      onClick={open}
    >
      <span aria-hidden="true">◇</span>{wide ? <span>{t('nav')}</span> : null}
    </button>
  )
}

function FixturePage({ t }: PageProps) {
  return (
    <main data-plugin-center-fixture-capability="workspace-tools" style={{ padding: 40, maxWidth: 760 }}>
      <p style={{ color: '#5f8cff', fontWeight: 600 }}>{t('running')}</p>
      <h1>{t('title')}</h1>
      <p>{t('description')}</p>
    </main>
  )
}

export const inject = ['slots', 'layout', 'locale']

/** Register one first-level navigation action and observable capability page. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, {
    zh: {
      nav: '工作区工具',
      title: '工作区工具已运行',
      description: '这个页面由插件中心的受审查测试插件提供。',
      running: '插件运行中',
    },
    en: {
      nav: 'Workspace tools',
      title: 'Workspace tools are running',
      description: 'This page is contributed by the Plugin Center reviewed fixture.',
      running: 'Plugin running',
    },
  }), 'plugin-center-fixture: dictionaries')
  ctx.slots.inject('sidebar.primary.action', () => ctx.slots.register({
    name: 'sidebar.primary.action',
    id: PAGE_ID,
    order: 30,
    locale: NS,
    inject: () => ({ pageId: PAGE_ID, open: () => { ctx.layout.openPrimaryPage(PAGE_ID) } }),
  }, FixtureNav))
  ctx.slots.inject('main.page', () => ctx.slots.register({
    name: 'main.page',
    key: PAGE_ID,
    locale: NS,
  }, FixturePage))
  ctx.effect(() => () => { ctx.layout.closePrimaryPage(PAGE_ID) }, 'plugin-center-fixture: close page')
}
