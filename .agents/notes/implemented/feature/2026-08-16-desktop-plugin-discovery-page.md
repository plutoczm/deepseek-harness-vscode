# Agent Note: Desktop Plugin Discovery page

Status: implemented

English | [中文](2026-08-16-desktop-plugin-discovery-page.zh.md)

## Problem

Plugin Center combines catalog browsing with installed-package management, compatibility explanations, recovery notices, and lifecycle actions. As the public catalog grows, users need a faster way to scan current recommendations and recent additions without making the management page denser or weakening its operational responsibilities.

## Decision

The Desktop client registers `plugin-discovery` immediately after `plugin-center` in `sidebar.primary.action` and gives it an independent keyed `main.page`. Plugin Discovery consumes the existing public Plugin catalog and installed projection through the same Desktop bridge; it introduces no package source, catalog authority, or mutation path.

The overview preserves the catalog's server-owned Featured, Popular, and Recent ordering. It presents one Featured card, a compact Popular ranking, Recently updated cards, search, and only the capability categories that match returned reviewed metadata. The client does not calculate a popularity score, relabel Recent as a guaranteed same-day release, or display growth figures without an auditable catalog field.

The same page provides “Let Agent find plugins” as a subfeature instead of adding a third top-level entry. Submitting a natural-language requirement deterministically invokes the standard preset's bundled `find-plugins` Skill in the current session. The Skill is user-invocable only, so it does not publish a resident Skill catalog into every ordinary turn. It uses a bounded read-only script to search the public npm `dsh-plugin` catalog, retains exact versions declaring a Bundle patch and immutable distribution evidence, and requires the Agent to recommend at most five items using only returned metadata. When DeepSeek credentials are absent, the client opens the existing Models settings and sends no conversation request. Recommendations return only to the current chat and do not bypass Plugin Center installation authority.

The client contribution explicitly injects the Conversation service and resolves its session-scoped face with `sessions.scope(sessionId).get('conversation')` before sending. It does not rely on an undeclared context shortcut, so the packaged Cordis runtime and the test harness exercise the same service path.

Opening an entry keeps the discovery position and reveals a right-side exact-version panel. The panel reads the existing detail and compatibility decisions, while Install uses the existing compatibility check, explicit broad-authority acknowledgement, immutable plugin id and version intent, and operation progress dialog. An installed entry opens Plugin Center for management instead of duplicating enable, disable, update, or uninstall controls.

## Interaction ownership

Plugin Discovery owns search text, the Agent-finder requirement, selected view, capability category, selected detail, and local panel focus. The Agent session owns natural-language interpretation and recommendation prose, while the public npm catalog owns candidate metadata. The Desktop catalog owns installable membership and order, the compatibility bridge owns installation eligibility, the operation bridge owns progress, and Plugin Center remains the only installed-composition manager.

## Alternatives considered

**Expand Plugin Center with another section.** This keeps one entry but makes discovery compete with installed state, recovery, configuration, and lifecycle actions in an already dense page.

**Show client-computed growth and download metrics.** The current summary does not carry auditable time-series evidence, so derived or decorative figures would misrepresent catalog facts.

**Copy a public navigation-site landing page.** Large marketing heroes and category grids use desktop space poorly and break the existing Harness navigation and card density.

**Add another top-level page for Agent finding.** The task remains part of plugin discovery; a separate page would duplicate catalog context and force users to choose between two near-synonymous discovery entries.

**Let the Agent install a recommendation directly.** Recommendations derive from untrusted public metadata and cannot replace exact-version compatibility checks, authority acknowledgement, and the existing trusted mutation path.

**Advertise the finder Skill in every Agent turn.** That would add a Skill catalog and context record to ordinary conversations that never use this feature. The explicit product action is already a deterministic entry, so resident prompt cost is unnecessary.

## Consequences

Users can browse the catalog or describe one need to let the Agent narrow the candidates, while every install still passes the trusted Desktop path. The trade-off is one model turn and one public-catalog query for each explicit Agent search; when no candidate satisfies the installable metadata contract, the Agent must report no result. The page can expose only the ranking meanings and categories supported by current catalog metadata; a future growth view requires a catalog contract change and backend evidence before the UI adds it.
