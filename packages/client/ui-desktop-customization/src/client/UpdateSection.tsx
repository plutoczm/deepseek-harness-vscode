/** Visible update center backed by the Electron main-process updater. */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { DesktopRendererBridge, DesktopUpdateState } from './bridge.ts'
import css from './DesktopCustomization.module.css'

export interface UpdateSectionInjected {
  readonly bridge: DesktopRendererBridge | undefined
}

export type UpdateSectionProps = Partial<UpdateSectionInjected>

/** Render version, update status, progress, and the next valid action. */
export function UpdateSection({ bridge }: UpdateSectionProps): ReactNode {
  const [state, setState] = useState<DesktopUpdateState | undefined>(undefined)
  useEffect(() => {
    if (bridge === undefined) return
    let active = true
    void bridge.updates.getState().then(next => { if (active) setState(next) })
    const dispose = bridge.updates.onState(next => { setState(next) })
    return () => { active = false; dispose() }
  }, [bridge])

  const act = async (action: 'check' | 'download' | 'install'): Promise<void> => {
    if (bridge === undefined) return
    if (action === 'install') { await bridge.updates.install(); return }
    const next = action === 'check' ? await bridge.updates.check() : await bridge.updates.download()
    setState(next)
  }

  return (
    <section className={css.section}>
      <div>
        <h2 className={css.title}>软件更新</h2>
        <p className={css.intro}>正式发布后，应用会从赋范空间更新源检查新版本，并在你确认后下载和重启安装。</p>
      </div>
      <div className={css.updateCard}>
        <div className={css.updateIcon}>DSH</div>
        <div className={css.updateIdentity}>
          <strong>DeepSeek Harness Desktop</strong>
          <span>当前版本 {state?.currentVersion ?? '读取中…'}</span>
        </div>
        <span className={css.statusPill}>{statusLabel(state)}</span>
      </div>
      {state?.phase === 'downloading' && (
        <div className={css.progress} aria-label={`下载进度 ${Math.round(state.progress ?? 0)}%`}>
          <span style={{ width: `${String(state.progress ?? 0)}%` }} />
        </div>
      )}
      {state?.availableVersion !== undefined && <p className={css.notice}>发现新版本 {state.availableVersion}</p>}
      {state?.message !== undefined && <p className={state.phase === 'error' ? css.error : css.notice}>{state.message}</p>}
      {state?.phase === 'development' && (
        <div className={css.developmentNote}>
          <strong>更新引擎已经接入</strong>
          <span>当前运行的是源码开发版。等三端安装包阶段生成签名产物和版本元数据后，这里会直接进入真实更新流程。</span>
        </div>
      )}
      <div className={css.actions}>
        {(state?.phase === 'idle' || state?.phase === 'up-to-date' || state?.phase === 'error') && (
          <button type="button" className={css.primaryButton} onClick={() => { void act('check') }}>检查更新</button>
        )}
        {state?.phase === 'available' && (
          <button type="button" className={css.primaryButton} onClick={() => { void act('download') }}>下载新版本</button>
        )}
        {state?.phase === 'ready' && (
          <button type="button" className={css.primaryButton} onClick={() => { void act('install') }}>重启并安装</button>
        )}
        {(state?.phase === 'checking' || state?.phase === 'downloading') && (
          <button type="button" className={css.primaryButton} disabled>{state.phase === 'checking' ? '检查中…' : '下载中…'}</button>
        )}
        {state?.phase === 'development' && <button type="button" className={css.primaryButton} disabled>正式安装包后启用</button>}
      </div>
    </section>
  )
}

function statusLabel(state: DesktopUpdateState | undefined): string {
  switch (state?.phase) {
    case 'development': return '开发版'
    case 'idle': return '可检查'
    case 'checking': return '检查中'
    case 'available': return '有新版本'
    case 'downloading': return `${Math.round(state.progress ?? 0)}%`
    case 'ready': return '等待重启'
    case 'up-to-date': return '已是最新'
    case 'error': return '更新失败'
    default: return '读取中'
  }
}

