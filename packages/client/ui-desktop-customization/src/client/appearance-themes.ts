/** Bundled Desktop themes and their fixed presentation defaults. */

import type { AppearancePalette, BuiltinAppearanceTheme } from './bridge.ts'

/** One named skin shipped as a static Desktop Web asset. */
export interface BundledAppearanceTheme {
  readonly id: BuiltinAppearanceTheme
  readonly imageUrl: string | null
  readonly palette: AppearancePalette
  readonly focusY: number
  readonly glassStrength: number
}

/** Theme used before a learner makes a persisted choice. */
export const DEFAULT_BUILTIN_APPEARANCE_THEME: BuiltinAppearanceTheme = 'whale-maid'

/** Fixed themes shipped with the Desktop web frontend. */
export const BUNDLED_APPEARANCE_THEMES = Object.freeze({
  official: Object.freeze({
    id: 'official',
    imageUrl: null,
    palette: Object.freeze(['#2563EB', '#1F2937', '#D1D5DB', '#60A5FA'] as const),
    focusY: 50,
    glassStrength: 72,
  }),
  'whale-maid': Object.freeze({
    id: 'whale-maid',
    imageUrl: '/dsh-desktop/default-background.webp',
    palette: Object.freeze(['#587ac2', '#253555', '#d9e5f7', '#8ba5d6'] as const),
    focusY: 50,
    glassStrength: 72,
  }),
  'cloud-cat': Object.freeze({
    id: 'cloud-cat',
    imageUrl: '/dsh-desktop/cloud-cat-background.webp',
    palette: Object.freeze(['#3b5891', '#1d2739', '#b0c7e8', '#7091cc'] as const),
    focusY: 50,
    glassStrength: 72,
  }),
}) satisfies Readonly<Record<BuiltinAppearanceTheme, BundledAppearanceTheme>>

/**
 * Resolve either a custom image or one bundled theme into a renderer URL.
 * @param settings - Validated built-in identity and optional custom-image data.
 * @returns A bundled asset URL, the persisted custom-image data URL, or null for the original UI.
 */
export function resolveAppearanceBackground(
  settings: Pick<import('./bridge.ts').AppearanceSettings, 'builtinTheme' | 'imageDataUrl'>,
): string | null {
  if (settings.imageDataUrl !== null) return settings.imageDataUrl
  return BUNDLED_APPEARANCE_THEMES[
    settings.builtinTheme ?? DEFAULT_BUILTIN_APPEARANCE_THEME
  ].imageUrl
}
