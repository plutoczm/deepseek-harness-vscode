import type { ReactNode } from 'react'
import type {
  InstalledPluginListResult,
  InstalledPluginProjection,
  PluginManagementAction,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import type { PluginCenterTabProps } from './PluginCenterTab.tsx'
import { installedCompatibilityReason } from './compatibility-copy.ts'
import type { PluginCenterLocaleKey } from './locales.ts'
import css from './PluginCenterTab.module.css'

export type InstalledViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly result: InstalledPluginListResult }

const SOURCE_KEYS = {
  system: 'installedSourceSystem',
  catalog: 'installedSourceCatalog',
  local: 'installedSourceLocal',
} as const satisfies Record<InstalledPluginProjection['source'], PluginCenterLocaleKey>

const RUNTIME_KEYS = {
  running: 'runtimeRunning',
  inactive: 'runtimeInactive',
  failed: 'runtimeFailed',
  unknown: 'runtimeUnknown',
} as const satisfies Record<InstalledPluginProjection['runtimeStatus'], PluginCenterLocaleKey>

const ACTION_KEYS = {
  update: 'updatePlugin',
  enable: 'enablePlugin',
  disable: 'disablePlugin',
  uninstall: 'uninstallPlugin',
} as const satisfies Record<PluginManagementAction, PluginCenterLocaleKey>

function InstalledMark({ item }: { readonly item: InstalledPluginProjection }) {
  return (
    <span
      className={css.installedMark}
      style={{ background: item.brandColor ?? undefined }}
      aria-hidden="true"
      data-source={item.source}
    >
      {item.displayName.slice(0, 1).toLocaleUpperCase()}
      {item.icon === null ? null : (
        <img
          key={item.icon.url}
          src={item.icon.url}
          alt=""
          width={item.icon.width}
          height={item.icon.height}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(event) => { event.currentTarget.hidden = true }}
        />
      )}
    </span>
  )
}

/** Compact installed strip whose rows come only from the Desktop projection. */
export function InstalledIcons({ state, onOpen, t }: {
  readonly state: InstalledViewState
  readonly onOpen: () => void
  readonly t: PluginCenterTabProps['t']
}): ReactNode {
  if (state.status === 'loading') {
    return (
      <span className={css.installedSkeleton} role="status" aria-label={t('installedLoading')}>
        {[0, 1, 2, 3, 4, 5, 6].map(index => <span key={index} aria-hidden="true" />)}
      </span>
    )
  }
  if (state.status === 'error') return <span className={css.installedEmpty}>{t('installedError')}</span>
  if (state.result.items.length === 0) return <span className={css.installedEmpty}>{t('installedEmpty')}</span>
  return state.result.items.map(item => (
    <button
      key={item.packageName}
      type="button"
      aria-label={`${t('manageInstalled')}：${item.displayName}`}
      title={`${item.displayName} · ${t(RUNTIME_KEYS[item.runtimeStatus])}`}
      onClick={onOpen}
    >
      <InstalledMark item={item} />
    </button>
  ))
}

/** Expanded management rows with retained links into the existing Settings owners. */
export function InstalledPluginsPanel({ state, mutationsEnabled, onRetry, onSettings, onAction, t }: {
  readonly state: InstalledViewState
  readonly mutationsEnabled: boolean
  readonly onRetry: () => void
  readonly onSettings: (tabId: 'configurable' | 'all') => void
  readonly onAction: (item: InstalledPluginProjection, action: PluginManagementAction) => void
  readonly t: PluginCenterTabProps['t']
}): ReactNode {
  if (state.status === 'loading') return <p className={css.installedPanelStatus}>{t('installedLoading')}</p>
  if (state.status === 'error') {
    return (
      <div className={css.installedPanelStatus} role="alert">
        <span>{t('installedError')}</span>
        <button type="button" onClick={onRetry}>{t('retry')}</button>
      </div>
    )
  }
  if (state.result.items.length === 0) return <p className={css.installedPanelStatus}>{t('installedEmpty')}</p>
  return (
    <ul className={css.installedRows} data-profile-revision={state.result.profileRevision}>
      {state.result.items.map((item) => {
        const compatibilityReason = installedCompatibilityReason(item.compatibilityReason, t)
        return (
          <li
            key={item.packageName}
            className={css.installedRow}
            data-source={item.source}
            data-installed-plugin={item.pluginId ?? item.packageName}
            data-installed-package={item.packageName}
          >
            <InstalledMark item={item} />
            <div className={css.installedRowBody}>
              <div className={css.installedRowTitle}>
                <strong>{item.displayName}</strong>
                <span>{t(SOURCE_KEYS[item.source])}</span>
                {item.protected ? <span>{t('protectedPlugin')}</span> : null}
                {item.pendingAction !== null ? <span>{t('operationPending')}</span> : null}
              </div>
              <div className={css.installedRowMeta}>
                <span>{item.version ?? t('versionUnknown')}</span>
                <span>{item.enabled ? t('bundleEnabled') : t('bundleDisabled')}</span>
                <span data-runtime={item.runtimeStatus}>{t(RUNTIME_KEYS[item.runtimeStatus])}</span>
                {item.compatibility === 'incompatible' ? (
                  <span data-compatibility="incompatible" title={item.compatibilityReason ?? undefined}>
                    {t('installedIncompatible')}{compatibilityReason === null ? '' : ` · ${compatibilityReason}`}
                  </span>
                ) : null}
                {item.update !== null ? <span>{t('updateAvailable')} {item.update.version}</span> : null}
              </div>
              <code>{item.packageName}</code>
            </div>
            <div className={css.installedRowActions}>
              {item.configurationEntryIds.length > 0 ? (
                <button type="button" onClick={() => { onSettings('configurable') }}>{t('openConfiguration')}</button>
              ) : null}
              <button type="button" onClick={() => { onSettings('all') }}>{t('openRuntimeInventory')}</button>
              {item.supportedActions.map(action => (
                <button
                  key={action}
                  type="button"
                  disabled={!mutationsEnabled || item.pendingAction !== null}
                  data-action={action}
                  onClick={() => { onAction(item, action) }}
                >
                  {t(ACTION_KEYS[action])}
                </button>
              ))}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
