# Agent Note: Desktop plugin catalog discovery

Status: implemented

English | [中文](2026-08-15-desktop-plugin-catalog-discovery.zh.md)

## Problem

The Desktop settings surface exposed plugin configuration and Loader inventory, but it had no product-owned discovery view. A marketplace-shaped page could not safely accept package names, URLs, or arbitrary Skill folders from the renderer because discovery metadata is untrusted input and later Features will use the same exact-version identity for compatibility, installation, activation evidence, and uninstall. The product also needed a clear answer for Skills: Skill packs packaged as DSH Bundles should be discoverable without creating a second raw-Skill installation authority.

## Decision

**Catalog discovery is a Desktop-owned boundary.** `@deepseek-ai/dsh-plugin-center-contracts` defines strict exact-field decoders for catalog summaries, details, filters, compatibility, freshness, artifacts, and declared runtime identities. Desktop searches the fixed npm registry for `dsh-plugin`, the discovery keyword documented by DeepSeek Harness, then fetches exact-version metadata and retains only packages that declare `dsh.bundle`. The main process owns HTTPS origins, response and archive bounds, immutable integrity checks, atomic authority-cache replacement, offline fallback, and IPC sender checks. The preload exposes fixed methods; the renderer cannot submit a source URL, filesystem path, package command, or executable.

**Plugins and Skill packs share one catalog identity.** A catalog item carries `catalogKind: plugin | skill-pack`, one exact package version, Bundle membership, and the identities activation checks must observe. A Skill pack is an ordinary validated DSH Bundle whose declaration includes `skill` capability and, when published, `expectedSkillIds`; raw standalone Skill folders are not marketplace items and receive no separate install path.

**Discovery is a first-level application page, while existing plugin settings stay independent.** `@deepseek-ai/dsh-client-ui-plugin-center` contributes a sidebar action through `sidebar.primary.action` and an independent keyed page through `main.page`. `ui-layout` owns the selected `primaryPage`, keeps the Conversation surface mounted, and `ui-workspace` closes that page when a user starts or opens a session. The page follows the Codex reference hierarchy with Plugins/Skills navigation, centered search and content, an installed icon strip, public/personal scopes, responsive two-column unboxed discovery rows, and breadcrumb navigation to exact-version detail in the same page. An uninstalled public entry exposes a direct install action; an installed catalog entry is resolved from the current Profile projection and exposes only its backend-supported update, enable, disable, or uninstall actions through a compact overflow menu. The expanded installed section remains available for source, runtime, compatibility, configuration, and inventory details, while existing Settings paths stay independently reachable. Install and management actions appear only through handed-off bridge contracts and reuse exact-version preflight, confirmation, and durable operation state.

**The live source is the prebuilt npm DSH Bundle ecosystem.** Search cards come from exact npm versions tagged `dsh-plugin`; the keyword is a community discovery signal, not DeepSeek endorsement. Opening or installing a result downloads the tarball and derives authority only after registry integrity, SHA-256, archive containment, package identity, Bundle patch, Loader entries, optional client module, and optional Skill declarations agree. The validated exact-version record is cached so installed plugins remain manageable offline. GitHub-only repositories and packages without `dsh.bundle` stay outside the one-click path.

**Browser development uses the full Desktop UI composition plus an explicit fixture seam, not a second production authority.** `pnpm run dev:desktop:web` (compatibility alias `dev:plugin-center`) sets `DSH_DESKTOP=1` to enable the same Desktop client UI roster and skin, enables the same Plugin page through a Host-injected marker and deterministic read-only bridge, and isolates `DSH_HOME` under project artifacts. The page root exposes a development data marker and hover explanation without adding a banner that distorts the reference UI; URL scenarios cover normal, empty, stale-cache, and failed reads. This entry cannot start real MCP, Electron IPC, filesystem, package-manager, Host-restart, or installation actions, and Desktop always prefers the preload bridge.

## Alternatives considered

**Load a public registry directly from the React client.** Rejected because it would move network policy, cache ownership, and source selection into an untrusted renderer and make later mutations depend on client-supplied authority.

**Treat any local Skill folder as a marketplace item.** Rejected because raw Skills do not carry the exact-version package, Bundle, compatibility, integrity, and runtime-evidence contract required for safe one-click lifecycle operations.

**Replace the existing plugin settings pages with the marketplace.** Rejected because configuration cards and Loader inventory serve distinct installed-state and diagnostic journeys that discovery does not own.

**Render an install control before its backend contract is handed off.** Rejected because an affordance without F002 compatibility evidence and the F003/F005 transaction and recovery path would advertise a lifecycle the product cannot verify.

## Verification

Contract tests cover malformed catalog input, exact identity, npm artifact origins, Skill-pack requirements, cache ownership, atomic replacement, and stale fallback. Desktop tests cover fixed bridge methods, sender/origin rejection, npm search filtering, exact tarball hydration, offline authority reuse, install and management transactions, and recovery. A live smoke resolves and validates `dsh-latex-tools@0.1.2`; an isolated package-manager smoke installs and removes that exact public package. Client tests retain the first-level page, search, detail, confirmation, progress, installed management, and browser-development journeys. `pnpm run dev:desktop:web` remains the UI loop, while real package mutation requires Desktop.

## Consequences

Desktop users can search the public DSH ecosystem and install, run, update, disable, enable, or uninstall validated exact npm Bundles without gaining source-selection or package-manager authority in the renderer. Compatibility, mutation, recovery, and installed projection consume one strict identity and evidence vocabulary. The trade-off is that ecosystem packages remain community code with broad process authority; validation proves immutable identity and activation declarations, not official code review.
