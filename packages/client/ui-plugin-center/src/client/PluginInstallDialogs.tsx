import type {
  CatalogSummary,
  CompatibilityDecision,
  InstalledPluginProjection,
  InstalledPluginOwnedData,
  PluginManagementAction,
  PluginOperationSnapshot,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import {
  Button, IconCheckOutline16, IconWarningOutline16, Modal, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PluginCenterTabProps } from './PluginCenterTab.tsx'
import type { PluginCenterLocaleKey } from './locales.ts'
import {
  PLUGIN_OPERATION_GROUPS,
  PLUGIN_OPERATION_PHASE_KEYS,
  PLUGIN_OPERATION_PHASES,
  type TrustedInstallPhase,
  isTrustedInstallPhase,
  isTerminalOperationPhase,
} from './operation-phases.ts'
import css from './PluginCenterTab.module.css'

type Translator = PluginCenterTabProps['t']

const ignoreClose = (): void => {}

const MANAGEMENT_TITLE_KEYS = {
  update: 'confirmUpdateTitle',
  enable: 'confirmEnableTitle',
  disable: 'confirmDisableTitle',
  uninstall: 'confirmUninstallTitle',
} as const

const MANAGEMENT_INTRO_KEYS = {
  update: 'confirmUpdateIntro',
  enable: 'confirmEnableIntro',
  disable: 'confirmDisableIntro',
  uninstall: 'confirmUninstallIntro',
} as const

const MANAGEMENT_ACKNOWLEDGEMENT_KEYS = {
  update: 'confirmUpdateAcknowledge',
  enable: 'confirmEnableAcknowledge',
  disable: 'confirmDisableAcknowledge',
  uninstall: 'confirmUninstallAcknowledge',
} as const

const MANAGEMENT_ACTION_KEYS = {
  update: 'updatePlugin',
  enable: 'enablePlugin',
  disable: 'disablePlugin',
  uninstall: 'uninstallPlugin',
} as const

const MANAGEMENT_COMPLETE_KEYS = {
  update: 'updateComplete',
  enable: 'enableComplete',
  disable: 'disableComplete',
  uninstall: 'uninstallComplete',
} as const satisfies Record<PluginManagementAction, PluginCenterLocaleKey>

const MANAGEMENT_COMMITTED_KEYS = {
  update: 'updateCommitted',
  enable: 'enableCommitted',
  disable: 'disableCommitted',
  uninstall: 'uninstallCommitted',
} as const satisfies Record<PluginManagementAction, PluginCenterLocaleKey>

function progressState(
  phase: TrustedInstallPhase,
  groupIndex: number,
): 'done' | 'current' | 'pending' {
  if (phase === 'committed') return 'done'
  const currentIndex = PLUGIN_OPERATION_PHASES.indexOf(phase)
  const phases = PLUGIN_OPERATION_GROUPS[groupIndex]?.phases ?? []
  const firstIndex = PLUGIN_OPERATION_PHASES.indexOf(phases[0] ?? 'preflight')
  const lastIndex = PLUGIN_OPERATION_PHASES.indexOf(phases.at(-1) ?? 'preflight')
  if (currentIndex > lastIndex) return 'done'
  if (currentIndex >= firstIndex) return 'current'
  return 'pending'
}

/**
 * Ask for one explicit acknowledgement before sending a trusted install intent.
 * @param props - Exact catalog version, compatibility decision, and controlled actions.
 * @returns The controlled confirmation modal.
 */
export function PluginInstallConfirmation({
  open,
  entry,
  decision,
  acknowledged,
  onAcknowledgedChange,
  onCancel,
  onConfirm,
  t,
}: {
  readonly open: boolean
  readonly entry: CatalogSummary
  readonly decision: CompatibilityDecision
  readonly acknowledged: boolean
  readonly onAcknowledgedChange: (value: boolean) => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
  readonly t: Translator
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={`${t('confirmInstallTitle')} · ${entry.displayName}`}
      closeLabel={t('close')}
      description={t('confirmInstallIntro')}
      className={css.installConfirmDialog ?? ''}
      contentClassName={css.installConfirmContent ?? ''}
      footer={(
        <>
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" disabled={!acknowledged} onClick={onConfirm}>
            {t('confirmInstall')}
          </Button>
        </>
      )}
    >
      <dl className={css.installSummary}>
        <div><dt>{t('publisher')}</dt><dd>{entry.publisher}</dd></div>
        <div><dt>{t('confirmInstallVersion')}</dt><dd>{entry.version}</dd></div>
        <div><dt>{t('restartRequired')}</dt><dd>{t(decision.restartRequired ? 'restartYes' : 'restartNo')}</dd></div>
      </dl>
      <div className={css.confirmWarning}>
        <IconWarningOutline16 size={16} aria-hidden="true" />
        <span>
          <strong>{t('authorityTitle')}</strong>
          <span>{t('confirmInstallAuthority')}</span>
        </span>
      </div>
      <label className={css.installAcknowledgement}>
        <input
          type="checkbox"
          checked={acknowledged}
          autoFocus
          onChange={(event) => { onAcknowledgedChange(event.currentTarget.checked) }}
        />
        <span>{t('confirmInstallAcknowledge')}</span>
      </label>
    </Modal>
  )
}

/** Confirm one installed-item mutation without folding owned-data deletion into uninstall. */
export function PluginManagementConfirmation({
  open,
  item,
  action,
  acknowledged,
  onAcknowledgedChange,
  onCancel,
  onConfirm,
  t,
}: {
  readonly open: boolean
  readonly item: InstalledPluginProjection
  readonly action: PluginManagementAction
  readonly acknowledged: boolean
  readonly onAcknowledgedChange: (value: boolean) => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
  readonly t: Translator
}) {
  const targetVersion = action === 'update' ? item.update?.version ?? null : item.version
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={`${t(MANAGEMENT_TITLE_KEYS[action])} · ${item.displayName}`}
      closeLabel={t('close')}
      description={t(MANAGEMENT_INTRO_KEYS[action])}
      className={css.installConfirmDialog ?? ''}
      contentClassName={css.installConfirmContent ?? ''}
      footer={(
        <>
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" disabled={!acknowledged} onClick={onConfirm}>
            {t(MANAGEMENT_ACTION_KEYS[action])}
          </Button>
        </>
      )}
    >
      <dl className={css.installSummary}>
        <div><dt>{t('currentVersion')}</dt><dd>{item.version ?? t('versionUnknown')}</dd></div>
        {action === 'update' ? <div><dt>{t('targetVersion')}</dt><dd>{targetVersion}</dd></div> : null}
        <div><dt>{t('restartRequired')}</dt><dd>{t('restartYes')}</dd></div>
      </dl>
      {action === 'update' && item.update !== null ? (
        <div className={css.confirmWarning}>
          <IconWarningOutline16 size={16} aria-hidden="true" />
          <span>
            <strong>{t('riskChange')}</strong>
            <span>{item.update.changelog}</span>
            <span>{item.update.riskSummary}</span>
          </span>
        </div>
      ) : null}
      {action === 'uninstall' ? (
        <div className={css.confirmWarning}>
          <IconWarningOutline16 size={16} aria-hidden="true" />
          <span>
            <strong>{t('configurationRetained')}</strong>
            <span>{t('ownedDataRetained')}</span>
          </span>
        </div>
      ) : null}
      <label className={css.installAcknowledgement}>
        <input
          type="checkbox"
          checked={acknowledged}
          autoFocus
          onChange={(event) => { onAcknowledgedChange(event.currentTarget.checked) }}
        />
        <span>{t(MANAGEMENT_ACKNOWLEDGEMENT_KEYS[action])}</span>
      </label>
    </Modal>
  )
}

/**
 * Keep uninstall separate from the optional permanent deletion of declared plugin-owned data.
 * @param props - Controlled declarations, selection, acknowledgement, progress, and actions.
 * @returns The post-uninstall deletion modal.
 */
export function PluginOwnedDataRemovalConfirmation({
  open,
  displayName,
  declarations,
  selectedPaths,
  acknowledged,
  status,
  retaining,
  removedCount,
  onSelectionChange,
  onAcknowledgedChange,
  onRetain,
  onRemove,
  onDone,
  t,
}: {
  readonly open: boolean
  readonly displayName: string
  readonly declarations: readonly InstalledPluginOwnedData[]
  readonly selectedPaths: readonly string[]
  readonly acknowledged: boolean
  readonly status: 'idle' | 'removing' | 'removed' | 'failed'
  readonly retaining: boolean
  readonly removedCount: number
  readonly onSelectionChange: (paths: readonly string[]) => void
  readonly onAcknowledgedChange: (value: boolean) => void
  readonly onRetain: () => void
  readonly onRemove: () => void
  readonly onDone: () => void
  readonly t: Translator
}) {
  const busy = status === 'removing' || retaining
  const toggle = (path: string, selected: boolean): void => {
    onSelectionChange(selected
      ? [...selectedPaths, path]
      : selectedPaths.filter(value => value !== path))
  }
  return (
    <Modal
      open={open}
      onClose={busy ? ignoreClose : status === 'removed' ? onDone : onRetain}
      title={`${t('ownedDataRemovalTitle')} · ${displayName}`}
      closeLabel={t('close')}
      description={t('ownedDataRemovalIntro')}
      className={css.installConfirmDialog ?? ''}
      contentClassName={css.installConfirmContent ?? ''}
      footer={status === 'removed' ? (
        <Button variant="primary" onClick={onDone}>{t('done')}</Button>
      ) : (
        <>
          <Button variant="outline" disabled={busy} onClick={onRetain}>{t('retainOwnedData')}</Button>
          <Button
            variant="primary"
            disabled={busy || !acknowledged || selectedPaths.length === 0}
            onClick={onRemove}
          >
            {status === 'removing' ? t('removingOwnedData') : t('removeSelectedOwnedData')}
          </Button>
        </>
      )}
    >
      {status === 'removed' ? (
        <p className={css.ownedDataResult} role="status">{t('ownedDataRemoved')} {removedCount}</p>
      ) : (
        <>
          <div className={css.confirmWarning}>
            <IconWarningOutline16 size={16} aria-hidden="true" />
            <span>
              <strong>{t('ownedDataPermanentTitle')}</strong>
              <span>{t('ownedDataPermanentWarning')}</span>
            </span>
          </div>
          <fieldset className={css.ownedDataChoices} disabled={busy}>
            <legend>{t('selectOwnedData')}</legend>
            {declarations.map(declaration => (
              <label key={declaration.path}>
                <input
                  type="checkbox"
                  checked={selectedPaths.includes(declaration.path)}
                  onChange={(event) => { toggle(declaration.path, event.currentTarget.checked) }}
                />
                <span><strong>{declaration.label}</strong><code>{declaration.path}</code></span>
              </label>
            ))}
          </fieldset>
          <label className={css.installAcknowledgement}>
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => { onAcknowledgedChange(event.currentTarget.checked) }}
            />
            <span>{t('confirmOwnedDataRemoval')}</span>
          </label>
          {status === 'failed' ? <p className={css.ownedDataFailure} role="alert">{t('ownedDataRemovalFailed')}</p> : null}
        </>
      )}
    </Modal>
  )
}

/**
 * Present one restored Desktop operation as a compact, modal progress journey.
 * @param props - Controlled operation visibility, snapshot, close action, and copy.
 * @returns The active or terminal operation modal.
 */
export function PluginOperationDialog({
  open,
  operation,
  installedItem,
  onClose,
  t,
}: {
  readonly open: boolean
  readonly operation: PluginOperationSnapshot | null
  readonly installedItem: InstalledPluginProjection | null
  readonly onClose: () => void
  readonly t: Translator
}) {
  if (operation === null) return null
  const phase = operation.phase
  if (!isTrustedInstallPhase(phase)) return null
  const terminal = isTerminalOperationPhase(phase)
  const failed = phase === 'failed'
  const committed = phase === 'committed'
  const managementAction = operation.action === 'install' ? null : operation.action
  const clientUiLoaded = installedItem !== null
    && installedItem.pluginId === operation.pluginId
    && installedItem.version === operation.version
    && installedItem.runtime.clientModules.length > 0
  const title = managementAction !== null
    ? committed
      ? t(MANAGEMENT_COMPLETE_KEYS[managementAction])
      : failed
        ? t('managementFailed')
        : t('managementProgress')
    : committed
      ? t('installationComplete')
      : failed
        ? t('installationFailed')
        : t('installationProgress')
  return (
    <Modal
      open={open}
      onClose={terminal ? onClose : ignoreClose}
      title={title}
      headless
      className={css.installProgressDialog ?? ''}
    >
      <section
        className={css.installProgressContent}
        aria-live="polite"
        data-plugin-operation-phase={phase}
      >
        <header className={css.installProgressHeader}>
          <span className={css.installProgressState} data-state={failed ? 'failed' : committed ? 'done' : 'active'}>
            {failed
              ? <IconWarningOutline16 size={18} aria-hidden="true" />
              : committed
                ? <IconCheckOutline16 size={18} aria-hidden="true" />
                : <StateDot state="ongoing" size={14} />}
          </span>
          <div>
            <span className={css.installTarget}>{operation.pluginId}@{operation.version}</span>
            <h2>{title}</h2>
            <p>{managementAction !== null
              ? committed
                ? t(MANAGEMENT_COMMITTED_KEYS[managementAction])
                : failed
                  ? t('managementOperationFailed')
                  : t('managementInProgress')
              : committed
                ? t(clientUiLoaded ? 'operationCommittedClient' : 'operationCommitted')
                : failed
                  ? t('operationFailed')
                  : t(PLUGIN_OPERATION_PHASE_KEYS[phase])}</p>
          </div>
        </header>

        {failed ? (
          <div className={css.installFailure} role="alert">
            <strong>{t('operationNeedsRecovery')}</strong>
            <span>{t('operationFailureCode')}：{operation.failureCode}</span>
          </div>
        ) : (
          <ol className={css.installProgressSteps}>
            {PLUGIN_OPERATION_GROUPS.map((group, index) => {
              const state = progressState(phase, index)
              return (
                <li key={group.label} data-state={state}>
                  <span className={css.installStepMarker} aria-hidden="true">
                    {state === 'done'
                      ? <IconCheckOutline16 size={12} />
                      : state === 'current'
                        ? <StateDot state="ongoing" size={10} />
                        : null}
                  </span>
                  <span>{t(managementAction !== null && group.label === 'progressInstalling'
                    ? 'progressChanging'
                    : group.label)}</span>
                </li>
              )
            })}
          </ol>
        )}

        {!terminal ? <p className={css.installProgressHint}>{t('operationKeepOpen')}</p> : null}
        {terminal ? (
          <footer className={css.installProgressFooter}>
            <Button variant="primary" onClick={onClose}>{t('done')}</Button>
          </footer>
        ) : null}
      </section>
    </Modal>
  )
}
