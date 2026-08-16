import { useEffect, useState, type ReactNode } from 'react'
import type {
  CatalogCapability,
  CatalogDetailResult,
  CatalogSummary,
  CompatibilityDecision,
  PluginOperationSnapshot,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import {
  Button, IconChevronRightOutline14, IconPlusOutline16, IconWarningOutline16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PluginCenterTabProps } from './PluginCenterTab.tsx'
import { compatibilityReasonKey } from './compatibility-copy.ts'
import { PluginInstallConfirmation } from './PluginInstallDialogs.tsx'
import type { PluginCenterLocaleKey } from './locales.ts'
import {
  PLUGIN_OPERATION_PHASE_KEYS, isMutationBlockingOperationPhase, isTrustedInstallPhase,
} from './operation-phases.ts'
import css from './PluginCenterTab.module.css'

/** Async exact-version detail state. */
export type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly result: CatalogDetailResult }

/** Async exact-action preflight state. Local entries deliberately have no state. */
export type CompatibilityState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly result: CompatibilityDecision }

const COMPATIBILITY_KEYS = {
  compatible: 'compatible',
  incompatible: 'incompatible',
  unknown: 'unknown',
} satisfies Record<string, PluginCenterLocaleKey>

const RISK_KEYS = {
  low: 'lowRisk',
  medium: 'mediumRisk',
  high: 'highRisk',
} satisfies Record<string, PluginCenterLocaleKey>

const FRESHNESS_KEYS = {
  fresh: 'fresh',
  cached: 'cached',
  stale: 'stale',
} satisfies Record<string, PluginCenterLocaleKey>

const SOURCE_KEYS = {
  bundled: 'bundledSource',
  network: 'networkSource',
  cache: 'cacheSource',
} satisfies Record<string, PluginCenterLocaleKey>

const CAPABILITY_KEYS = {
  host: 'capabilityHost',
  client: 'capabilityClient',
  agent: 'capabilityAgent',
  tool: 'capabilityTool',
  'model-provider': 'capabilityModelProvider',
  skill: 'capabilitySkill',
  network: 'capabilityNetwork',
  filesystem: 'capabilityFilesystem',
  subprocess: 'capabilitySubprocess',
} satisfies Record<CatalogCapability, PluginCenterLocaleKey>

function DetailMark({ entry }: { readonly entry: CatalogSummary }) {
  return (
    <span className={css.detailMark} style={{ background: entry.brandColor ?? undefined }} aria-hidden="true">
      {entry.displayName.slice(0, 1).toLocaleUpperCase()}
      {entry.icon === null ? null : (
        <img
          key={entry.icon.url}
          src={entry.icon.url}
          alt=""
          width={entry.icon.width}
          height={entry.icon.height}
          referrerPolicy="no-referrer"
          onError={(event) => { event.currentTarget.hidden = true }}
        />
      )}
    </span>
  )
}

function DetailPageHeader({ entry, actions }: {
  readonly entry: CatalogSummary
  readonly actions?: ReactNode
}) {
  return (
    <header className={css.detailHeader}>
      <DetailMark entry={entry} />
      <div className={css.detailTitleRow}>
        <div>
          <h1>{entry.displayName}</h1>
          <p>{entry.summary}</p>
        </div>
        {actions === undefined ? null : <div className={css.detailHeaderActions}>{actions}</div>}
      </div>
    </header>
  )
}

function reasonEvidence(reason: CompatibilityDecision['reasons'][number]): string {
  const comparison = reason.actual === null
    ? ''
    : reason.expected === null
      ? ` · ${reason.actual}`
      : ` · ${reason.actual} → ${reason.expected}`
  return `${reason.subject}${comparison}`
}

function CompatibilityAction({ entry, state, mutationsEnabled, operation, onInstall, t }: {
  readonly entry: CatalogSummary
  readonly state: CompatibilityState
  readonly mutationsEnabled: boolean
  readonly operation: PluginOperationSnapshot | null
  readonly onInstall: () => void
  readonly t: PluginCenterTabProps['t']
}) {
  const allowed = state.status === 'ready' && state.result.allowed
  const matches = operation?.action === 'install'
    && operation.pluginId === entry.pluginId
    && operation.version === entry.version
  const matchingOperationPhase = matches ? operation.phase : null
  const committed = matchingOperationPhase === 'committed'
  const failed = matchingOperationPhase === 'failed'
  const operationBlocksInstall = operation !== null && isMutationBlockingOperationPhase(operation.phase)
  const matchingPhase = matchingOperationPhase !== null && isTrustedInstallPhase(matchingOperationPhase)
    ? matchingOperationPhase
    : null
  const label = state.status === 'loading'
    ? t('checkingCompatibility')
    : committed
      ? t('installed')
      : failed
        ? t('installationFailedAction')
        : operationBlocksInstall
          ? matchingPhase === null ? t('installationInProgress') : t(PLUGIN_OPERATION_PHASE_KEYS[matchingPhase])
          : allowed
            ? t('install')
            : t('cannotInstall')
  return (
    <Button
      variant="primary"
      size="sm"
      className={css.installAction}
      icon={allowed && !operationBlocksInstall && !committed ? <IconPlusOutline16 size={14} /> : undefined}
      title={!mutationsEnabled
        ? t('installReleaseGated')
        : operationBlocksInstall
          ? t('operationInProgress')
          : undefined}
      disabled={!mutationsEnabled || !allowed || operationBlocksInstall || committed}
      onClick={onInstall}
    >
      {label}
    </Button>
  )
}

function CompatibilityPanel({ state, mutationsEnabled, t }: {
  readonly state: CompatibilityState
  readonly mutationsEnabled: boolean
  readonly t: PluginCenterTabProps['t']
}) {
  if (state.status === 'loading') {
    return (
      <section className={`${css.detailSection} ${css.preflightSection}`} aria-label={t('preflight')}>
        <div className={css.preflightHeading}>
          <div>
            <h2>{t('preflight')}</h2>
            <p>{t('preflightIntro')}</p>
          </div>
        </div>
        <div className={css.preflightStatus} data-state="loading">
          <StateDot state="ongoing" />
          <strong>{t('checkingCompatibility')}</strong>
        </div>
      </section>
    )
  }
  if (state.status === 'error') {
    return (
      <section className={`${css.detailSection} ${css.preflightSection}`} aria-label={t('preflight')}>
        <div className={css.preflightHeading}>
          <div>
            <h2>{t('preflight')}</h2>
            <p>{t('preflightIntro')}</p>
          </div>
        </div>
        <div className={css.preflightStatus} data-state="error" role="alert">
          <StateDot state="error" />
          <strong>{t('compatibilityError')}</strong>
        </div>
      </section>
    )
  }

  const decision = state.result
  const fingerprint = decision.fingerprint
  return (
    <section
      className={`${css.detailSection} ${css.preflightSection}`}
      aria-label={t('preflight')}
      data-compatibility-allowed={decision.allowed}
    >
      <div className={css.preflightHeading}>
        <div>
          <h2>{t('preflight')}</h2>
          <p>{t('preflightIntro')}</p>
        </div>
      </div>
      <div className={css.preflightStatus} data-state={decision.allowed ? 'allowed' : 'blocked'}>
        <StateDot state={decision.allowed ? 'done' : 'error'} />
        <div>
          <strong>{decision.allowed ? t('allowedToInstall') : t('installationBlocked')}</strong>
          <span>{decision.riskSummary}</span>
        </div>
      </div>

      {decision.reasons.length === 0 ? null : (
        <div className={css.denials}>
          <h3>{t('denialReasons')}</h3>
          <ol>{decision.reasons.map((reason, index) => (
            <li key={`${reason.code}-${reason.subject}-${String(index)}`}>
              <span className={css.denialIndex} aria-hidden="true">{index + 1}</span>
              <span>
                <strong>{t(compatibilityReasonKey(reason.code))}</strong>
                <code>{reasonEvidence(reason)}</code>
              </span>
            </li>
          ))}</ol>
        </div>
      )}

      <details className={css.environmentBlock}>
        <summary>
          <span>{t('currentEnvironment')}</span>
          <span className={css.environmentSummaryMeta}>
            {fingerprint.platform}
            <IconChevronRightOutline14 size={14} aria-hidden="true" />
          </span>
        </summary>
        <dl className={`${css.detailFacts} ${css.preflightFacts}`}>
          <div><dt>{t('desktopVersion')}</dt><dd>{fingerprint.desktopVersion}</dd></div>
          <div><dt>{t('dshVersion')}</dt><dd>{fingerprint.dshVersion}</dd></div>
          <div><dt>{t('nodeVersion')}</dt><dd>{fingerprint.nodeVersion}</dd></div>
          <div><dt>{t('platform')}</dt><dd>{fingerprint.platform}</dd></div>
          <div><dt>{t('profileRevision')}</dt><dd>{fingerprint.profileRevision}</dd></div>
          <div><dt>{t('catalogRevision')}</dt><dd>{fingerprint.catalogEtag}</dd></div>
          <div><dt>{t('restartRequired')}</dt><dd>{t(decision.restartRequired ? 'restartYes' : 'restartNo')}</dd></div>
        </dl>
      </details>

      <div className={css.authorityWarning}>
        <IconWarningOutline16 size={16} aria-hidden="true" />
        <span>
          <strong>{t('authorityTitle')}</strong>
          <span>{t('authorityWarning')}</span>
        </span>
      </div>
      <p className={css.preflightFootnote}>
        {t(mutationsEnabled ? 'webInstallSimulation' : 'installReleaseGated')}
      </p>
    </section>
  )
}

/** Exact-version detail page with F003 trusted-install confirmation and status. */
export function PluginDetailPage({
  entry, state, compatibility, mutationsEnabled, operation, operationRequestFailed, onInstall, t,
}: {
  readonly entry: CatalogSummary
  readonly state: DetailState
  readonly compatibility: CompatibilityState | null
  readonly mutationsEnabled: boolean
  readonly operation: PluginOperationSnapshot | null
  readonly operationRequestFailed: boolean
  readonly onInstall: () => void
  readonly t: PluginCenterTabProps['t']
}) {
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const operationBlocksInstall = operation !== null && isMutationBlockingOperationPhase(operation.phase)
  const installAllowed = compatibility?.status === 'ready' && compatibility.result.allowed

  useEffect(() => {
    if (!operationBlocksInstall && installAllowed) return
    setConfirmationOpen(false)
    setAcknowledged(false)
  }, [installAllowed, operationBlocksInstall])

  const closeConfirmation = (): void => {
    setConfirmationOpen(false)
    setAcknowledged(false)
  }

  const confirmInstallation = (): void => {
    closeConfirmation()
    onInstall()
  }

  if (state.status === 'loading') {
    return (
      <main className={css.detailPage}>
        <DetailPageHeader entry={entry} />
        <p className={css.detailStatus}>{t('detailLoading')}</p>
      </main>
    )
  }
  if (state.status === 'error') {
    return (
      <main className={css.detailPage}>
        <DetailPageHeader entry={entry} />
        <p role="alert" className={css.error}>{t('detailError')}</p>
      </main>
    )
  }

  const detail = state.result.detail
  if (detail === null) {
    return (
      <main className={css.detailPage}>
        <DetailPageHeader entry={entry} />
        <p className={css.detailStatus}>{t('detailUnavailable')}</p>
      </main>
    )
  }

  const summary = detail.summary
  const status = detail.withdrawn
    ? t('withdrawn')
    : summary.scope === 'local'
      ? t('localReadOnly')
      : summary.verified
        ? t('verified')
        : t('unreviewed')
  return (
    <main className={css.detailPage} data-catalog-detail={`${summary.pluginId}@${summary.version}`}>
      <DetailPageHeader
        entry={summary}
        actions={(
          <>
            <span className={css.detailStatusBadge} data-withdrawn={detail.withdrawn || undefined}>{status}</span>
            {compatibility === null ? null : <CompatibilityAction
              entry={summary}
              state={compatibility}
              mutationsEnabled={mutationsEnabled}
              operation={operation}
              onInstall={() => { setConfirmationOpen(true) }}
              t={t}
            />}
          </>
        )}
      />

      {detail.screenshots.length > 0 ? (
        <section className={css.detailMedia} aria-label={t('screenshots')}>
          {detail.screenshots.map(media => (
            <img key={media.url} src={media.url} alt={media.alt} width={media.width} height={media.height} />
          ))}
        </section>
      ) : null}

      <p className={css.detailDescription}>{detail.description}</p>

      {compatibility === null ? null : <CompatibilityPanel
        state={compatibility}
        mutationsEnabled={mutationsEnabled}
        t={t}
      />}
      {operationRequestFailed
        ? <p className={css.operationRequestError} role="alert">{t('operationRequestFailed')}</p>
        : null}

      <section className={css.detailSection}>
        <h2>{t('information')}</h2>
        <dl className={css.detailFacts}>
          <div><dt>{t('publisher')}</dt><dd>{summary.publisher}</dd></div>
          <div><dt>{t('version')}</dt><dd>{summary.version}</dd></div>
          <div><dt>{t('compatibility')}</dt><dd>{t(COMPATIBILITY_KEYS[summary.compatibility.status])}</dd></div>
          <div><dt>{t('publishedAt')}</dt><dd>{new Date(detail.publishedAt).toLocaleDateString()}</dd></div>
          <div><dt>{t('updated')}</dt><dd>{new Date(summary.updatedAt).toLocaleDateString()}</dd></div>
          <div>
            <dt>{t('catalogStatus')}</dt>
            <dd>{t(FRESHNESS_KEYS[state.result.freshness])} · {t(SOURCE_KEYS[state.result.source])}</dd>
          </div>
        </dl>
        {summary.compatibility.reason === null ? null : <p className={css.note}>{summary.compatibility.reason}</p>}
      </section>

      <p className={css.verifiedNote} data-verified={summary.verified ? 'true' : 'false'}>
        <strong>{summary.verified ? t('verified') : t('unreviewed')}</strong>
        {summary.verified ? ` — ${t('verifiedHelp')}` : null}
      </p>

      <section className={css.detailSection}>
        <h2>{t('capabilities')} {summary.capabilities.length}</h2>
        <ul className={css.chips}>
          {summary.capabilities.map(value => <li key={value}>{t(CAPABILITY_KEYS[value])}</li>)}
        </ul>
      </section>

      <section className={css.detailSection}>
        <h2>{t('permissions')}</h2>
        {detail.permissions.length === 0
          ? <p>{t('noPermissions')}</p>
          : <ul className={css.detailList}>{detail.permissions.map(value => <li key={value}>{value}</li>)}</ul>}
      </section>

      <section className={css.detailSection}>
        <h2>{t('risk')}</h2>
        <p><strong>{t(RISK_KEYS[detail.riskLevel])}</strong> · {detail.riskSummary}</p>
      </section>

      <section className={css.detailSection}>
        <h2>{t('changelog')}</h2>
        <p>{detail.changelog}</p>
      </section>

      {compatibility?.status === 'ready' && compatibility.result.allowed ? (
        <PluginInstallConfirmation
          open={confirmationOpen}
          entry={summary}
          decision={compatibility.result}
          acknowledged={acknowledged}
          onAcknowledgedChange={setAcknowledged}
          onCancel={closeConfirmation}
          onConfirm={confirmInstallation}
          t={t}
        />
      ) : null}
    </main>
  )
}
