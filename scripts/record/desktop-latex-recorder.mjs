#!/usr/bin/env node

import { once } from 'node:events'
import { readFileSync, mkdirSync, renameSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const scriptPath = resolve(process.argv[2] ?? 'scripts/record/scripts/feat-latex-tools-demo.json')
const script = JSON.parse(readFileSync(scriptPath, 'utf8'))
const viewport = script.viewport ?? { width: 1920, height: 1080 }
const fps = 30
const outDir = join(root, 'artifacts/recordings')
mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/gu, '-').replace('T', '-').slice(0, 19)
const tag = basename(scriptPath, '.json')
const output = join(outDir, `${stamp}-${tag}-raw.mp4`)
const timelinePath = join(outDir, `${stamp}-${tag}-raw-actions.txt`)

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const context = browser.contexts()[0]
if (context === undefined) throw new Error('Electron CDP context is unavailable')
const page = context.pages()[0]
if (page === undefined) throw new Error('Electron renderer page is unavailable')
const cdp = await context.newCDPSession(page)

await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: viewport.width,
  height: viewport.height,
  deviceScaleFactor: 1,
  mobile: false,
  screenWidth: viewport.width,
  screenHeight: viewport.height,
})

const cursorCss = readFileSync(join(here, 'inject/cursor-overlay.css'), 'utf8')
const cursorJs = readFileSync(join(here, 'inject/cursor-overlay.js'), 'utf8')
const init = `window.__REC_CSS__=${JSON.stringify(cursorCss)};${cursorJs}`
await page.addInitScript({ content: init })
await page.evaluate(({ css, js }) => {
  window.__REC_CSS__ = css
  globalThis.eval(js)
}, { css: cursorCss, js: cursorJs })

async function closeCompletedDialog() {
  const done = page.getByRole('button', { name: '完成', exact: true })
  if (await done.count()) await done.first().click()
}

const cancel = page.getByRole('button', { name: '取消', exact: true })
if (await cancel.count()) await cancel.first().click()
await closeCompletedDialog()
await page.keyboard.press('Escape')
for (let index = 0; index < 2; index += 1) {
  const petClose = page.locator('.dshpet-x:visible')
  if (await petClose.count()) await petClose.last().click({ force: true })
}
const backToCatalog = page.getByRole('button', { name: '返回插件目录' })
if (await backToCatalog.count()) await backToCatalog.click()
if (!(await page.getByRole('searchbox', { name: '搜索插件' }).count())) {
  await page.getByRole('button', { name: '插件中心' }).click()
}
const search = page.getByRole('searchbox', { name: '搜索插件' })
await search.waitFor({ timeout: 30_000 })
await search.fill('')
await page.evaluate(() => {
  const scroller = document.querySelector('main')?.parentElement
  if (scroller instanceof HTMLElement) scroller.scrollTop = 0
})
await page.waitForTimeout(350)

const installedLatex = page.getByRole('button', { name: '管理已安装插件：dsh-latex-tools' })
if (await installedLatex.count()) {
  await installedLatex.click()
  const row = page.locator('li[data-installed-plugin]').filter({ hasText: 'dsh-latex-tools' })
  await row.locator('[data-action="uninstall"]').click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ timeout: 30_000 })
  await dialog.getByRole('checkbox').click()
  await dialog.getByRole('button', { name: '卸载', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"]')]
    .some(element => element.textContent?.includes('插件操作已完成')), {}, { timeout: 120_000 })
  await closeCompletedDialog()
  await search.fill('')
}

const ffmpeg = spawn('/opt/homebrew/bin/ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'image2pipe', '-framerate', String(fps), '-vcodec', 'mjpeg', '-i', 'pipe:0',
  '-vf', `scale=${String(viewport.width)}:${String(viewport.height)}:flags=lanczos,setsar=1`,
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-r', String(fps), '-movflags', '+faststart', '-an', output,
], { stdio: ['pipe', 'ignore', 'pipe'] })
let ffmpegError = ''
ffmpeg.stderr.on('data', chunk => { ffmpegError = `${ffmpegError}${String(chunk)}`.slice(-8_000) })

let recordStart = Date.now()
let frameCount = 0
let lastFrame = null
let frameQueue = Promise.resolve()
let firstFrameResolve
const firstFrame = new Promise(resolveFirst => { firstFrameResolve = resolveFirst })

async function writeFrame(frame) {
  if (!ffmpeg.stdin.write(frame)) await once(ffmpeg.stdin, 'drain')
}

cdp.on('Page.screencastFrame', event => {
  void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId })
  const frame = Buffer.from(event.data, 'base64')
  const target = Math.floor((Date.now() - recordStart) / 1000 * fps)
  frameQueue = frameQueue.then(async () => {
    while (lastFrame !== null && frameCount < target) {
      await writeFrame(lastFrame)
      frameCount += 1
    }
    await writeFrame(frame)
    lastFrame = frame
    frameCount += 1
    firstFrameResolve?.()
    firstFrameResolve = undefined
  })
})

await cdp.send('Page.startScreencast', {
  format: 'jpeg', quality: 92,
  maxWidth: viewport.width, maxHeight: viewport.height,
  everyNthFrame: 1,
})
recordStart = Date.now()
await firstFrame

const actions = []
let cursorX = viewport.width / 2
let cursorY = viewport.height / 2
function mark(label) {
  const time = (Date.now() - recordStart) / 1000
  actions.push({ time, label })
  console.log(`${time.toFixed(1)}s ${label}`)
}

async function moveTo(locator, duration = 240) {
  await locator.waitFor({ state: 'visible', timeout: 30_000 })
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (box === null) throw new Error('recording target has no bounding box')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const steps = 18
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps
    const eased = progress < 0.5
      ? 4 * progress ** 3
      : 1 - (-2 * progress + 2) ** 3 / 2
    await page.mouse.move(
      cursorX + (x - cursorX) * eased,
      cursorY + (y - cursorY) * eased,
    )
    await page.waitForTimeout(Math.max(8, Math.round(duration / steps)))
  }
  cursorX = x
  cursorY = y
}

async function click(locator, label, hold = 70) {
  await moveTo(locator)
  await page.waitForTimeout(hold)
  await page.mouse.down()
  await page.waitForTimeout(55)
  await page.mouse.up()
  mark(label)
}

async function completeOnboarding(label) {
  const panel = page.locator('.dshpet-panel')
  await panel.waitFor({ timeout: 15_000 })
  const input = panel.getByPlaceholder('宠物的名字')
  if (await input.count()) {
    await input.fill('豆豆')
    await click(panel.locator('button.dshpet-btn').filter({ hasText: '下一步' }).first(), `${label}：下一步`)
    await click(panel.locator('button').filter({ hasText: '小狐狸' }).first(), `${label}：选择小狐狸`)
  }
  await page.waitForFunction(() => document.querySelector('.dshpet-panel')?.textContent?.includes('Lv.1') === true)
}

async function confirmDialog(actionLabel) {
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ timeout: 30_000 })
  await click(dialog.getByRole('checkbox'), `${actionLabel}：授权确认`)
  await click(dialog.getByRole('button', { name: actionLabel, exact: true }), actionLabel)
}

async function waitOperation({ petVisible }) {
  await page.waitForFunction(expected => {
    const pet = Boolean(document.querySelector('[title="点击开/关 · 拖动移动"]'))
    const complete = [...document.querySelectorAll('[role="dialog"]')]
      .some(element => element.textContent?.includes('已完成') || element.textContent?.includes('已可运行'))
    return pet === expected && complete
  }, petVisible, { timeout: 120_000 })
  mark(petVisible ? '运行节点出现' : '运行节点消失')
  await page.waitForTimeout(240)
  await click(page.getByRole('button', { name: '完成', exact: true }), '关闭完成状态')
}

let recordingError
try {
  mark('开始：LaTeX 工具未安装')
  await page.waitForTimeout(450)
  await moveTo(search)
  await page.mouse.click(cursorX, cursorY)
  await search.pressSequentially('dsh-latex-tools', { delay: 35 })
  mark('搜索 dsh-latex-tools')
  const card = page.locator('li').filter({ has: page.getByRole('button', { name: '查看详情：dsh-latex-tools' }) })
  await card.waitFor({ timeout: 30_000 })
  await page.waitForTimeout(300)
  await click(card.getByRole('button', { name: '安装', exact: true }), '点击安装')
  await confirmDialog('确认安装')
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"]')]
    .some(element => element.textContent?.includes('插件已可运行')), {}, { timeout: 120_000 })
  mark('LaTeX 工具已安装并通过运行验证')
  await page.waitForTimeout(350)
  await click(page.getByRole('button', { name: '完成', exact: true }), '关闭安装结果')
  await page.waitForTimeout(450)

  await click(page.getByText('欧拉恒等式与高斯积分', { exact: true }).first(), '打开公式会话')
  const formula = page.locator('.katex-display').first()
  await formula.waitFor({ timeout: 30_000 })
  await moveTo(formula, 320)
  mark('悬停公式，显示工具条')
  const copyButton = page.getByRole('button', { name: /复制 LaTeX/u }).first()
  await copyButton.waitFor({ timeout: 10_000 })
  await click(copyButton, '复制 LaTeX 源码')
  await moveTo(formula, 260)
  const exportButton = page.getByRole('button', { name: /导出 SVG/u }).first()
  await exportButton.waitFor({ timeout: 10_000 })
  await click(exportButton, '导出自包含 SVG')
  mark('完成：公式已复制并导出')
  await page.waitForTimeout(900)
} catch (error) {
  recordingError = error
  console.error(error)
}

await cdp.send('Page.stopScreencast').catch(() => {})
await frameQueue
const targetFrames = Math.ceil((Date.now() - recordStart) / 1000 * fps)
while (lastFrame !== null && frameCount < targetFrames) {
  await writeFrame(lastFrame)
  frameCount += 1
}
ffmpeg.stdin.end()
const [exitCode] = await once(ffmpeg, 'exit')
if (exitCode !== 0) throw new Error(`ffmpeg failed (${String(exitCode)}): ${ffmpegError}`)

const probe = spawnSync('/opt/homebrew/bin/ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', output,
], { encoding: 'utf8' })
let duration = Number(probe.stdout.trim())
if (Number.isFinite(duration) && duration > 29.2) {
  const compressed = output.replace(/\.mp4$/u, '-compressed.mp4')
  const factor = duration / 28.5
  const result = spawnSync('/opt/homebrew/bin/ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', output,
    '-vf', `setpts=PTS/${factor.toFixed(6)},fps=30`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-an', compressed,
  ])
  if (result.status !== 0) throw new Error('30 秒压缩失败')
  renameSync(compressed, output)
  duration = 28.5
}

const lines = [
  script.name,
  `duration=${duration.toFixed(2)}s`,
  ...actions.map((action, index) => `${String(index + 1).padStart(2)} t=${action.time.toFixed(1)}s ${action.label}`),
]
await import('node:fs/promises').then(fs => fs.writeFile(timelinePath, `${lines.join('\n')}\n`))
console.log(`VIDEO=${output}`)
console.log(`DURATION=${duration.toFixed(2)}`)
if (recordingError !== undefined) throw recordingError
process.exit(0)
