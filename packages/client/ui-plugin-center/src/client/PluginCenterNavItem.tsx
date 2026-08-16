import { IconCordisPluginOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PluginCenterNavItem.module.css'

/** Registration-side navigation action. */
export interface PluginCenterNavInjected {
  readonly pageId: string
  readonly open: () => void
}

/** Full props of the sidebar first-level Plugin entry. */
export type PluginCenterNavProps =
  PropsRuntime<'sidebar.primary.action'>
  & PropsLocale<'pluginCenter'>
  & InjectFace<PluginCenterNavInjected>

/** First-level sidebar entry that opens the independent Plugin page. */
export function PluginCenterNavItem({ wide, primaryPage, pageId, open, t }: PluginCenterNavProps) {
  const selected = primaryPage === pageId
  return (
    <Tooltip label={t('nav')} delayMs={500} disabled={wide}>
      <button
        type="button"
        className={`${css.entry}${wide ? '' : ` ${css.rail}`}`}
        aria-current={selected ? 'page' : undefined}
        aria-label={t('nav')}
        data-selected={selected || undefined}
        onClick={open}
      >
        <IconCordisPluginOutline14 size={wide ? 16 : 18} />
        {wide ? <span>{t('nav')}</span> : null}
      </button>
    </Tooltip>
  )
}
