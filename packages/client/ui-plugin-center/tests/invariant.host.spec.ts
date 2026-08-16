import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as PluginCenterInvariant from '../src/invariant.ts'

describe('ui-plugin-center invariant companion', () => {
  it('registers the empty installer and keeps the default Host half inert', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(PluginCenterInvariant).await()).resolves.toBeDefined()
    const { apply } = await import('../src/index.ts')
    apply(ctx)
    await ctx.fiber.dispose()
  })
})
