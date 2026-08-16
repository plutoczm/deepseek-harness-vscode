// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { developmentCatalogBridge } from '../src/client/development-bridge.ts'

function enableDevelopment(version: unknown = 1): void {
  Object.defineProperty(window, '__DSH_PLUGIN_CENTER_DEV__', {
    configurable: true,
    value: { version },
  })
}

afterEach(() => {
  delete (window as unknown as { __DSH_PLUGIN_CENTER_DEV__?: unknown }).__DSH_PLUGIN_CENTER_DEV__
  window.sessionStorage.clear()
  window.history.replaceState({}, '', '/')
  vi.useRealTimers()
})

describe('Plugin Center Web development bridge', () => {
  it('requires the Host marker and provides searchable plugin, Skill, local, and detail fixtures', async () => {
    expect(developmentCatalogBridge()).toBeUndefined()
    enableDevelopment('1')
    expect(developmentCatalogBridge()).toBeUndefined()
    enableDevelopment()
    window.history.replaceState({}, '', '/?pluginCenterScenario=unknown')
    const bridge = developmentCatalogBridge()!

    const plugins = await bridge.catalog.list({ catalogKind: 'plugin', scope: 'public', query: '效率', limit: 1 })
    expect(plugins.sections.featured.map(entry => entry.pluginId)).toEqual(['fixture.workspace-tools'])
    expect(plugins.sections.popular).toHaveLength(1)
    expect(plugins.sections.recent).toHaveLength(1)
    expect(plugins.source).toBe('bundled')

    const skills = await bridge.catalog.refresh({ catalogKind: 'skill-pack', scope: 'public', query: '', limit: 24 })
    expect(skills.sections.featured[0]?.pluginId).toBe('fixture.skill-pack')
    const local = await bridge.catalog.list({ catalogKind: 'plugin', scope: 'local', query: '', limit: 24 })
    expect(local.sections.featured[0]?.pluginId).toBe('local.developer-bundle')
    expect(local.sections.popular).toEqual([])
    expect(local.sections.recent).toEqual([])

    const detail = await bridge.catalog.detail({ pluginId: 'fixture.workspace-tools', version: '0.1.0-rc.5' })
    expect(detail.detail?.summary.pluginId).toBe('fixture.workspace-tools')
    const missing = await bridge.catalog.detail({ pluginId: 'fixture.workspace-tools', version: '9.9.9' })
    expect(missing.detail).toBeNull()
    const compatible = await bridge.catalog.checkCompatibility({
      pluginId: 'fixture.workspace-tools', version: '0.1.0-rc.5', action: 'install',
    })
    expect(compatible).toMatchObject({ allowed: true, reasons: [], restartRequired: true })
  })

  it('provides empty, stale-cache, explicit denial, and error scenarios from the same page', async () => {
    enableDevelopment()

    window.history.replaceState({}, '', '/?pluginCenterScenario=empty')
    const empty = developmentCatalogBridge()!
    const emptyList = await empty.catalog.list({ catalogKind: 'plugin', scope: 'public', query: '', limit: 24 })
    expect(emptyList.sections.featured).toEqual([])
    expect((await empty.catalog.detail({ pluginId: 'fixture.workspace-tools', version: '0.1.0-rc.5' })).detail).toBeNull()
    expect((await empty.catalog.checkCompatibility({
      pluginId: 'fixture.workspace-tools', version: '0.1.0-rc.5', action: 'install',
    })).reasons[0]?.code).toBe('catalog-metadata-invalid')

    window.history.replaceState({}, '', '/?pluginCenterScenario=stale')
    const stale = developmentCatalogBridge()!
    const staleList = await stale.catalog.refresh({ catalogKind: 'plugin', scope: 'public', query: '', limit: 24 })
    expect(staleList).toMatchObject({ freshness: 'stale', source: 'cache' })
    expect(await stale.catalog.detail({ pluginId: 'fixture.workspace-tools', version: '0.1.0-rc.5' }))
      .toMatchObject({ freshness: 'stale', source: 'cache' })
    expect((await stale.catalog.checkCompatibility({
      pluginId: 'fixture.workspace-tools', version: '0.1.0-rc.5', action: 'install',
    })).reasons.map(reason => reason.code)).toEqual(['version-ineligible'])

    window.history.replaceState({}, '', '/?pluginCenterScenario=compatibility-denied')
    const denied = developmentCatalogBridge()!
    expect((await denied.catalog.checkCompatibility({
      pluginId: 'fixture.workspace-tools', version: '0.1.0-rc.5', action: 'install',
    })).reasons.map(reason => reason.code)).toEqual([
      'desktop-version-unsupported', 'platform-unsupported',
    ])

    window.history.replaceState({}, '', '/?pluginCenterScenario=error')
    const error = developmentCatalogBridge()!
    const query = { catalogKind: 'plugin', scope: 'public', query: '', limit: 24 } as const
    await expect(error.catalog.list(query)).rejects.toThrow('unavailable')
    await expect(error.catalog.refresh(query)).rejects.toThrow('unavailable')
    await expect(error.catalog.detail({ pluginId: 'fixture.workspace-tools', version: '0.1.0-rc.5' }))
      .rejects.toThrow('unavailable')
    await expect(error.catalog.checkCompatibility({
      pluginId: 'fixture.workspace-tools', version: '0.1.0-rc.5', action: 'install',
    })).rejects.toThrow('unavailable')
  })

  it('replays every trusted-install phase, marks the catalog entry installed, and rehydrates after reload', async () => {
    vi.useFakeTimers()
    enableDevelopment()
    const bridge = developmentCatalogBridge()!
    const phases: string[] = []
    bridge.pluginOperations.onState(operation => phases.push(operation.phase))

    const started = await bridge.pluginOperations.install({
      pluginId: 'fixture.workspace-tools',
      version: '0.1.0-rc.5',
      idempotencyKey: 'install:fixture.workspace-tools:web-1',
    })
    expect(started).toMatchObject({ kind: 'started', operation: { phase: 'preflight' } })
    await vi.advanceTimersByTimeAsync(12 * 180)
    expect(phases).toEqual([
      'preflight', 'downloading', 'verifying-artifact', 'snapshotting', 'stopping-host', 'installing',
      'validating-profile', 'starting-host', 'reloading', 'health-checking', 'verifying-runtime', 'committed',
    ])
    expect(await bridge.pluginOperations.getOperation()).toMatchObject({ phase: 'committed', hostGeneration: 2 })
    const installed = await bridge.catalog.list({ catalogKind: 'plugin', scope: 'public', query: '', limit: 24 })
    expect(installed.sections.featured[0]).toMatchObject({ pluginId: 'fixture.workspace-tools', installed: true })

    enableDevelopment()
    const reloaded = developmentCatalogBridge()!
    expect(await reloaded.pluginOperations.getOperation()).toMatchObject({
      operationId: 'dev-install-1',
      phase: 'committed',
    })
  })

  it('simulates recovery failure, diagnostic export, and same-operation retry for Web acceptance', async () => {
    vi.useFakeTimers()
    enableDevelopment()
    window.history.replaceState({}, '', '/?pluginCenterRecovery=failed')
    const recovery = developmentCatalogBridge()?.pluginRecovery
    if (recovery === undefined) throw new Error('development recovery bridge unavailable')
    const initial = await recovery.getState()
    expect(initial).toMatchObject({
      phase: 'recovery-failed',
      operationId: 'dev-recovery-1',
      canRetry: true,
    })
    await expect(recovery.exportDiagnostics({ operationId: 'dev-recovery-1' })).resolves.toMatchObject({
      status: 'saved',
      filename: 'dsh-plugin-recovery-dev-recovery-1.json',
    })
    const phases: string[] = []
    recovery.onState(snapshot => phases.push(snapshot.phase))
    const retrying = recovery.retry({ operationId: 'dev-recovery-1' })
    await vi.advanceTimersByTimeAsync(180)
    await expect(retrying).resolves.toMatchObject({ phase: 'rolled-back', attempt: 2 })
    expect(phases).toEqual(['recovering', 'rolled-back'])
  })
})
