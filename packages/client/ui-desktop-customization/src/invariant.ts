/** Package-owned invariant companion for Desktop customization. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-desktop-customization'

/** Cordis companion plugin name. */
export const name = 'client-ui-desktop-customization-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: fixed Electron bridge channels are validated in the
 * main process, while slot registration and appearance disposal are covered
 * through the assembled Desktop composition and focused browser tests.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

