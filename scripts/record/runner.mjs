#!/usr/bin/env node
/**
 * Playwright 录制驱动 · clean-recorder · 无字幕版本
 * 保留：虚拟鼠标 + ripple + zoompan 放大效果
 * 移除：字幕系统（无 subtitle action，无 lint，无三步走）
 *
 * 平台说明：
 *   macOS 默认 headless: false + deviceScaleFactor: 2（Retina 高清）
 *   Windows 需要手动调整三处，详见 scripts/record/WINDOWS-COMPAT.md
 *
 *   node scripts/record/runner.mjs scripts/record/scripts/main-flow.json
 *
 * 输出（RAW 模式）：
 *   artifacts/recordings/<timestamp>-<scriptname>-raw.mp4
 *   artifacts/recordings/<timestamp>-<scriptname>-raw-actions.txt  ← zoom 标定参考
 * 输出（成品模式）：
 *   artifacts/recordings/<timestamp>-<scriptname>.webm
 *   artifacts/recordings/<timestamp>-<scriptname>.mp4
 *
 * 环境变量：
 *   RECORD_RAW=1      素版模式：无 zoom 无倍速，输出 -raw.mp4 + -raw-actions.txt
 *   RECORD_SLOWMO=N   每步骤延迟 N ms（调试用）
 */

import { chromium } from "playwright";
import { readFileSync, mkdirSync, renameSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

/* ─────────── CLI ─────────── */

const scriptArg = process.argv[2] || "scripts/record/scripts/main-flow.json";
const scriptPath = resolve(scriptArg);
if (!existsSync(scriptPath)) {
  console.error("剧本文件不存在:", scriptPath);
  process.exit(1);
}
const script = JSON.parse(readFileSync(scriptPath, "utf8"));

const baseUrl = script.baseUrl || "http://localhost:3333";
const viewport = script.viewport || { width: 1920, height: 1080 };
const stepDelayMs = Number(process.env.RECORD_SLOWMO ?? script.slowMo ?? 0);
if (!Number.isFinite(stepDelayMs) || stepDelayMs < 0) {
  throw new Error("RECORD_SLOWMO / script.slowMo 必须是非负数字");
}
const RAW_MODE = process.env.RECORD_RAW === "1";
if (RAW_MODE) console.log("⚪ RAW 模式 · 仅鼠标 · 无 zoom · 无倍速 · 输出动作时间表\n");

/* ─────────── 输出路径 ─────────── */

const ts = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace("T", "-")
  .slice(0, 19);
const tag = basename(scriptPath, ".json");
const outDir = join(repoRoot, "artifacts/recordings");
mkdirSync(outDir, { recursive: true });

/* ─────────── 注入 cursor CSS + JS ─────────── */

const cursorCss = readFileSync(
  join(__dirname, "inject/cursor-overlay.css"),
  "utf8"
);
const cursorJs = readFileSync(
  join(__dirname, "inject/cursor-overlay.js"),
  "utf8"
);

/* ─────────── zoompan 表达式生成器 ─────────── */

function getVideoFps(videoPath) {
  const r = spawnSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=r_frame_rate",
    "-of", "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ], { encoding: "utf8" });
  if (r.status !== 0) return 25;
  const raw = r.stdout.trim();
  const [n, d] = raw.split("/").map(Number);
  return d ? n / d : n || 25;
}

function buildZoompanFilter(zooms, viewport, fps = 30) {
  const W = viewport.width;
  const H = viewport.height;
  const F = fps;

  function sec(t) {
    if (typeof t === "number") return t;
    const p = String(t).split(":").map(Number);
    if (p.length === 1) return p[0];  // 纯数字字符串（如 "8.5"）
    return p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2];
  }

  const T = `on/${F}`;
  const list = [...zooms].sort((a, b) => sec(a.from) - sec(b.from));

  function pw(segs, def) {
    let expr = String(def);
    for (let i = segs.length - 1; i >= 0; i--) {
      const { f0, f1, v } = segs[i];
      expr = `if(between(${T},${f0},${f1}),${v},${expr})`;
    }
    return expr;
  }

  const zS = [], cxS = [], cyS = [];

  for (const z of list) {
    const f0 = sec(z.from), f1 = sec(z.to);
    const S  = z.scale   ?? 1.5;
    const ei = z.easeIn  ?? 0.8;
    const eo = z.easeOut ?? 0.6;
    const cx = z.cx ?? W / 2;
    const cy = z.cy ?? H / 2;
    const half = (f1 - f0) / 2;
    const hs = f0 + Math.min(ei, half);
    const es = f1 - Math.min(eo, half);
    const eiDur = Math.round((hs - f0) * 1e6) / 1e6;
    const eoDur = Math.round((f1 - es) * 1e6) / 1e6;
    const zV =
      `if(lt(${T},${hs}),` +
        `1+(${S}-1)*(3*pow((${T}-${f0})/${eiDur},2)-2*pow((${T}-${f0})/${eiDur},3)),` +
        `if(lt(${T},${es}),${S},` +
          `${S}-(${S}-1)*(3*pow((${T}-${es})/${eoDur},2)-2*pow((${T}-${es})/${eoDur},3))))`;
    zS.push({ f0, f1, v: zV });
    cxS.push({ f0, f1, v: String(cx) });
    cyS.push({ f0, f1, v: String(cy) });
  }

  const zE  = pw(zS, 1);
  const cxE = pw(cxS, W / 2);
  const cyE = pw(cyS, H / 2);
  const xE = `max(0,min(iw-iw/zoom,${cxE}-iw/zoom/2))`;
  const yE = `max(0,min(ih-ih/zoom,${cyE}-ih/zoom/2))`;
  return `zoompan=z='${zE}':x='${xE}':y='${yE}':d=1:fps=${F}:s=${W}x${H}`;
}

/* ─────────── 九宫格坐标系 ─────────── */

const GRID_MAP = {
  tl: { cx: 240,  cy: 150 },
  tc: { cx: 720,  cy: 150 },
  tr: { cx: 1200, cy: 150 },
  ml: { cx: 240,  cy: 450 },
  mc: { cx: 720,  cy: 450 },
  mr: { cx: 1200, cy: 450 },
  bl: { cx: 240,  cy: 750 },
  bc: { cx: 720,  cy: 750 },
  br: { cx: 1200, cy: 750 },
};

function resolveZoomGrids(zooms, viewport) {
  // 本地补丁：九宫格坐标按 viewport 缩放（GRID_MAP 基于 1440x900 标定），与 post-process.mjs 保持一致
  const scaleX = viewport.width  / 1440;
  const scaleY = viewport.height / 900;
  return zooms.map((z) => {
    if (z.grid && GRID_MAP[z.grid]) {
      const { cx, cy } = GRID_MAP[z.grid];
      return { ...z, cx: cx * scaleX, cy: cy * scaleY };
    }
    return z;
  });
}

/* ─────────── 启动 Playwright ─────────── */

const resolvedZooms = resolveZoomGrids(script.zooms ?? [], viewport);

console.log(`🎬 ${script.name || tag}`);
console.log(`   base=${baseUrl}  viewport=${viewport.width}x${viewport.height}`);
console.log(`   steps=${script.steps.length}  zooms=${resolvedZooms.length}\n`);

let recordStartMs = null;
let cursorX = viewport.width / 2;
let cursorY = viewport.height / 2;

const browser = await chromium.launch({
  headless: process.env.RECORD_HEADLESS !== "0",  // 本地补丁：默认 headless（无人值守/CI 可跑），RECORD_HEADLESS=0 显示浏览器窗口
  args: [
    "--disable-blink-features=AutomationControlled",
    "--no-default-browser-check",
  ],
});

recordStartMs = Date.now();
const context = await browser.newContext({
  viewport,
  baseURL: baseUrl,
  recordVideo: { dir: outDir, size: viewport },
  deviceScaleFactor: 2,  // macOS Retina 高清；Windows 改为 1，见 WINDOWS-COMPAT.md W-2
});

await context.addInitScript({
  content: `
    try { const __ls = ${JSON.stringify(JSON.parse(process.env.RECORD_LOCALSTORAGE || "{}"))}; for (const k in __ls) localStorage.setItem(k, __ls[k]); } catch(e){}
    window.__REC_CSS__ = ${JSON.stringify(cursorCss)};
    ${cursorJs}
    window.__getScroller = function() {
      const m = document.querySelector("main");
      if (m) {
        const cs = getComputedStyle(m);
        if (/(auto|scroll)/.test(cs.overflowY) && m.scrollHeight > m.clientHeight) return m;
      }
      const de = document.scrollingElement || document.documentElement;
      if (de.scrollHeight > de.clientHeight + 4) return de;
      const SKIP = new Set(["aside", "nav", "header", "footer"]);
      for (const el of document.querySelectorAll("*")) {
        if (SKIP.has(el.tagName.toLowerCase())) continue;
        if (el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
      }
      return de;
    };
    const __recKillDevOverlay = () => {
      document.querySelectorAll('nextjs-portal').forEach(el => el.remove());
    };
    function __recSetupDevOverlayKiller() {
      if (!document.documentElement) {
        requestAnimationFrame(__recSetupDevOverlayKiller);
        return;
      }
      __recKillDevOverlay();
      new MutationObserver(__recKillDevOverlay).observe(document.documentElement, { childList: true, subtree: true });
    }
    __recSetupDevOverlayKiller();
  `,
});

const page = await context.newPage();

/* ─────────── 动作时间表（RAW 模式收集，用于标定 zoom from/to）─────────── */

const actionTimeline = [];

function recordAction(action, detail, expectedDurationMs = null) {
  if (!RAW_MODE) return null;
  const t = recordStartMs != null ? (Date.now() - recordStartMs) / 1000 : 0;
  const entry = {
    t,
    action,
    detail: detail || "",
    expectedDurationMs,
    durationMs: null,
  };
  actionTimeline.push(entry);
  return entry;
}

/* ─────────── 步骤执行器 ─────────── */

async function glideTo(x, y, steps = 30, durationMs = 350) {
  const startX = cursorX;
  const startY = cursorY;
  const msPerStep = Math.max(8, Math.round(durationMs / steps));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const nx = Math.round(startX + (x - startX) * e);
    const ny = Math.round(startY + (y - startY) * e);
    await page.mouse.move(nx, ny, { steps: 1 });
    if (i < steps) await page.waitForTimeout(msPerStep);
  }
  cursorX = x;
  cursorY = y;
}

async function bboxCenter(selector) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 10_000 });
  const box = await loc.boundingBox();
  if (!box) throw new Error(`无法取到 bbox: ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const capturedStates = new Map();
const stateReaders = new Set(["count", "text", "value", "checked", "attribute", "url"]);

function stateSpec(step, fallback = {}) {
  const spec = {
    selector: step.selector ?? fallback.selector,
    read: step.read ?? fallback.read ?? "text",
    attribute: step.attribute ?? fallback.attribute,
  };
  if (!stateReaders.has(spec.read)) throw new Error(`不支持的状态读取方式: ${spec.read}`);
  if (spec.read !== "url" && !spec.selector) throw new Error(`${step.action} 缺 selector`);
  if (spec.read === "attribute" && !spec.attribute) throw new Error(`${step.action} 缺 attribute`);
  return spec;
}

async function readObservedState(spec) {
  if (spec.read === "url") return page.url();
  const loc = page.locator(spec.selector);
  if (spec.read === "count") return loc.count();
  if ((await loc.count()) === 0) return null;
  const first = loc.first();
  if (spec.read === "text") return first.textContent();
  if (spec.read === "value") return first.inputValue();
  if (spec.read === "checked") return first.isChecked();
  return first.getAttribute(spec.attribute);
}

async function waitForObservedStateChange(spec, baseline, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await readObservedState(spec);
    if (JSON.stringify(current) !== JSON.stringify(baseline)) return current;
    await page.waitForTimeout(100);
  }
  throw new Error(`等待状态变化超时（${timeout}ms）`);
}

async function runStep(step, idx) {
  const actionStartedMs = Date.now();
  const stepTag = step.at ? `[${step.at}]` : `#${idx + 1}`;
  const elapsedS = recordStartMs != null ? ((Date.now() - recordStartMs) / 1000).toFixed(1) : "?";
  console.log(`${stepTag} t=${elapsedS}s ${step.action.padEnd(10)}`);

  // 每个 step 的动作记录到时间表（RAW 模式写入文件）
  const detail = step.url || step.selector || step.text || (step.y != null ? `y=${step.y}` : "") || (step.ms != null ? `${step.ms}ms` : "");
  const expectedDurationMs = step.action === "moveTo" ? (step.moveMs ?? 350) : null;
  const timelineEntry = recordAction(step.action, detail, expectedDurationMs);

  switch (step.action) {
    case "navigate": {
      await page.goto(step.url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(step.settleMs ?? 600);
      await page.evaluate(() => {
        document.querySelectorAll('nextjs-portal').forEach(el => el.remove());
      }).catch(() => {});
      await page.mouse.move(viewport.width / 2, viewport.height / 2, { steps: 1 }).catch(() => {});
      cursorX = viewport.width / 2;
      cursorY = viewport.height / 2;
      break;
    }

    case "wait": {
      await page.waitForTimeout(step.ms ?? 1000);
      break;
    }

    case "scene": {
      const settleMs = step.settleMs ?? 400;
      const framing = step.framing ?? "center";
      const dur = step.scrollDuration ?? 1200;

      if (typeof step.anchor === "string") {
        await page.evaluate(
          ({ sel, framing, dur }) =>
            new Promise((resolve) => {
              const scroller = window.__getScroller();
              const el = document.querySelector(sel);
              if (!el) { console.warn("[scene] anchor not found:", sel); resolve(); return; }
              const rect = el.getBoundingClientRect();
              const scrollerRect = (scroller === document.scrollingElement || scroller === document.documentElement)
                ? { top: 0 } : scroller.getBoundingClientRect();
              const absoluteTop = rect.top - scrollerRect.top + scroller.scrollTop;
              const targetY =
                framing === "top"
                  ? absoluteTop - 24
                  : absoluteTop - (scroller.clientHeight - rect.height) / 2;
              const startY = scroller.scrollTop;
              const finalY = Math.max(0, targetY);
              const start = performance.now();
              const tick = (now) => {
                const t = Math.min(1, (now - start) / dur);
                const e = 1 - Math.pow(1 - t, 3);
                scroller.scrollTop = startY + (finalY - startY) * e;
                if (t < 1) requestAnimationFrame(tick);
                else resolve();
              };
              requestAnimationFrame(tick);
            }),
          { sel: step.anchor, framing, dur }
        );
      } else if (step.anchor && typeof step.anchor === "object") {
        const anchor = step.anchor;
        if (typeof anchor.y === "number") {
          await page.evaluate(
            ({ y, dur }) =>
              new Promise((resolve) => {
                const scroller = window.__getScroller();
                const startY = scroller.scrollTop;
                const start = performance.now();
                const tick = (now) => {
                  const t = Math.min(1, (now - start) / dur);
                  const e = 1 - Math.pow(1 - t, 3);
                  scroller.scrollTop = startY + (y - startY) * e;
                  if (t < 1) requestAnimationFrame(tick);
                  else resolve();
                };
                requestAnimationFrame(tick);
              }),
            { y: anchor.y, dur }
          );
        } else if (typeof anchor.scrollBy === "number") {
          await page.evaluate(
            ({ dy, dur }) =>
              new Promise((resolve) => {
                const scroller = window.__getScroller();
                const startY = scroller.scrollTop;
                const target = startY + dy;
                const start = performance.now();
                const tick = (now) => {
                  const t = Math.min(1, (now - start) / dur);
                  const e = 1 - Math.pow(1 - t, 3);
                  scroller.scrollTop = startY + (target - startY) * e;
                  if (t < 1) requestAnimationFrame(tick);
                  else resolve();
                };
                requestAnimationFrame(tick);
              }),
            { dy: anchor.scrollBy, dur }
          );
        }
      }

      await page.waitForTimeout(settleMs);
      if (step.hold) await page.waitForTimeout(step.hold);
      break;
    }

    case "scrollTo": {
      await page.evaluate(
        ({ y, dur }) =>
          new Promise((resolve) => {
            const scroller = window.__getScroller();
            const startY = scroller.scrollTop;
            const start = performance.now();
            const tick = (now) => {
              const t = Math.min(1, (now - start) / dur);
              const e = 1 - Math.pow(1 - t, 3);
              scroller.scrollTop = startY + (y - startY) * e;
              if (t < 1) requestAnimationFrame(tick);
              else resolve();
            };
            requestAnimationFrame(tick);
          }),
        { y: step.y ?? 0, dur: step.duration ?? 1500 }
      );
      break;
    }

    case "scrollBy": {
      await page.evaluate(
        ({ dy, dur }) =>
          new Promise((resolve) => {
            const scroller = window.__getScroller();
            const startY = scroller.scrollTop;
            const target = startY + dy;
            const start = performance.now();
            const tick = (now) => {
              const t = Math.min(1, (now - start) / dur);
              const e = 1 - Math.pow(1 - t, 3);
              scroller.scrollTop = startY + (target - startY) * e;
              if (t < 1) requestAnimationFrame(tick);
              else resolve();
            };
            requestAnimationFrame(tick);
          }),
        { dy: step.y ?? 0, dur: step.duration ?? 1500 }
      );
      if (step.waitMs) await page.waitForTimeout(step.waitMs);
      break;
    }

    case "scrollFull": {
      const chunkY  = step.chunkY  ?? 900;
      const dur     = step.duration ?? 1600;
      const settle  = step.settleMs ?? 100;
      for (;;) {
        const done = await page.evaluate(
          ({ dy, dur }) =>
            new Promise((resolve) => {
              const scroller = window.__getScroller();
              const remaining = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
              if (remaining <= 1) { resolve(true); return; }
              const actualDy = Math.min(dy, remaining);
              const startY = scroller.scrollTop;
              const target = startY + actualDy;
              const start = performance.now();
              const tick = (now) => {
                const t = Math.min(1, (now - start) / dur);
                const e = 1 - Math.pow(1 - t, 3);
                scroller.scrollTop = startY + (target - startY) * e;
                if (t < 1) requestAnimationFrame(tick);
                else resolve(remaining - actualDy <= 1);
              };
              requestAnimationFrame(tick);
            }),
          { dy: chunkY, dur }
        );
        if (done) break;
        await page.waitForTimeout(settle);
      }
      break;
    }

    case "wheel": {
      const mainCenter = await page.evaluate(() => {
        const scroller = window.__getScroller();
        const de = document.scrollingElement || document.documentElement;
        if (scroller === de) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        const r = scroller.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(mainCenter.x, mainCenter.y);
      const deltaY = step.deltaY ?? step.y ?? 300;
      const steps2 = step.steps ?? step.count ?? 8;
      const interval = Math.round(
        (step.duration ?? (step.interval != null ? step.interval * steps2 : 800)) / steps2
      );
      for (let i = 0; i < steps2; i++) {
        await page.mouse.wheel(0, deltaY / steps2);
        await page.waitForTimeout(interval);
      }
      break;
    }

    case "drag": {
      const steps = step.steps ?? 60;
      await page.mouse.move(step.x1, step.y1, { steps: 5 });
      await page.mouse.down();
      await page.mouse.move(step.x2, step.y2, { steps });
      await page.mouse.up();
      break;
    }

    case "moveTo": {
      let x, y;
      if (step.selector) {
        ({ x, y } = await bboxCenter(step.selector));
      } else {
        x = step.x; y = step.y;
      }
      await glideTo(x, y, step.steps ?? 30, step.moveMs ?? 350);
      break;
    }

    case "click": {
      if (step.selector) {
        const { x, y } = await bboxCenter(step.selector);
        await glideTo(x, y, step.steps ?? 30, step.moveMs ?? 350);
        await page.waitForTimeout(step.preClickMs ?? 140);
        await page.locator(step.selector).first().click({ timeout: 5000 });
      } else if (step.text) {
        const loc = page.getByRole("button", { name: step.text }).or(page.getByRole("link", { name: step.text })).first();
        await loc.waitFor({ state: "visible", timeout: 10_000 });
        const box = await loc.boundingBox();
        if (box) await glideTo(box.x + box.width / 2, box.y + box.height / 2, 30, 350);
        await page.waitForTimeout(step.preClickMs ?? 140);
        await loc.click({ timeout: 5000 });
      } else {
        await page.mouse.click(step.x, step.y);
      }
      if (step.waitMs) await page.waitForTimeout(step.waitMs);
      break;
    }

    case "type": {
      const loc = page.locator(step.selector).first();
      await loc.waitFor({ state: "visible" });
      await loc.click();
      await loc.press("ControlOrMeta+a");
      await loc.press("Delete");
      await loc.pressSequentially(step.text, { delay: step.speed ?? 80 });
      break;
    }

    case "captureState": {
      if (!step.key) throw new Error("captureState 缺 key");
      const spec = stateSpec(step);
      const value = await readObservedState(spec);
      capturedStates.set(step.key, { ...spec, value });
      console.log(`  ↳ 已捕获状态基线: ${step.key}`);
      break;
    }

    case "waitForStateChange": {
      if (!step.key) throw new Error("waitForStateChange 缺 key");
      const captured = capturedStates.get(step.key);
      if (!captured) throw new Error(`找不到状态基线: ${step.key}`);
      const spec = stateSpec(step, captured);
      const value = await waitForObservedStateChange(spec, captured.value, step.timeout ?? 15_000);
      capturedStates.set(step.key, { ...spec, value });
      console.log(`  ↳ 已验证运行结果发生变化: ${step.key}`);
      break;
    }

    case "waitFor": {
      await page
        .locator(step.selector)
        .first()
        .waitFor({ state: "visible", timeout: step.timeout ?? 15_000 });
      break;
    }

    case "scroll": {
      // 兼容 case-11 脚本里用的 scroll action（等价于 scrollTo）
      await page.evaluate(
        ({ y, dur }) =>
          new Promise((resolve) => {
            const scroller = window.__getScroller();
            const startY = scroller.scrollTop;
            const start = performance.now();
            const tick = (now) => {
              const t = Math.min(1, (now - start) / dur);
              const e = 1 - Math.pow(1 - t, 3);
              scroller.scrollTop = startY + (y - startY) * e;
              if (t < 1) requestAnimationFrame(tick);
              else resolve();
            };
            requestAnimationFrame(tick);
          }),
        { y: step.y ?? 0, dur: step.duration ?? 1200 }
      );
      if (step.waitMs) await page.waitForTimeout(step.waitMs);
      break;
    }

    case "scrollEl": {
      // 滚动指定选择器的元素（不是 window）
      await page.evaluate(
        ({ sel, y, dur }) =>
          new Promise((resolve) => {
            const el = document.querySelector(sel);
            if (!el) { resolve(); return; }
            const startY = el.scrollTop;
            const start = performance.now();
            const tick = (now) => {
              const t = Math.min(1, (now - start) / dur);
              const e = 1 - Math.pow(1 - t, 3);
              el.scrollTop = startY + (y - startY) * e;
              if (t < 1) requestAnimationFrame(tick);
              else resolve();
            };
            requestAnimationFrame(tick);
          }),
        { sel: step.selector, y: step.y ?? 0, dur: step.duration ?? 1200 }
      );
      if (step.waitMs) await page.waitForTimeout(step.waitMs);
      break;
    }

    default:
      console.warn(`  ⚠️  未知 action: ${step.action} · 跳过`);
  }

  if (timelineEntry) timelineEntry.durationMs = Date.now() - actionStartedMs;
  // RECORD_SLOWMO 是高层 step 间调试延迟。不能传给 Playwright launch：
  // browser slowMo 会给 glideTo 的每个鼠标微步都加延迟，导致 350ms 移标膨胀到数秒。
  if (stepDelayMs > 0) await page.waitForTimeout(stepDelayMs);
}

/* ─────────── 主循环 ─────────── */

let stepError = null;
const t0 = Date.now();
try {
  for (let i = 0; i < script.steps.length; i++) {
    await runStep(script.steps[i], i);
  }
  await page.waitForTimeout(1200);
} catch (e) {
  stepError = e;
  console.error("\n❌ 步骤失败:", e.message);
}

const elapsedMs = Date.now() - t0;

/* ─────────── 收尾 + 转码 ─────────── */

const video = page.video();
await context.close();
await browser.close();

const rawPath = await video.path();
const targetWebm = join(outDir, `${ts}-${tag}.webm`);
renameSync(rawPath, targetWebm);
console.log(`\n✅ WebM: ${targetWebm}  (${(elapsedMs / 1000).toFixed(1)}s)`);

// RAW 模式：输出动作时间表（用于标定 zoom from/to）
if (RAW_MODE && actionTimeline.length > 0) {
  const lines = [
    `${script.name || tag}  动作时间表`,
    `录制时间: ${ts}`,
    `WebM 总时长: ${(elapsedMs / 1000).toFixed(1)}s`,
    `步骤调试延迟: ${stepDelayMs}ms`,
    "",
    ` #   t=           duration     action       detail`,
    ` -   ----------   ----------   ----------   ------`,
  ];
  actionTimeline.forEach((e, i) => {
    lines.push(
      `${String(i + 1).padStart(2)}   t=${String(e.t.toFixed(1) + "s").padEnd(8)}   ` +
      `${String((e.durationMs ?? 0) + "ms").padEnd(10)}   ${e.action.padEnd(12)} ${e.detail}`
    );
  });
  const actionsTxtPath = targetWebm.replace(/\.webm$/, "-raw-actions.txt");
  writeFileSync(actionsTxtPath, lines.join("\n") + "\n");
  console.log(`✅ 动作时间表: ${actionsTxtPath}`);

  const actionsJsonPath = targetWebm.replace(/\.webm$/, "-raw-actions.json");
  writeFileSync(
    actionsJsonPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        script: tag,
        totalDurationMs: elapsedMs,
        stepDelayMs,
        actions: actionTimeline,
      },
      null,
      2
    )}\n`
  );
  console.log(`✅ 动作数据: ${actionsJsonPath}`);
}

const speedup = Number(script.speedup ?? 1);
// 本地补丁：支持 FFMPEG_BIN 指向 ffmpeg-static（无 brew 环境），约定与 extract-posters 一致
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const ffmpegFound = process.env.FFMPEG_BIN
  ? spawnSync(FFMPEG, ["-version"]).status === 0
  : (spawnSync("which", ["ffmpeg"]).status === 0 || spawnSync("where", ["ffmpeg"]).status === 0);

if (ffmpegFound) {
  const suffix = RAW_MODE ? "-raw.mp4" : ".mp4";
  const targetMp4 = targetWebm.replace(/\.webm$/, suffix);
  const vFilters = ["fps=30"];
  if (!RAW_MODE && resolvedZooms.length > 0) {
    // 本地补丁：滤镜链首步已 fps=30 归一，zoompan 时间轴必须用同一个 30（不再用 getVideoFps 探测源 webm）
    console.log(`   zoompan fps=30`);
    vFilters.push(buildZoompanFilter(resolvedZooms, viewport, 30));
  }
  if (!RAW_MODE && speedup > 1) vFilters.push(`setpts=PTS/${speedup}`);
  const filterArgs = vFilters.length > 0 ? ["-vf", vFilters.join(",")] : [];
  const modeTag = RAW_MODE ? "素版转码" : [
    resolvedZooms.length > 0 ? `${resolvedZooms.length} 段 zoompan` : "",
    speedup > 1 ? `×${speedup} 加速` : "",
  ].filter(Boolean).join(" + ") || "转码";
  console.log(`🎞  ffmpeg ${modeTag} → ${basename(targetMp4)}`);
  const r = spawnSync(
    FFMPEG,
    [
      "-y",
      "-i", targetWebm,
      ...filterArgs,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-crf", "18",
      "-r", "30",
      "-movflags", "+faststart",
      "-an",
      targetMp4,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  if (r.status === 0) console.log(`✅ MP4:  ${targetMp4}`);
  else console.warn("⚠️  ffmpeg 转码失败:", r.stderr?.toString().slice(-400));
} else if (process.env.FFMPEG_BIN) {
  console.log(`ℹ️  FFMPEG_BIN=${process.env.FFMPEG_BIN} 探测失败（路径/架构？）· 跳过转码`);
} else {
  console.log("ℹ️  未发现 ffmpeg · 跳过 MP4 转码");
}

if (stepError) process.exit(2);
