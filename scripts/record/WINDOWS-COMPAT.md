# Windows 兼容说明

本 skill 的模板默认在 **macOS** 下验证通过（`headless: false` + `deviceScaleFactor: 2`）。

> ✅ **已自动化**：`install.mjs` 会检测 `process.platform`，在 Windows 上自动把下列调整应用到拷贝后的项目副本，不需要手动改。本文件保留作为原理说明 / 排查参考。

---

## W-1 · runner.mjs：headless 模式

**问题**：Windows DPI 缩放（125% / 150%）与 `headless: false` 冲突，导致 viewport 偏移、元素点击坐标错位、视频画面被截断。

**改法**：`scripts/record/runner.mjs` 找到 browser launch 配置：

```js
// 改前（macOS 默认）
headless: false,
args: [
  "--disable-blink-features=AutomationControlled",
  "--no-default-browser-check",
],

// 改后（Windows）
headless: true,
args: [
  "--disable-blink-features=AutomationControlled",
  "--no-default-browser-check",
  "--font-render-hinting=none",
  "--disable-font-subpixel-positioning",
  "--force-color-profile=srgb",
  "--no-proxy-server",
],
```

---

## W-2 · runner.mjs：deviceScaleFactor

**问题**：macOS `deviceScaleFactor: 2` 在 Windows 上会造成渲染尺寸翻倍、坐标错位（因为 Windows 已在系统层做了 DPI 缩放）。

**改法**：

```js
// 改前（macOS 默认）
deviceScaleFactor: 2,

// 改后（Windows）
deviceScaleFactor: 1,
```

---

## W-3 · runner.mjs：系统代理导致 `page.goto` 卡死在 localhost

**问题**：Windows 上若开了系统级代理（VPN / 公司代理 / 部分加速器），Playwright 启动的 Chromium 默认会读取系统代理设置，
导致连 `http://127.0.0.1:5173` 这种纯本地地址也被错误地转发给代理 → `page.goto` 卡到 `Timeout 30000ms exceeded`。
**`curl http://127.0.0.1:5173` 在同一台机器上是瞬间 200**——因为 curl 不读 Windows 系统代理，这个反差是识别这个问题的关键信号。

> ✅ 已自动化：`install.mjs` 在 Windows 上会自动给 `args` 加 `--no-proxy-server`，不需要手动改。

**排查信号**：录制脚本第一步 `navigate` 报 `page.goto: Timeout 30000ms exceeded`，但同时 `curl` 直连同一地址立即返回 200——
这就是代理问题，不要去重启 dev server 或加大 timeout，加这条 flag 才是根因修复。

---

## 三处改动速查表

| 文件 | 改动项 | macOS 默认 | Windows 改为 |
|------|--------|-----------|-------------|
| `runner.mjs` | `headless` | `false` | `true` |
| `runner.mjs` | `args` | 2 个基础 flag | 加 4 个 flag（3 个字体渲染 + `--no-proxy-server`） |
| `runner.mjs` | `deviceScaleFactor` | `2` | `1` |
