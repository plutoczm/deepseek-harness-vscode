/** Reviewed Skill-pack fixture loaded through an ordinary DSH Bundle. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

export const inject = ['skills']

/** Register one deterministic globally discoverable Skill. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.skills.register({
    name: 'fixture-harness-basics',
    description: 'Explain the deterministic Harness fixture used to verify trusted Plugin Center installation.',
    source: 'bundled',
    provider: 'plugin-center-fixture',
    content: 'This reviewed fixture proves that an installed Skill Bundle remains discoverable after Host restart.',
  }), 'plugin-center-skill-fixture: register skill')
}
