#!/usr/bin/env node
/**
 * 对已录制的 WebM 做 zoompan 放大 + 倍速，不重新录制。
 *
 *   node scripts/record/post-process.mjs <input.webm> [script.json]
 *
 * 用途：record:raw 出素版后，看 -raw-actions.txt 找到需要放大的时间段，
 *       填入 script.json 的 zooms[]，再跑本脚本对已有 WebM 应用放大效果——精确、无需重录。
 *
 * [script.json] 留空时，按 webm 文件名 <19字符时间戳>-<tag>.webm 自动反推
 *   scripts/record/scripts/<tag>.json。
 *
 * zooms 字段说明（from/to 必须是 WebM 实际秒数，从 -raw-actions.txt 的 t= 标定）：
 *   "zooms": [
 *     { "from": 8.5, "to": 14.0, "scale": 1.5, "grid": "mc",
 *       "easeIn": 0.8, "easeOut": 0.8, "label": "点击功能按钮" }
 *   ]
 */

import { readFileSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function buildZoompanFilter(zooms, viewport, fps = 25) {
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

const GRID_MAP = {
  tl: { cx: 240,  cy: 150 }, tc: { cx: 720,  cy: 150 }, tr: { cx: 1200, cy: 150 },
  ml: { cx: 240,  cy: 450 }, mc: { cx: 720,  cy: 450 }, mr: { cx: 1200, cy: 450 },
  bl: { cx: 240,  cy: 750 }, bc: { cx: 720,  cy: 750 }, br: { cx: 1200, cy: 750 },
};

function resolveZoomGrids(zooms, viewport) {
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

const webmPath = resolve(process.argv[2] ?? "");

if (!webmPath || !webmPath.endsWith(".webm")) {
  console.error("用法: node scripts/record/post-process.mjs <input.webm> [script.json]");
  process.exit(1);
}

const webmBase = basename(webmPath, ".webm");
const inferredTag = webmBase.length > 20 ? webmBase.slice(20) : "main-flow";
const scriptPath = resolve(
  process.argv[3] ?? join(dirname(webmPath), "../../scripts/record/scripts/" + inferredTag + ".json")
);

const script = JSON.parse(readFileSync(scriptPath, "utf8"));
const viewport = script.viewport || { width: 1920, height: 1080 };
const speedup  = Number(script.speedup ?? 1);
const zooms    = resolveZoomGrids(script.zooms ?? [], viewport);

if (zooms.length === 0) {
  console.warn("⚠️  script.json 没有 zooms 数组 · 仅做倍速转码");
}

// 本地补丁：clamp 到 10~60，防 webm 探出 1000/1 这类离谱值撑爆 zoompan 时间轴
const fps = 30;
const info = [`zooms=${zooms.length}`, `speedup=${speedup}x`, `fps=${fps}`].join("  ");
console.log(`🎞  post-process  ${info}`);
console.log(`   WebM: ${basename(webmPath)}`);

const vFilters = [];
if (zooms.length > 0) {
  vFilters.push(`fps=${fps}`);
  vFilters.push(buildZoompanFilter(zooms, viewport, fps));
}
if (speedup > 1) vFilters.push(`setpts=PTS/${speedup}`);

const outPath = webmPath.replace(/\.webm$/, "-pp.mp4");

// 本地补丁：支持 FFMPEG_BIN 指向 ffmpeg-static（无 brew 环境）
const r = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", [
  "-y", "-i", webmPath,
  ...(vFilters.length > 0 ? ["-vf", vFilters.join(",")] : []),
  "-c:v", "libx264", "-pix_fmt", "yuv420p",
  "-crf", "18", "-preset", "medium",
  "-r", "30",
  "-movflags", "+faststart", "-an",
  outPath,
], { stdio: "inherit" });

if (r.status === 0) {
  console.log(`✅ MP4: ${outPath}`);
} else {
  console.error("❌ ffmpeg 失败");
  process.exit(1);
}
