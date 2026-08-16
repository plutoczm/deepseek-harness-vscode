/** Live appearance state shared by the background settings page and shell. */

import type { ThemeRuntime, ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { AppearanceSettings, DesktopRendererBridge } from './bridge.ts'
import {
  BUNDLED_APPEARANCE_THEMES,
  DEFAULT_BUILTIN_APPEARANCE_THEME,
  resolveAppearanceBackground,
} from './appearance-themes.ts'

/** Bundled learner background served by the Desktop web host. */
export const DEFAULT_BACKGROUND_URL = BUNDLED_APPEARANCE_THEMES[DEFAULT_BUILTIN_APPEARANCE_THEME].imageUrl

/** Initial appearance before an optional persisted learner choice loads. */
export const DEFAULT_APPEARANCE: AppearanceSettings = Object.freeze({
  builtinTheme: DEFAULT_BUILTIN_APPEARANCE_THEME,
  imageDataUrl: null,
  focusY: 50,
  glassStrength: 72,
  palette: BUNDLED_APPEARANCE_THEMES[DEFAULT_BUILTIN_APPEARANCE_THEME].palette,
})

/** Observable state exposed to the background settings section. */
export interface AppearanceSnapshot {
  readonly status: 'loading' | 'ready' | 'saving' | 'error'
  readonly settings: AppearanceSettings
  readonly message?: string
}

/** Applies and persists one Desktop background without exposing Electron APIs elsewhere. */
export class AppearanceController {
  private readonly bridge: DesktopRendererBridge | undefined
  private readonly theme: ThemeRuntime
  private snapshot: AppearanceSnapshot = { status: 'loading', settings: DEFAULT_APPEARANCE }
  private readonly listeners = new Set<() => void>()
  private disposeTokens: (() => void) | undefined
  private disposed = false
  private previousMarker: string | null = null
  private previousImage = ''
  private previousPosition = ''

  constructor(bridge: DesktopRendererBridge | undefined, theme: ThemeRuntime) {
    this.bridge = bridge
    this.theme = theme
  }

  /** Subscribe for React useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Current immutable snapshot. */
  getSnapshot = (): AppearanceSnapshot => this.snapshot

  /**
   * Apply the default immediately, then load any saved learner choice.
   * @returns A disposer that restores the prior theme state.
   */
  start(): () => void {
    const body = document.body
    this.previousMarker = body.getAttribute('data-dsh-desktop-skin')
    this.previousImage = body.style.getPropertyValue('--dsh-desktop-background-image')
    this.previousPosition = body.style.getPropertyValue('--dsh-desktop-background-position')
    this.apply(DEFAULT_APPEARANCE)
    if (this.bridge === undefined) {
      this.publish({ status: 'error', settings: DEFAULT_APPEARANCE, message: 'Desktop bridge 未加载，当前只显示默认背景。' })
    } else {
      void this.bridge.appearance.get().then((settings) => {
        if (this.disposed) return
        this.apply(settings)
        this.publish({ status: 'ready', settings })
      }, (error: unknown) => {
        if (this.disposed) return
        this.publish({ status: 'error', settings: DEFAULT_APPEARANCE, message: messageOf(error) })
      })
    }
    return () => { this.dispose() }
  }

  /**
   * Persist and apply a processed background.
   * @param settings Validated appearance values to store through the preload bridge.
   */
  async save(settings: AppearanceSettings): Promise<void> {
    if (this.bridge === undefined) throw new Error('Desktop bridge 未加载。')
    this.publish({ status: 'saving', settings: this.snapshot.settings })
    try {
      const saved = await this.bridge.appearance.save(settings)
      this.apply(saved)
      this.publish({ status: 'ready', settings: saved, message: '背景已保存。' })
    } catch (error) {
      this.publish({ status: 'error', settings: this.snapshot.settings, message: messageOf(error) })
      throw error
    }
  }

  /** Remove the custom image and return to the bundled background. */
  async reset(): Promise<void> {
    if (this.bridge === undefined) throw new Error('Desktop bridge 未加载。')
    this.publish({ status: 'saving', settings: this.snapshot.settings })
    try {
      const settings = await this.bridge.appearance.reset()
      this.apply(settings)
      this.publish({ status: 'ready', settings, message: '已恢复默认背景。' })
    } catch (error) {
      this.publish({ status: 'error', settings: this.snapshot.settings, message: messageOf(error) })
      throw error
    }
  }

  private apply(settings: AppearanceSettings): void {
    const image = resolveAppearanceBackground(settings)
    this.disposeTokens?.()
    this.disposeTokens = undefined
    if (image === null) {
      const body = document.body
      if (this.previousMarker === null) body.removeAttribute('data-dsh-desktop-skin')
      else body.setAttribute('data-dsh-desktop-skin', this.previousMarker)
      restoreProperty(body, '--dsh-desktop-background-image', this.previousImage)
      restoreProperty(body, '--dsh-desktop-background-position', this.previousPosition)
      return
    }
    document.body.setAttribute('data-dsh-desktop-skin', 'active')
    document.body.style.setProperty('--dsh-desktop-background-image', `url("${image}")`)
    document.body.style.setProperty('--dsh-desktop-background-position', `${String(settings.focusY)}%`)
    this.disposeTokens = this.theme.overrideTokens('dsh-desktop-background', themeTokens(settings))
  }

  private publish(snapshot: AppearanceSnapshot): void {
    this.snapshot = Object.freeze({ ...snapshot })
    for (const listener of this.listeners) listener()
  }

  private dispose(): void {
    this.disposed = true
    this.disposeTokens?.()
    this.disposeTokens = undefined
    const body = document.body
    if (this.previousMarker === null) body.removeAttribute('data-dsh-desktop-skin')
    else body.setAttribute('data-dsh-desktop-skin', this.previousMarker)
    restoreProperty(body, '--dsh-desktop-background-image', this.previousImage)
    restoreProperty(body, '--dsh-desktop-background-position', this.previousPosition)
  }
}

function themeTokens(settings: AppearanceSettings): ThemeTokenOverrides {
  const [accent, deep, mist, highlight] = settings.palette
  const strength = settings.glassStrength / 100
  const baseAlpha = (0.24 + strength * 0.22).toFixed(2)
  const darkAlpha = (0.31 + strength * 0.22).toFixed(2)
  const layerAlpha = (0.58 + strength * 0.20).toFixed(2)
  const modes = (light: string, dark: string) => ({ light, dark })
  return {
    '--dsw-alias-bg-base': modes(`rgba(246, 250, 255, ${baseAlpha})`, `rgba(7, 17, 29, ${darkAlpha})`),
    '--dsw-alias-bg-layer-1': modes(`rgba(255, 255, 255, ${layerAlpha})`, `rgba(13, 27, 45, ${layerAlpha})`),
    '--dsw-alias-bg-layer-2': modes('rgba(236, 245, 255, 0.86)', 'rgba(18, 36, 57, 0.88)'),
    '--dsw-alias-bg-overlay': modes('rgba(251, 253, 255, 0.96)', 'rgba(11, 23, 39, 0.96)'),
    '--dsw-specific-sidebar-fill': modes('rgba(235, 244, 254, 0.68)', 'rgba(8, 21, 36, 0.72)'),
    '--dsw-specific-input-major': modes('rgba(255, 255, 255, 0.90)', 'rgba(16, 34, 54, 0.92)'),
    '--dsw-specific-menu': modes('rgba(251, 253, 255, 0.97)', 'rgba(11, 25, 42, 0.97)'),
    '--dsw-specific-selector': modes('rgba(236, 246, 255, 0.94)', 'rgba(21, 42, 65, 0.94)'),
    '--dsw-specific-bubble': modes('rgba(219, 238, 255, 0.92)', 'rgba(31, 61, 91, 0.88)'),
    '--dsw-alias-border-l1': modes(`${mist}80`, `${mist}66`),
    '--dsw-alias-border-l2': modes(`${mist}a8`, `${mist}78`),
    '--dsw-alias-brand-primary': modes(accent, highlight),
    '--dsw-alias-state-business-primary': modes(accent, highlight),
    '--dsw-alias-label-primary': modes(deep, '#edf7ff'),
    '--dsw-alias-label-secondary': modes(`${deep}cc`, '#b9cfe2'),
    '--dsw-alias-interactive-bg-hover': modes(`${accent}18`, `${highlight}24`),
  }
}

function restoreProperty(element: HTMLElement, name: string, value: string): void {
  if (value === '') element.style.removeProperty(name)
  else element.style.setProperty(name, value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
