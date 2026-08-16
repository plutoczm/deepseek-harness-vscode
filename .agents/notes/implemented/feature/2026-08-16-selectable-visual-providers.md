# Agent Note: Selectable visual providers

Status: implemented

English | [中文](2026-08-16-selectable-visual-providers.zh.md)

## Problem

The Desktop visual sidecar originally bound configuration, credential storage, and image requests to Bailian. Its writable credential reference was also `DASHSCOPE_API_KEY`, but a value supplied by the launching shell is intentionally read-only in the local credential provider. Entering a replacement key in the UI therefore attempted to shadow an ambient value and failed instead of completing verification. Learners also need an OpenRouter route without replacing the primary DeepSeek conversation model.

## Decision

The visual-enhancement dialog selects either Bailian or OpenRouter before it verifies a real image. Bailian remains fixed to `qwen3.8-max`; OpenRouter defaults to `openai/gpt-4.1-mini` and accepts another non-empty vision-capable model id. Provider and model are committed with the enabled setting only after that exact selection completes verification. The sidecar continues to replace image blocks with durable text observations, and its cache identity includes provider, model, attachment, and question.

User-entered keys are written only to application-owned references: `DSH_VISION_BAILIAN_API_KEY` and `DSH_VISION_OPENROUTER_API_KEY`. Existing ambient `DASHSCOPE_API_KEY` and `OPENROUTER_API_KEY` values remain read-only fallback sources. An application-owned value wins when both exist, so the UI can replace a launch-time fallback without attempting to mutate the launching environment. Status responses expose only whether each provider can resolve a credential, never its value.

OpenRouter image analysis uses its Chat Completions endpoint with one user message containing text and a Base64 `image_url`. The OpenRouter credential stays in the existing owner-only local credential store and never enters settings, browser storage, session events, logs, or source files. This decision supersedes only the Bailian-only provider and credential portions of [Desktop learner customization](2026-08-14-desktop-learner-customization.md); the visual capability remains a bounded sidecar and does not switch the primary conversation route.

## Alternatives considered

**Write the user-entered value back to `DASHSCOPE_API_KEY`.** Rejected because launch-environment credentials are intentionally read-only and mutating the parent shell is neither possible nor an application-owned persistence contract.

**Remove ambient credential support.** Rejected because existing launches already provide provider-standard environment variables. Keeping them as fallback preserves keyless setup while separating read-only discovery from writable application state.

**Make OpenRouter the primary conversation provider.** Rejected because this feature only supplies image observations to the existing text conversation. Changing the primary route would alter model selection, history, cost, and provider semantics outside the visual setting.

**Download and maintain a remote model catalog in the dialog.** Rejected because the requested path needs one verified default plus an explicit model id. A second catalog authority would add freshness and compatibility claims unrelated to fixing configuration and enabling OpenRouter.

## Consequences

Users can configure Bailian even when `DASHSCOPE_API_KEY` came from the launching environment, and can select OpenRouter with an independently stored key and model. Switching providers requires a successful real-image check before the new selection becomes active. The UI adds one provider selector and, for OpenRouter, an editable model field; it does not promise that every arbitrary OpenRouter model accepts images, so an incompatible id fails during verification without enabling the capability. Existing ambient credentials continue to work without migration, while newly entered values use the application-owned names.
