import { describe, expect, it } from 'vitest'
import { PluginRuntimeVerifier } from '../src/plugin-center/runtime-verifier.ts'
import { BUNDLED_CATALOG } from '../src/plugin-center/catalog-fixture.ts'

describe('PluginRuntimeVerifier', () => {
  it('proves target deactivation without accepting unrelated runtime loss', async () => {
    const candidate = BUNDLED_CATALOG.preflights.find(value => value.pluginId === 'fixture.workspace-tools')!
    const response = (includeUnrelated: boolean): Response => new Response(JSON.stringify({
      type: 'server-response',
      rpcId: 'runtime-contract',
      result: {
        ok: true,
        value: {
          entries: includeUnrelated
            ? [{ entryId: 'unrelated.entry', enabled: true, fiberPhase: 'active' }]
            : [],
          clientModules: includeUnrelated ? ['@fixture/unrelated-client'] : [],
          skillIds: includeUnrelated ? ['unrelated-skill'] : [],
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    const prior = {
      entries: [
        { entryId: 'include:fixture.workspace-tools', enabled: true, fiberPhase: 'active' },
        { entryId: 'unrelated.entry', enabled: true, fiberPhase: 'active' },
        { entryId: 'include:agent-presets:tool-bash', enabled: true, fiberPhase: 'active' },
      ],
      clientModules: ['@deepseek-ai/dsh-plugin-center-fixture', '@fixture/unrelated-client'],
      skillIds: ['unrelated-skill'],
    }
    await expect(new PluginRuntimeVerifier(
      async () => response(true),
      () => 'runtime-contract',
    ).verifyDeactivation('http://127.0.0.1:4102', candidate, prior)).resolves.toMatchObject({
      entries: [{ entryId: 'unrelated.entry' }],
      clientModules: ['@fixture/unrelated-client'],
    })
    await expect(new PluginRuntimeVerifier(
      async () => response(false),
      () => 'runtime-contract',
    ).verifyDeactivation('http://127.0.0.1:4102', candidate, prior)).rejects.toThrow('unrelated Loader entry')
  })

  it('recovers across Host restarts without requiring live preset-instance entries', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      type: 'server-response',
      rpcId: 'runtime-contract',
      result: {
        ok: true,
        value: {
          entries: [{ entryId: 'include:base', enabled: true, fiberPhase: 'active' }],
          clientModules: ['@deepseek-ai/dsh-web-client'],
          skillIds: ['base.skill'],
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })

    await expect(new PluginRuntimeVerifier(fetcher, () => 'runtime-contract').verifyEvidence(
      'http://127.0.0.1:4102',
      {
        entries: [
          { entryId: 'include:agent-presets:tool-bash', enabled: true, fiberPhase: 'active' },
          { entryId: 'include:base', enabled: true, fiberPhase: 'active' },
        ],
        clientModules: ['@deepseek-ai/dsh-web-client'],
        skillIds: ['base.skill'],
      },
    )).resolves.toMatchObject({
      entries: [{ entryId: 'include:base' }],
    })
  })

  it('uses the generated Remote payload envelope accepted by the real Host', async () => {
    let requestBody: unknown
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('runtime request body must be JSON text')
      requestBody = JSON.parse(init.body) as unknown
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: 'runtime-contract',
        result: {
          ok: true,
          value: {
            entries: [{
              entryId: 'include:fixture.workspace-tools',
              moduleName: '@deepseek-ai/dsh-plugin-center-fixture',
              enabled: true,
              fiberPhase: 'active',
            }],
            clientModules: [],
            skillIds: [],
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    await expect(new PluginRuntimeVerifier(fetcher, () => 'runtime-contract').readEvidence(
      'http://127.0.0.1:4101',
    )).resolves.toEqual({
      entries: [{
        entryId: 'include:fixture.workspace-tools',
        enabled: true,
        fiberPhase: 'active',
      }],
      clientModules: [],
      skillIds: [],
    })
    expect(requestBody).toEqual({
      type: 'client-request',
      rpcId: 'runtime-contract',
      method: 'pluginInventory/list',
      payload: { args: {} },
    })
  })

  it('uses module identity for Loader ids regenerated across Host restarts', async () => {
    let generation = 0
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      type: 'server-response',
      rpcId: 'runtime-contract',
      result: {
        ok: true,
        value: {
          entries: [{
            entryId: generation++ === 0 ? '1234abcd' : 'deadbeef',
            moduleName: '@deepseek-ai/dsh-host-directory-picker-native',
            enabled: true,
            fiberPhase: 'active',
          }],
          clientModules: [],
          skillIds: [],
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    const verifier = new PluginRuntimeVerifier(fetcher, () => 'runtime-contract')
    const expected = await verifier.readEvidence('http://127.0.0.1:4101')

    expect(expected.entries[0]?.entryId).toBe('module:@deepseek-ai/dsh-host-directory-picker-native')
    await expect(verifier.verifyEvidence('http://127.0.0.1:4102', expected)).resolves.toEqual(expected)
  })

  it('recovers journals written before generated Loader ids included module identity', async () => {
    let generatedEntryEnabled = true
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      type: 'server-response',
      rpcId: 'runtime-contract',
      result: {
        ok: true,
        value: {
          entries: [{
            entryId: 'deadbeef',
            moduleName: '@deepseek-ai/dsh-host-directory-picker-native',
            enabled: generatedEntryEnabled,
            fiberPhase: 'active',
          }, {
            entryId: 'include:fixture.workspace-tools',
            moduleName: '@deepseek-ai/dsh-plugin-center-fixture',
            enabled: true,
            fiberPhase: 'active',
          }],
          clientModules: ['@deepseek-ai/dsh-plugin-center-fixture/client'],
          skillIds: ['fixture-harness-basics'],
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    const verifier = new PluginRuntimeVerifier(fetcher, () => 'runtime-contract')

    await expect(verifier.verifyEvidence('http://127.0.0.1:4102', {
      entries: [{
        entryId: '1234abcd',
        enabled: true,
        fiberPhase: 'active',
      }, {
        entryId: 'include:fixture.workspace-tools',
        enabled: true,
        fiberPhase: 'active',
      }],
      clientModules: ['@deepseek-ai/dsh-plugin-center-fixture/client'],
      skillIds: ['fixture-harness-basics'],
    })).resolves.toMatchObject({
      clientModules: ['@deepseek-ai/dsh-plugin-center-fixture/client'],
      skillIds: ['fixture-harness-basics'],
    })

    generatedEntryEnabled = false
    await expect(verifier.verifyEvidence('http://127.0.0.1:4102', {
      entries: [{
        entryId: '1234abcd',
        enabled: true,
        fiberPhase: 'active',
      }, {
        entryId: 'include:fixture.workspace-tools',
        enabled: true,
        fiberPhase: 'active',
      }],
      clientModules: ['@deepseek-ai/dsh-plugin-center-fixture/client'],
      skillIds: ['fixture-harness-basics'],
    })).rejects.toThrow('runtime inventory differs')
  })
})
