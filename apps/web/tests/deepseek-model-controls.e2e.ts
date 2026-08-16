// Web e2e scenario: the shipped DeepSeek route exposes its real per-request
// thinking choices in the Chinese composer. Zero model calls: catalog loading
// and selection use the Host model RPCs, so the scenario stays keyless.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/deepseek-model-controls', import.meta.url))
const ROOT_EXPECTED = join(SNAPSHOT_DIR, 'root.expected.md')
const THINKING_EXPECTED = join(SNAPSHOT_DIR, 'thinking.expected.md')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: DeepSeek model controls use Chinese thinking semantics', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    // Keep the shipped DeepSeek adapter mounted so this scenario exercises
    // its real off/high/max metadata. The credential is deliberately masked:
    // catalog reads and selection are keyless and no model request is issued.
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const credentialStep = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
    await credentialStep.waitFor({ timeout: 15_000 })
    await credentialStep.getByRole('button', { name: '稍后配置' }).click()
    await credentialStep.waitFor({ state: 'detached', timeout: 15_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows DeepSeek thinking choices and persists the selected machine value', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deepseek-model-controls'))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    expect(await trigger.getAttribute('aria-label'))
      .toBe('选择模型，当前 DeepSeek-V4-Flash，思考模式 深度思考')

    await trigger.click()
    const root = page.getByRole('menu', { name: 'DeepSeek 模型设置' })
    await root.waitFor({ timeout: 10_000 })
    expect(await root.getByRole('menuitem').allTextContents())
      .toEqual(['模型DeepSeek-V4-Flash', '思考模式深度思考'])
    await compareOrRefreshGolden(
      ROOT_EXPECTED,
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd),
      MODE,
    )

    const triggerBox = await trigger.boundingBox()
    const rootBeforeHover = await root.boundingBox()
    expect(triggerBox).not.toBeNull()
    expect(rootBeforeHover).not.toBeNull()
    expect(Math.abs(
      ((rootBeforeHover?.x ?? 0) + (rootBeforeHover?.width ?? 0))
      - ((triggerBox?.x ?? 0) + (triggerBox?.width ?? 0)),
    )).toBeLessThan(1)
    const thinkingRow = root.getByRole('menuitem', { name: /思考模式/ })
    await thinkingRow.hover()
    const thinkingMenu = page.getByRole('menu', { name: '思考模式' })
    await thinkingMenu.waitFor({ timeout: 10_000 })
    expect(await thinkingRow.getAttribute('aria-expanded')).toBe('true')
    const rootBox = await root.boundingBox()
    const thinkingBox = await thinkingMenu.boundingBox()
    expect(rootBox).not.toBeNull()
    expect(thinkingBox).not.toBeNull()
    expect(Math.abs((rootBox?.x ?? 0) - (rootBeforeHover?.x ?? 0))).toBeLessThan(1)
    expect(Math.abs(
      (thinkingBox?.x ?? 0) - ((rootBox?.x ?? 0) + (rootBox?.width ?? 0)) - 8,
    )).toBeLessThan(1)
    const levels = page.getByRole('menuitemradio')
    await expect.poll(async () => levels.allTextContents(), { timeout: 10_000 })
      .toEqual([
        '关闭思考不启用深度思考',
        '深度思考启用深度思考，适合大多数开发任务',
        '最大思考使用最高推理强度，适合复杂任务',
      ])
    await compareOrRefreshGolden(
      THINKING_EXPECTED,
      await captureStableAria(page, '[role="menu"][aria-label="思考模式"]', scaffold.workspaceCwd),
      MODE,
    )

    await page.getByRole('menuitemradio', { name: /最大思考/ }).click()
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('选择模型，当前 DeepSeek-V4-Flash，思考模式 最大思考')
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'),
      { timeout: 10_000 },
    ).toContain('reasoningEffort: max')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['root.expected.md', 'thinking.expected.md'])
  })
})
