# Agent Note: Localized composer permission and DeepSeek controls

Status: implemented

English | [中文](2026-08-15-localized-composer-controls.zh.md)

## Problem

The Chinese composer still displayed the built-in permission presets as `Read Only`, `Workspace Write`, and `Full access`. Its model control also displayed DeepSeek's adapter values as a generic `Effort: High` choice. That presentation made a localized product look incomplete and could be mistaken for a Codex-style speed control even though the Harness DeepSeek adapter exposes thinking choices, not speed.

## Decision

**Built-in permission labels belong to locale dictionaries.** The composer chip, the current-session `/permission` picker, and the General-settings default picker render `read-only`, `workspace-write`, and `danger-full-access` through their owning locale namespace. The Chinese labels are `只读`, `工作区写入`, and `完全访问`; English keeps its existing product copy. Host-configured names outside those three ids pass through unchanged. Command lines, projection values, settings values, and the full-access risk gate continue to use the existing machine ids.

**DeepSeek reasoning metadata is presented as thinking mode.** When the selected provider is DeepSeek, the composer calls the reasoning row `Thinking mode` and localizes the adapter's `off`, `high`, and `max` ids as Thinking off, Deep thinking, and Maximum thinking. Chinese uses `思考模式` with `关闭思考`, `深度思考`, and `最大思考`. Adapter-supplied descriptions still win; otherwise the client supplies concise DeepSeek explanations. Other providers retain their adapter-owned effort names and the generic reasoning label.

**The composer exposes only request-scoped settings already owned by the adapter.** Selecting a DeepSeek thinking option still submits the existing `reasoningEffort` field through `session.selectModel`. Endpoint, credential, context-capacity, output-cap, timeout, retry, and catalog configuration stay in the existing DeepSeek settings surface; no synthetic speed value or new wire field is introduced.

**The control geometry follows the established side-menu interaction.** The Model and Thinking mode rows remain visible while hover, keyboard focus, or click opens the matching card on their right. An invisible pointer bridge fills the eight-pixel visual gutter and a 240 ms leave grace period keeps the side card mounted while the pointer crosses; entering either card cancels the pending close. The permission card adds a DeepSeek Harness heading, concise consequences, a trailing selection check, and warning emphasis for Full access. These presentation changes reuse the existing selection commands and Full-access confirmation gate.

## Alternatives considered

**Remove the reasoning row for DeepSeek.** Rejected because the shipped DeepSeek adapter explicitly advertises `off`, `high`, and `max`, and removing the row would hide a real per-request capability.

**Add a speed selector modeled after another coding client.** Rejected because DeepSeek Harness has no speed contract to read or submit. A presentation-only selector would claim behavior the provider path cannot honor.

**Translate every host-supplied permission or effort name.** Rejected because deployments may define custom values whose labels are authoritative data. Localization is limited to the built-in permission ids and the DeepSeek ids whose semantics this repository owns.

## Consequences

Chinese desktop sessions now show a complete Chinese permission menu and a DeepSeek-specific hover-side thinking menu without changing durable state or backend protocols. The side card remains selectable at normal pointer speed and model A → B → A switching follows the same stable path. English behavior and custom provider labels remain available, and generic model providers continue to render their own metadata. The visible controls gain focused component and browser coverage, while the implementation accepts the small duplicated locale vocabulary required by the client-package isolation rules.
