/** Host loader entry for the Desktop Plugin Center browser implementation. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { injectPluginCenterDevelopment } from './development-bootstrap.ts'

/** Host services required to mark an explicitly enabled Web development page. */
export const inject = ['webServer']

/** Plugin Center host configuration. */
export interface Config {
  /** Enable the deterministic browser-only development bridge marker. */
  development?: boolean
}

/** Validated Plugin Center host configuration. */
export const Config: z<Config> = z.object({
  development: z.boolean().default(false),
})

/**
 * Mark index responses only when the dedicated development command opts in.
 * @param ctx - Host context carrying the Web index transform service.
 * @param config - Validated development-mode configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.development !== true) return
  ctx.effect(
    () => ctx.webServer.tapIndex(injectPluginCenterDevelopment),
    'ui-plugin-center: browser development bridge marker',
  )
}
