import { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import { Config, apply, inject } from '../src/index.ts'
import { injectPluginCenterDevelopment } from '../src/development-bootstrap.ts'

describe('Plugin Center development bootstrap', () => {
  it('injects the explicit marker after body and into a body-less fragment', () => {
    const html = injectPluginCenterDevelopment('<html><body class="app"><main></main></body></html>')
    expect(html.indexOf('__DSH_PLUGIN_CENTER_DEV__')).toBeGreaterThan(html.indexOf('<body class="app">'))
    expect(html.indexOf('__DSH_PLUGIN_CENTER_DEV__')).toBeLessThan(html.indexOf('<main>'))
    expect(injectPluginCenterDevelopment('<main></main>')).toMatch(/^<main><\/main><script>/)
  })

  it('registers and disposes the index transform only when configured', async () => {
    const ctx = new Context()
    let transform: ((html: string) => string) | undefined
    let disposed = false
    ctx.provide('webServer', {
      tapIndex: (next: (html: string) => string) => {
        transform = next
        return () => { disposed = true }
      },
    } as WebServer)

    const disabled = ctx.plugin({ Config, inject: [...inject], apply }, { development: false })
    await disabled.await()
    expect(transform).toBeUndefined()
    await disabled.dispose()

    const enabled = ctx.plugin({ Config, inject: [...inject], apply }, { development: true })
    await enabled.await()
    expect(transform?.('<body></body>')).toContain('Object.freeze({ version: 1 })')
    await enabled.dispose()
    expect(disposed).toBe(true)
    await ctx.fiber.dispose()
  })
})
