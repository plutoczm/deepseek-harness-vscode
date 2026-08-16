/** Copy for Desktop appearance, updates, and brand surfaces. */

export const en = {
  appearanceNav: 'Background',
  updatesNav: 'Software update',
}

/** Locale keys registered by the Desktop customization surface. */
export type DesktopCustomizationKey = keyof typeof en

/** Simplified Chinese navigation labels. */
export const zh: { [Key in keyof typeof en]: string } = {
  appearanceNav: '背景',
  updatesNav: '软件更新',
}
