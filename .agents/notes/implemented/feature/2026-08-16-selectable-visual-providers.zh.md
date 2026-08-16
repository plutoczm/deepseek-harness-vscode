# Agent Note: 可选择视觉提供方

Status: implemented

[English](2026-08-16-selectable-visual-providers.md) | 中文

## Problem

Desktop 视觉旁路原先把配置、凭证保存和图片请求都绑定到百炼。它使用的可写凭证引用也是 `DASHSCOPE_API_KEY`，但由启动 Shell 提供的同名值会被本地凭证提供方有意视为只读。用户在界面填写替换 Key 时，系统因此会尝试遮蔽环境值并报错，无法完成验证。学员还需要 OpenRouter 路径，同时不能替换主要的 DeepSeek 对话模型。

## Decision

视觉增强弹窗会在真实图片验证前选择百炼或 OpenRouter。百炼继续固定使用 `qwen3.8-max`；OpenRouter 默认使用 `openai/gpt-4.1-mini`，并允许输入另一个非空且支持视觉的模型 id。只有该提供方与模型组合完成验证后，系统才会把它们与开启状态一并提交。旁路继续用持久化文本观察替换图片块，其缓存身份同时包含提供方、模型、附件与问题。

用户填写的 Key 只写入应用自有引用：`DSH_VISION_BAILIAN_API_KEY` 与 `DSH_VISION_OPENROUTER_API_KEY`。现有环境变量 `DASHSCOPE_API_KEY` 与 `OPENROUTER_API_KEY` 只作为只读后备来源。当两者同时存在时，应用自有值优先，因此界面可以替换启动时提供的后备 Key，而不会尝试修改启动环境。状态响应只暴露每个提供方能否解析到凭证，绝不返回凭证值。

OpenRouter 图片分析通过其 Chat Completions 端点发送一条同时包含文字与 Base64 `image_url` 的用户消息。OpenRouter 凭证继续保存在既有的仅所有者可读写本地凭证仓中，不会进入设置、浏览器存储、Session 事件、日志或源码。本决策只取代[桌面学员版个性化](2026-08-14-desktop-learner-customization.md)中“只支持百炼”的提供方与凭证部分；视觉能力继续作为有边界的旁路，不切换主要对话路线。

## Alternatives considered

**把用户填写的值写回 `DASHSCOPE_API_KEY`。** 不采用：启动环境凭证按设计为只读，修改父 Shell 既不可行，也不属于应用拥有的持久化合同。

**移除环境凭证支持。** 不采用：现有启动方式已经使用提供方标准环境变量。保留只读后备既兼容免填写配置，也能把只读发现与应用可写状态分离。

**把 OpenRouter 设为主要对话提供方。** 不采用：本功能只为既有文本对话提供图片观察。修改主要路线会改变模型选择、历史、费用和提供方语义，超出视觉设置范围。

**在弹窗中下载并维护远程模型目录。** 不采用：当前路径只需要一个经过验证的默认值和一个显式模型 id。第二套目录权威会额外引入与修复配置和启用 OpenRouter 无关的新鲜度及兼容性承诺。

## Consequences

即使 `DASHSCOPE_API_KEY` 来自启动环境，用户也能配置百炼；同时可以选择 OpenRouter，并独立保存它的 Key 与模型。切换提供方时，新的选择必须先通过真实图片验证才会生效。界面增加一个提供方选择器，并为 OpenRouter 增加可编辑模型字段；系统不承诺每个任意填写的 OpenRouter 模型都支持图片，因此不兼容的 id 会在验证阶段失败，且不会开启能力。现有环境凭证无需迁移即可继续使用，新填写的值则使用应用自有名称。
