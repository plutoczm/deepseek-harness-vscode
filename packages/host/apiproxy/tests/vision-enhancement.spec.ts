import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { AttachmentStore, type ImageAttachmentRef, type SaveImageAttachment, type StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import {
  CredentialProvider, credentialRef, type CredentialInfo, type CredentialRef, type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import SessionStore, { KNOWN_SESSION_EVENT_TYPES, SessionId } from '@deepseek-ai/dsh-session'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  BAILIAN_API_KEY_REF,
  ensureLoggedVisionObservation,
  installVisionEnhancement,
  OPENROUTER_API_KEY_REF,
  OPENROUTER_VISION_MODEL,
} from '../src/vision-enhancement.ts'

const LEGACY_BAILIAN_REF = credentialRef('DASHSCOPE_API_KEY')

class MemorySettings extends SettingsProvider {
  private readonly doc: Record<string, unknown> = {}

  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

class MemoryCredentials extends CredentialProvider {
  private readonly values = new Map<string, string>()

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = this.values.has(ref)
    return Promise.resolve({ configured, ...configured ? { source: 'memory' } : {}, writable: true })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    this.ctx.emit('credentials/updated', ref)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
    this.ctx.emit('credentials/updated', ref)
    return Promise.resolve()
  }
}

class AmbientDashscopeCredentials extends MemoryCredentials {
  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (ref === LEGACY_BAILIAN_REF) return Promise.resolve({ value: 'ambient-key', source: 'env' })
    return super.resolve(ref)
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (ref === LEGACY_BAILIAN_REF) return Promise.resolve({ configured: true, source: 'env', writable: false })
    return super.describe(ref)
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    if (ref === LEGACY_BAILIAN_REF) {
      throw new Error('legacy launch environment must stay read-only')
    }
    return super.set(ref, value)
  }
}

class AcceptingAttachments extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: 10 * 1024 * 1024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 100 * 1024 * 1024,
    maxImagePixels: 40_000_000,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
  }

  validateImage(_input: SaveImageAttachment): Promise<void> { return Promise.resolve() }
  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> { throw new Error('unused') }
  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> { throw new Error('unused') }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('vision observation log contract', () => {
  it('records the exact observation once and reuses it during reconstruction', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('vision-log-test'))
    const analyze = vi.fn(() => Promise.resolve('蓝眼睛的白色小猫。'))

    await expect(ensureLoggedVisionObservation(session, {
      attachmentId: 'sha256:cat', question: '图里是什么？', model: 'qwen3.8-max',
    }, analyze)).resolves.toBe('蓝眼睛的白色小猫。')
    await expect(ensureLoggedVisionObservation(session, {
      attachmentId: 'sha256:cat', question: '图里是什么？', model: 'qwen3.8-max',
    }, () => Promise.reject(new Error('恢复时不应重新请求百炼')))).resolves.toBe('蓝眼睛的白色小猫。')

    expect(analyze).toHaveBeenCalledTimes(1)
    expect(session.events.filter(event => event.type === 'vision/observation')).toHaveLength(1)
    expect(session.events.at(-1)).toMatchObject({
      type: 'vision/observation',
      data: {
        attachmentId: 'sha256:cat',
        question: '图里是什么？',
        model: 'qwen3.8-max',
        description: '蓝眼睛的白色小猫。',
      },
    })
    expect(session.events.at(-1)).not.toHaveProperty('ignorable')
    expect(KNOWN_SESSION_EVENT_TYPES.has('vision/observation')).toBe(true)
  })

  it('serializes concurrent enable requests so a later invalid key cannot race an earlier commit', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AcceptingAttachments)
    const runtime = installVisionEnhancement(ctx)
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    let active = 0
    let maxActive = 0
    const authorizations: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      active++
      maxActive = Math.max(maxActive, active)
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      try {
        if (authorizations.at(-1) === 'Bearer key-a') {
          await firstBlocked
          return new Response(JSON.stringify({ choices: [{ message: { content: '第一张图' } }] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ error: { message: 'invalid key' } }), {
          status: 401, headers: { 'content-type': 'application/json' },
        })
      } finally {
        active--
      }
    }))

    try {
      const input = { mediaType: 'image/png' as const, data: 'AA==' }
      const first = runtime.enable({ ...input, apiKey: 'key-a' })
      await vi.waitFor(() => { expect(authorizations).toEqual(['Bearer key-a']) })
      const second = runtime.enable({ ...input, apiKey: 'key-b' })
      await Promise.resolve()
      expect(authorizations).toEqual(['Bearer key-a'])
      releaseFirst?.()

      await expect(first).resolves.toEqual({ provider: 'bailian', model: 'qwen3.8-max', description: '第一张图' })
      await expect(second).rejects.toThrow('invalid key')
      expect(maxActive).toBe(1)
      expect(authorizations).toEqual(['Bearer key-a', 'Bearer key-b'])
      expect(await ctx.credentials.resolve(BAILIAN_API_KEY_REF)).toEqual({ value: 'key-b', source: 'memory' })
      expect(runtime.isEnabled()).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stores a Bailian UI key under an app-owned ref even when DASHSCOPE_API_KEY is ambient and read-only', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(AmbientDashscopeCredentials)
    await ctx.plugin(AcceptingAttachments)
    const runtime = installVisionEnhancement(ctx)
    const authorizations: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response(JSON.stringify({ choices: [{ message: { content: '新密钥识别成功' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }))

    try {
      await expect(runtime.enable({
        mediaType: 'image/png', data: 'AA==', apiKey: 'writable-ui-key',
      })).resolves.toMatchObject({ provider: 'bailian', description: '新密钥识别成功' })
      expect(BAILIAN_API_KEY_REF).toBe('DSH_VISION_BAILIAN_API_KEY')
      expect(authorizations).toEqual(['Bearer writable-ui-key'])
      expect(await ctx.credentials.resolve(BAILIAN_API_KEY_REF))
        .toEqual({ value: 'writable-ui-key', source: 'memory' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('validates and persists an OpenRouter visual route with OpenAI-compatible image input', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AcceptingAttachments)
    const runtime = installVisionEnhancement(ctx)
    let requestedUrl = ''
    let requestedBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url)
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer openrouter-key')
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OpenRouter 看见了一只猫。' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }))

    try {
      await expect(runtime.enable({
        provider: 'openrouter', model: OPENROUTER_VISION_MODEL,
        mediaType: 'image/png', data: 'AA==', apiKey: 'openrouter-key',
      })).resolves.toEqual({
        provider: 'openrouter', model: OPENROUTER_VISION_MODEL,
        description: 'OpenRouter 看见了一只猫。',
      })
      expect(requestedUrl).toBe('https://openrouter.ai/api/v1/chat/completions')
      expect(requestedBody).toMatchObject({ model: OPENROUTER_VISION_MODEL, max_tokens: 1024 })
      expect(requestedBody).not.toHaveProperty('enable_thinking')
      expect(requestedBody?.messages).toEqual([{
        role: 'user',
        content: [
          { type: 'text', text: expect.any(String) },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        ],
      }])
      expect(await ctx.credentials.resolve(OPENROUTER_API_KEY_REF))
        .toEqual({ value: 'openrouter-key', source: 'memory' })
      await expect(runtime.status()).resolves.toMatchObject({
        enabled: true,
        configured: true,
        provider: 'openrouter',
        model: OPENROUTER_VISION_MODEL,
        providers: expect.arrayContaining([
          expect.objectContaining({ id: 'openrouter', configured: true, modelEditable: true }),
        ]),
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
