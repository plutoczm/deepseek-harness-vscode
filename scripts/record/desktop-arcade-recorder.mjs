#!/usr/bin/env node

import { once } from 'node:events'
import { readFileSync, mkdirSync, renameSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const scriptPath = resolve(process.argv[2] ?? 'scripts/record/scripts/feat-whale-arcade.json')
const script = JSON.parse(readFileSync(scriptPath, 'utf8'))
const playOnly = process.env.ARCADE_PLAY_ONLY === '1'
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

await closeCompletedDialog()
for (let index = 0; index < 2; index += 1) {
  const petClose = page.locator('.dshpet-x:visible')
  if (await petClose.count()) await petClose.last().click({ force: true })
}
let search
if (!playOnly) {
  if (!(await page.getByRole('searchbox', { name: '搜索插件' }).count())) {
    await page.getByRole('button', { name: '插件中心' }).click()
  }
  search = page.getByRole('searchbox', { name: '搜索插件' })
  await search.waitFor({ timeout: 30_000 })
  await search.fill('')
  await page.evaluate(() => {
    const scroller = document.querySelector('main')?.parentElement
    if (scroller instanceof HTMLElement) scroller.scrollTop = 0
  })
  await page.waitForTimeout(350)
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
  await locator.scrollIntoViewIfNeeded({ timeout: 1_500 }).catch(() => {})
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

async function confirmDialog(actionLabel) {
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ timeout: 30_000 })
  await click(dialog.getByRole('checkbox'), `${actionLabel}：授权确认`)
  await click(dialog.getByRole('button', { name: actionLabel, exact: true }), actionLabel)
}

async function waitInstall() {
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"]')]
    .some(element => element.textContent?.includes('已完成') || element.textContent?.includes('已可运行')), {}, { timeout: 120_000 })
  mark('插件已安装')
  await page.waitForTimeout(240)
  await click(page.getByRole('button', { name: '完成', exact: true }), '关闭完成状态')
}

let recordingError
try {
  if (!playOnly) {
    mark('开始：鲸鱼游戏中心未安装')
    await page.waitForTimeout(300)
    await moveTo(search)
    await page.mouse.click(cursorX, cursorY)
    await search.pressSequentially('dsh-whale-arcade', { delay: 38 })
    mark('搜索 dsh-whale-arcade')
    const card = page.locator('li').filter({ hasText: 'dsh-whale-arcade' }).first()
    await card.waitFor({ timeout: 30_000 })
    await page.waitForTimeout(220)
    await click(card.getByRole('button', { name: '安装', exact: true }), '点击安装')
    await confirmDialog('确认安装')
    await waitInstall()
    await page.reload({ waitUntil: 'domcontentloaded' })
    mark('重新加载客户端')
    await page.waitForTimeout(1400)
  } else {
    mark('开始：鲸鱼游戏中心已加载')
    await page.waitForTimeout(450)
  }
  const gameTitle = page.getByText('鲸鱼跃浪', { exact: true }).first()
  if (!(await gameTitle.isVisible().catch(() => false))) {
    const launcher = page.getByRole('button', { name: '打开鲸鱼游戏中心' })
    await click(launcher, '打开鲸鱼游戏中心')
  }
  await gameTitle.waitFor({ timeout: 20_000 })
  const gameButton = gameTitle.locator('xpath=ancestor::button[1]')
  await click((await gameButton.count()) ? gameButton : gameTitle, '选择鲸鱼跃浪')
  const start = page.getByRole('button', { name: /开始/u }).last()
  await click(start, '开始游戏')
  for (let index = 0; index < 8; index += 1) {
    await page.waitForTimeout(260)
    await page.keyboard.press('Space')
  }
  mark('试玩模板')
  await page.waitForTimeout(700)
  const close = page.getByRole('button', { name: /关闭/u }).last()
  await click(close, '关闭游戏浮层')
  await page.waitForTimeout(500)
  const launcher = page.getByRole('button', { name: '打开鲸鱼游戏中心' })
  await click(launcher, '重新打开游戏中心')
  mark('完成：游戏状态已重新加载')
  await page.waitForTimeout(1100)
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
