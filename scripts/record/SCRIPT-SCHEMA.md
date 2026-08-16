# 剧本 schema 速查 · runner.mjs 真支持的 action

> runner.mjs 是 source of truth。本文档摘录所有可用 action 与字段，方便写新剧本时即查即用。
> clean-recorder 无字幕系统：没有 `subtitle` action，`scene` 只负责滚动，没有字幕锚点。

## 顶层字段

```jsonc
{
  "name": "剧本名 · 仅打印用",
  "baseUrl": "http://127.0.0.1:3333",      // 必填 · dev server 地址 · 用 127.0.0.1 不用 localhost
  "demonstration": {                        // journey / operation 必填，且与 recording-plan 一致
    "kind": "journey",
    "mode": "live-result",
    "evidenceKey": "generated-report",
    "resultDescription": "本轮操作后出现新报告"
  },
  "viewport": { "width": 1200, "height": 750 },
  "slowMo": 0,                              // 高层 step 间减速 ms · 仅调试 · 验收素材必须为 0
  "speedup": 1.0,                           // ffmpeg setpts 倍速 · 1=原速 · 2=2x · 1.5=1.5x
  "zooms": [                                // 可选 · zoompan 放大区间列表
    {
      "from": 8.5, "to": 14.0,             // WebM 实际秒数（由 record:raw 输出的 -raw-actions.txt 标定）
      "scale": 1.5,                         // 放大倍数（1.5 裁 2/3 区域；2.0 裁 1/2 区域）
      "cx": 600, "cy": 375,                 // 放大中心点像素坐标（或用 grid 字段替代）
      "easeIn": 0.8, "easeOut": 0.8,
      "label": "说明标签 · 不影响输出"
    }
  ],
  "steps": [ ... ]
}
```

## step 通用字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `action` | string | 必填 · 见下表 |
| `at` | string | 时序注释如 `"0:12"` · 仅打印 · 不参与逻辑 · **实际录制时间看 runner 打印的 `t=Xs`** |

## action 列表

| action | 主要字段 | 说明 |
|---|---|---|
| `navigate` | `url` · `settleMs` (默认 600) | 跳路由 · settleMs 等 hydration · ⚠️ Next.js 首跳建议 ≥ 1500 |
| `wait` | `ms` (默认 1000) | 死等 |
| `scene` | `anchor` · `framing` · `settleMs` · `scrollDuration` · `hold` | 滚到锚点元素（纯滚动，不带字幕，见下） |
| `scrollTo` | `y` · `duration` (默认 1500) | 平滑滚到绝对 y · 缓动函数 ease-out cubic |
| `scrollBy` | `y` · `duration` (默认 1500) · `waitMs` | 相对滚动 |
| `scroll` | `y` · `duration` (默认 1200) · `waitMs` | 兼容写法，等价于 `scrollTo` |
| `scrollEl` | `selector` · `y` · `duration` (默认 1200) · `waitMs` | 滚动指定元素（非 window/main），用于内部有独立滚动容器的面板 |
| `scrollFull` | `chunkY` (默认 900) · `duration` (默认 1600) · `settleMs` (默认 100) | **自动滚到底** · 每步 ≤ chunkY px · 懒加载页面也能滚完 |
| `moveTo` | `selector` 或 `x,y` · `steps` (默认 30) · `moveMs` (默认 350，成片上限 600) | 仅移动鼠标 · 不点 |
| `click` | `selector` 或 `text` 或 `x,y` · `steps` (默认 30) · `moveMs` (默认 350) · `preClickMs` (默认 140) · `waitMs` | 移动 + 点击 · 自动等元素可见 · `text` 形式会同时匹配 button/a |
| `type` | `selector` · `text` · `speed` (默认 80ms/字符) | 自动 click + 清空 + 逐字打字 |
| `waitFor` | `selector` · `timeout` (默认 15000) | 等元素出现 |
| `captureState` | `key` · `selector` · `read` · `attribute` | 触发前读取结果基线；`read` 支持 count/text/value/checked/attribute/url |
| `waitForStateChange` | `key` · `timeout`，可覆盖 `selector/read/attribute` | 等同 key 的状态与基线不同；超时即失败 |
| `drag` | `x1,y1,x2,y2` · `steps` (默认 60) | 鼠标拖拽 |
| `wheel` | `deltaY`/`y` · `steps`/`count` (默认 8) · `duration` | 模拟滚轮，自动定位到可滚动容器中心 |

## scene action · 纯滚动锚点

```jsonc
{
  "action": "scene",
  "anchor": "#features",                     // (a) CSS selector
  // "anchor": { "y": 1200 },                // (b) 滚到绝对 y
  // "anchor": { "scrollBy": 700 },          // (c) 相对滚动
  "framing": "center",                       // 'center' (默认) | 'top'
  "scrollDuration": 1200,
  "settleMs": 400,
  "hold": 0                                   // 滚完额外停留 ms（无字幕场景一般不需要）
}
```

**内部时序**：滚到锚点 → wait settleMs → (可选 hold) → 下一步。

## 运行结果证据

完整项目主旅程和指定操作必须形成以下顺序：

```jsonc
[
  {
    "action": "captureState",
    "key": "generated-report",
    "selector": "[data-testid='report-card']",
    "read": "count"
  },
  {
    "action": "click",
    "selector": "[data-testid='run-research']"
  },
  {
    "action": "waitForStateChange",
    "key": "generated-report",
    "timeout": 60000
  }
]
```

普通 `waitFor` 只证明元素可见；若元素在触发前已经存在，它不能证明本轮操作产生了结果。
生成剧本后先运行 `pnpm record:validate`。仅导航、切换或展开的剧本必须标成
`feature-overview`，不能作为完整项目主片。

## 剧本编排三原则（必须全部满足）

1. **全程模拟鼠标路径** — 每次 `click` 前必须有 `moveTo` 把鼠标移到目标，点完必须有 `moveTo` 把鼠标移回主内容区中心；页面切换优先用 `click 侧边栏链接`，不用 `navigate` URL 跳转（仅首屏冷启动允许 `navigate`）
2. **充分点击展示功能** — 每个演示的功能点必须有真实的 `click` 交互，不能只是滚动看看或 `scene` 对准就算演示
3. **充分滚轮展示内容** — 不能只靠 `scene` 的 scrollIntoView 跳切：
   - **长页面/首页** → 用 `scrollFull`
   - **短距离精确滚动**（结果区域）→ 用 `scrollBy`，`y` ≤ 350px/步

**鼠标与侧边栏**：
- 侧边栏导航链接**只在页面切换时短暂经过**：`moveTo 侧边栏链接` → `click` → `moveTo (主内容区中心)`
- ❌ 侧边栏以外的任何时间，鼠标必须在主内容区——否则 `scrollBy`/`wheel` 的滚动事件会被侧边栏吃掉

**滚动节奏**：
- `scrollDuration` 建议 1000–1500ms，不低于 800ms
- 手动 `scrollBy` 每步 `y` ≤ 350px——`scrollFull` 内部分块（默认 900px）不受此限制

## zoom 标定参考 · 没有字幕时间表，用动作时间表代替

`record:raw` 出片后会额外产出 `<ts>-<tag>-raw-actions.txt`，记录每个 step 真实发生的 `t=` 秒数：

```
 #   t=           action       detail
 -   ----------   ----------   ------
 1   t=0.0s       navigate     /
 2   t=1.6s       wait         1000ms
 3   t=4.2s       click        button:has-text('运行场景')
 4   t=8.9s       scrollBy     y=320
```

用这份时间表确定 `zooms[].from/to`，不要用剧本里的 `at` 标称时间（实际执行时间会有偏差）。
同次录制还会生成 `-raw-actions.json`；正式出片前必须运行：

```bash
pnpm record:validate-cadence artifacts/recordings/<ts>-<tag>-raw-actions.json
```

该门禁要求调试 step 延迟为 0、每个 `moveTo.moveMs` ≤600ms 且实际执行 ≤1000ms。

标定公式：
```
zoom.from = 关键动作 t= − easeIn − 0.2（冗余）
zoom.to   = 结果展示完成的 t= 值
```

## 环境变量

| ENV | 作用 |
|---|---|
| `RECORD_RAW=1` | 素版模式 · 无 zoom 无倍速 · 输出 -raw.mp4 + -raw-actions.txt |
| `RECORD_SLOWMO=300` | 临时在高层 step 之间停顿 · 仅调试；正式 raw/prod 必须清除 |
