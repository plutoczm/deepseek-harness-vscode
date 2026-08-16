# 录制前功能审计 · 强制清单

> **录制 ≠ 表演 · 镜头里看见的每个动作必须真有功能。**
> 写完剧本、跑录制之前，每条 step 必须过这份审计 —— 防止"画面演了但功能没实现"穿帮。
> clean-recorder 无字幕，本审计检查选择器、行为可达性和运行结果证据。

---

## 0 · 为什么要这一关

画面演了、按钮点了 —— 但功能根本没实现 / 按钮没 onClick / 拖拽没 handler，
**用户/客户/老板看完会立刻识破"这是 PPT 不是产品"**。

历史踩坑：
- 演示"拖动进度条" → scrubber 实际只能点击圆点，没有 drag handler
- 演示"一键通过审批" → 按钮没绑 onClick，点了画面零变化
- 演示"AI 自动调浏览器" → 实际是 mock-script 预录事件，非真调

---

## 1 · 三轴对账（每条 step 必查）

写完剧本，对每个 **会出现在画面里的动作** 走以下三轴：

### 轴 A · 选择器存在性
- [ ] `click` / `type` / `moveTo` / `waitFor` 中的 `selector` 在源码里能 grep 到吗？
- [ ] 是用 `data-testid` 而不是文案匹配？（防止文案改了 selector 失效）

### 轴 B · 行为可达性
对每个 `click` 动作 ——
- [ ] 这个 element 真有 `onClick` / `href` 吗？grep 源文件确认
- [ ] 点了之后**画面会有可观察的变化**吗？（DOM 变化 / 路由跳转 / 状态切换 / 数据更新）
- [ ] 如果是 form 元素，submit 后有真实响应（API 调用 / state 变更）吗？

### 轴 C · 运行结果证据

对每条 `journey` / `operation`：

- [ ] 剧本是否在触发前用 `captureState` 捕获结果基线？
- [ ] 基线和断言之间是否真的执行了 `click` / `type` / `drag`？
- [ ] 是否用同一 `evidenceKey` 的 `waitForStateChange` 等到本轮新结果？
- [ ] `operationEvidence.preflight` 是否来自真实试跑，而不是读源码后推断？
- [ ] 涉及凭证、计费或外部写入时，是否已有明确授权；否则是否使用已确认并披露的 fixture？

只切页、切 Tab、展开设置或输入但不提交，统一归类为 `feature-overview`。

---

## 2 · 三类常见穿帮 · 修法对照

### 类型 1 · 死按钮（点了无反应）
| 症状 | 修法 |
|---|---|
| Server Component 的 `<button>` 没 onClick | 整页加 `"use client"` + useState + onClick handler |
| 点击后只调 API 但 UI 不反馈 | onClick 后立即 setState 显示乐观更新 + 成功状态 |
| 按钮组没有"已处理"反馈 | 用 disabled / 状态徽章 / 卡片淡出 等可视化 |

### 类型 2 · 演示链路断裂
| 症状 | 修法 |
|---|---|
| navigate 到一个静态展示页（没真功能） | 改 navigate 到真功能页 / 砍掉这段 |
| click 跨多个页面但 state 不连贯 | 在每个页面单独完成一个完整动作 + 反馈 |
| waitFor 的 selector 永远不出现 | 改用 mock-script 已知会触发的 selector |

### 类型 3 · mock 数据穿帮
| 症状 | 修法 |
|---|---|
| 演示的数据是写死的 mock，没有任何动态变化 | 不强行演示成"真实/实时"；如果观众会质疑，提前在剧本备注里标注是演示态 |

---

## 3 · 录制前 5 步检查清单

```
[ ] 1. 走 grep：剧本里每个 selector / data-testid 在源码里能 grep 到
       grep -rn "btn-approve\|data-testid" src/

[ ] 2. 单步过：把每个 click step 的目标元素，到源文件确认有 onClick
       grep -n "onClick" src/app/<page>.tsx

[ ] 3. 跑合同门禁：pnpm record:validate
       journey/operation 必须包含基线、触发动作与状态变化断言

[ ] 4. 跑预演：先用 RECORD_SLOWMO=300 慢速跑一次，肉眼盯每个动作
       是否真的有可观察的画面变化

[ ] 5. 清除 RECORD_SLOWMO 后跑素版：pnpm record:raw
       再执行 pnpm record:validate-cadence <对应的-raw-actions.json>
       每次 moveTo 配置 ≤600ms、实际 ≤1000ms；不能只看抽帧判断鼠标节奏
```

**5 项全过 → 才能正式录制 + 转码。**

---

## 4 · 本项目功能现状清单 · 录制前必填

> 这是当前项目的 ground truth · 每个新剧本写之前把要演的功能登记到对应一栏。
> **不在 ✅ 的功能 → 不许演。**

### ✅ 已实现 · 可放心演

| 功能 | 入口（路由 / selector） | 验证方式 |
|---|---|---|
| _（在此填入）_ | _（路由 / data-testid）_ | _（grep 源码 / 真 API / mock fallback）_ |

### ❌ 未实现 / 半成品 · 演了会穿帮

| 功能 | 当前状态 | 处理建议 |
|---|---|---|
| _（在此填入）_ | _（缺 onClick / 静态展示 / 路由通了页面空 ...）_ | _（不演 / 改写）_ |

### ⚠️ 是 mock 但视觉真

| 功能 | mock 来源 | 处理建议 |
|---|---|---|
| _（在此填入）_ | _（mock-script.ts / 静态写死 / fallback）_ | _（可以演，不强行暗示真实调用）_ |

---

## 5 · 致 future agent

> 你正在写一条产品演示剧本。
> 镜头里**每个动作必须真有功能**。
>
> 写完剧本之后：
> 1. 过第 3 节 5 步检查清单
> 2. 对照第 4 节功能清单，确认你只演了 ✅ 部分
>
> 不过就重写，不过就重写，不过就重写。
