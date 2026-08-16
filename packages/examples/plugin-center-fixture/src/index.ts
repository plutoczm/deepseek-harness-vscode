/** Reviewed Host half of the trusted-installation fixture Bundle. */

import type { Context } from '@deepseek-ai/cordis'

/** Provide observable Host evidence for post-restart verification. */
export function apply(ctx: Context): void {
  ctx.provide('pluginCenterFixture', Object.freeze({ status: 'running', capability: 'workspace-tools' }))
}
