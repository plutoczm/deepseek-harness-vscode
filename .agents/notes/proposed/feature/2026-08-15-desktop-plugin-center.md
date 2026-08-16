# Agent Note: Desktop plugin center with curated composition

Status: proposed

English | [中文](2026-08-15-desktop-plugin-center.zh.md)

## Problem

DeepSeek Harness already composes capabilities through npm packages, ordered Bundle patches, Cordis plugins, Host Loader entries, and client modules, but that extensibility is exposed as a developer mechanism rather than a Desktop product. A user must understand package-manager commands, the selected Profile, Bundle reconciliation, compatibility, and runtime inventory to add or remove a capability. The existing plugin inventory is diagnostic and read-only, and no trusted remote catalog owns reviewed metadata, featured placement, current popularity, or exact-version eligibility.

Putting a catalog page into the renderer alone would not close this gap. Installing a Bundle changes files that the running Host consumes, and the current Host must often be stopped before package mutation. A service hosted inside that Host cannot supervise its own replacement or recover a crash before the next ordinary startup. A successful HTTP request, package-manager exit, or static installed card also cannot prove that the new Host and client contribution are active.

The product therefore needs one coherent capability spanning discovery, compatibility, mutation, restart, runtime verification, recovery, installed management, and catalog operations while preserving Harness's existing plugin format and current configuration/diagnostic entry points.

## Proposal

Build a curated Plugin Center as a native Desktop capability following the confirmed [PRD](../../../../docs/PRD.md), [product-wide contracts](../../../../docs/specs/product-spec.md), [Feature Map](../../../../docs/specs/feature-map.md), and [technical architecture](../../../../docs/architecture/plugin-center.md).

The renderer will be a normal Harness client plugin contributing a Plugin Center page and Installed manager. The Electron main process will be the persistent local control plane because it survives controlled Host replacement: it owns fixed bridge methods, trusted resolution, one serialized operation, a profile lock, complete pre-mutation snapshot, packaged exact package-manager invocation, Host generation restart, renderer reconnection, runtime verification, commit, and recovery. The Host's existing Loader inventory remains runtime evidence rather than mutation authority.

A separate TypeScript Fastify/PostgreSQL Registry will own catalog metadata, reviewed immutable exact versions, moderation, featured placement, privacy-limited install outcomes, and deterministic rank snapshots. The selected Desktop Profile and lock state remain local installation truth; Loader and client-module evidence remain runtime truth. The installed view joins these authorities without creating another local marketplace database.

Ordinary V1 installation accepts only reviewed prebuilt exact package versions from fixed Registry and artifact origins. It runs no lifecycle scripts and accepts no arbitrary npm, Git, URL, path, executable, argv, environment, registry, or version-range input from the renderer. Desktop stages the repository-pinned `pnpm@11.7.0` runtime so a supported clean machine does not depend on system Node or pnpm. Permission/risk labels describe reviewed authority but do not claim process isolation; installed Harness plugins continue to execute with broad Host-level Node authority.

The implemented F002 core freezes that boundary before bridge integration. A compatibility fingerprint binds one exact action to Desktop/DSH/Node versions, platform, catalog ETag, Profile revision, installed projection, protected identities, and active-operation state. Protected package and Loader-row identities are derived from the shipped Bundle manifests and patch rows rather than maintained as a client list. Semantic ranges use the maintained `semver` implementation, while artifact verification uses the maintained `tar` parser to inspect compressed bytes, raw archive paths, package identity, Bundle declaration, denied lifecycle scripts, and `dsh.pluginCenter` expected-evidence declarations without extraction, import, or execution.

The operation is one durable state machine. It snapshots the full mutation-owned Profile closure before writing, stops Host under explicit operation ownership, mutates exact package and Bundle state, starts a new Host generation, publishes the moving loopback origin, reconnects the existing window, and verifies the version-declared Host and client evidence. Only then may it commit. Any pre-commit error or interrupted journal restores and verifies the previous composition before ordinary startup, or ends in a distinct recovery-failed state with retry and redacted diagnostic export.

After the manual marketplace, safety, transaction, recovery, management, and production Registry are complete, a final Agent-assisted acquisition Feature will let a user explicitly ask the Desktop Agent to find and install a capability. The Agent searches only the verified catalog, explains one exact candidate, and submits no package authority. A generation-authenticated closed channel lets Electron durably accept and re-resolve the exact operation before the current Agent turn and Host generation settle; Electron then owns the ordinary restart, verification, rollback, and recovery path. Recommendation-only, materially ambiguous, unsafe, or unmatched requests do not mutate the Profile.

V1 will expose one Plugin Center entry, search, featured, weekly-popular, recently-updated, exact plugin detail, compatibility/risk preflight, one-click install, and an honest Installed manager for system, catalog, and unknown local plugins. Existing plugin configuration cards and advanced Loader inventory remain reachable. Skills, team/private scopes, public self-service publication, payments, Linux mutation, arbitrary developer sources, and visual free-form Bundle ordering remain absent rather than appearing as empty placeholders.

Implementation follows the Feature Map's release order: F001 catalog discovery, F002 compatibility/risk preflight, F003 trusted installation, F005 transaction/crash recovery, F004 installed composition management, F006 production catalog operations/ranking, and finally F007 Agent-assisted plugin acquisition. F005 intentionally precedes the wider F004 mutation set even though its numeric id is later; F007 intentionally waits for every preceding authority and does not change F001's current priority.

## Ownership and invariants

| Concern | Authority | Required invariant |
|---|---|---|
| Catalog identity, eligibility, moderation, ranking | Remote Registry | Reviewed immutable exact versions; withdrawal changes eligibility, not local state |
| Installed packages, lock, active/disabled ordered Bundles | Selected Desktop Profile | No second installed-state database; every mutation is serialized and recoverable |
| Host/client activation | Current Host generation and client module discovery | `running` requires current expected evidence, not a package-manager result |
| Mutation and recovery | Electron main process | Renderer submits closed intent only; Host restart cannot destroy operation ownership |
| Agent-assisted acquisition | Agent tools for search/explanation; Electron for authorization and mutation | Agent selects only verified exact ids; Electron acknowledges a durable operation before Host replacement |
| Plugin configuration and advanced diagnostics | Existing owning client packages | Plugin Center links/composes them and does not duplicate or hide their behavior |

The fixed bridge and shared contracts use JSON-compatible values and stable reason codes. The current Host origin is generation-owned live state, and every navigation/sender check follows it. Built-in identities are visible and protected. Unknown local plugins stay visible but read-only to the marketplace. Configuration is retained by default; separately confirmed owned-data removal is confined to explicit plugin-owned relative paths and can never target sessions, workspaces, credentials, shared configuration, or undeclared files.

Featured is editorial, recent is eligible publication time, and popular is a timestamped deterministic aggregate of verified successful installs, short-term momentum, growth, freshness, and rollback/activation-failure penalty. Raw clicks, GitHub stars, operator test events, invalid/anomalous events, and sensitive local content do not contribute positive rank authority.

## Alternatives considered

**Copy the Codex Desktop marketplace UI and architecture.** The referenced open Codex repository exposes useful plugin manager, catalog, store, and app-server protocol patterns, but it does not provide the closed Desktop marketplace implementation, and Harness already has different Bundle, client-module, Profile, Loader, and Host-lifecycle contracts. The proposal adapts the product boundaries instead of pretending the codebases are interchangeable.

**Put catalog and mutation logic entirely in a Host Typert Remote.** That service would disappear during the Host restart it needs to supervise and could not recover an interrupted mutation before ordinary startup. The Host remains a read-only runtime-evidence provider while Electron owns persistence and replacement.

**Build a standalone web marketplace that shells out to `dsh plugin`.** This would duplicate Desktop theme, navigation, installed state, bridge security, and lifecycle while still depending on PATH pnpm and CLI-private reconciliation. It would not provide a trustworthy restart/reconnect/recovery loop.

**Allow arbitrary npm, Git, URL, or local path input in V1.** This expands package preparation, lifecycle-script, command, origin, reproducibility, and support risk beyond the intended learner/general-user product. Developer CLI workflows remain available outside the ordinary marketplace.

**Keep a local SQLite installed-plugin database.** Any duplicate record can diverge from the Profile manifest, lockfile, active/disabled Bundle composition, and Loader runtime. Installed state is therefore a derived projection from existing authorities.

**Treat manifest permissions as a sandbox.** Harness plugins execute in-process with broad authority. Review metadata and risk disclosure reduce supply-chain uncertainty but cannot honestly promise containment, so V1 makes no isolation claim.

**Ship Skills, team/private scopes, and public publishing alongside Plugins.** Those modes have different identity, policy, and lifecycle contracts and would delay the first complete plugin journey. They are deferred and do not appear as empty UI.

**Let the Agent search GitHub/npm and install whatever it chooses.** That would bypass reviewed exact-version authority, compatibility evidence, lifecycle-script policy, and deterministic recovery. External repositories can only become a future operator-review input; they do not grant installation authority.

**Let the Agent tool or Host own the install transaction.** The tool runs inside the Host generation that installation must replace, so it would disappear during its own operation. Electron must durably acknowledge the request before quiescence and remain the sole transaction owner.

## Acceptance criteria

- On a clean packaged macOS arm64 and Windows x64 machine without system pnpm, a user selects one compatible reviewed exact fixture, sees preflight and ordered progress, keeps the Desktop window alive through Host restart/reconnect, observes the declared Host/client capability, and sees it remain active after full relaunch.
- Incompatible, tampered, arbitrary-source, protected-component, path-traversal, lifecycle-script, and renderer-authority attempts fail before Profile mutation, with unchanged authority hashes and actionable product-language reasons.
- Every pre-commit phase of install, enable, disable, update, and uninstall has deterministic fault injection; each case either restores and verifies the prior composition or ends visibly `recovery-failed`. Killing Desktop during mutation and again during recovery still converges through startup recovery.
- Installed management shows system, catalog, disabled, failed, and unknown local states without hiding existing configuration cards or advanced runtime inventory. Enable/disable/update/uninstall persist after relaunch, and ordinary uninstall retains configuration.
- An authenticated operator can publish/review one immutable exact version, feature it, generate audited recent/popular snapshots, and withdraw it without a Desktop release. Withdrawal blocks new install but never silently mutates an existing local Profile.
- Event ingestion is idempotent and rejects unknown or sensitive fields. Featured, popular, and recent retain distinct semantics, and Registry failure leaves an explicitly stale last verified cache rather than granting unknown install authority.
- After F001–F006 pass, an explicit natural-language find-and-install request produces one explained exact reviewed candidate and one Electron operation id before Host stop; the same operation survives reconnect, verifies the real capability, and persists after relaunch. Recommendation-only, ambiguous, no-match, arbitrary-authority, stale/replay, and denied cases show a focused result with unchanged Profile hashes.
- Static UI, HTTP 200, package-manager exit, build success, or screenshots alone do not satisfy acceptance; evidence must show selection/input, trigger, progress/state change, current runtime result, and persistence or verified recovery.

## Risks

The central risk is supply-chain authority: a curated plugin still runs with broad Host-level Node access. Review, exact artifacts, digests, fixed origins, no lifecycle scripts, protected identities, and transparent risk language reduce exposure but do not eliminate malicious runtime behavior. Strong isolation would require a separate architecture proposal.

Host replacement and cross-platform package mutation are failure-prone, especially around moving origins, stale child exits, Windows loaded files, process crashes, and application updates that change compatibility. Release gating on generation tests, complete snapshots, every-phase fault injection, real runtime verification, and both packaged platforms is mandatory even if the success path appears complete earlier.

The Registry adds an operational service, PostgreSQL migrations, object storage, moderation, privacy handling, and rank-abuse pressure. V1 deliberately accepts internal operator tooling and a deterministic non-personalized rank instead of adding a public portal or recommendation system. If the Registry is unavailable, discovery may be stale but local installation/runtime truth must remain usable and honest.

Agent selection adds model and lifecycle risk: the model may prefer an unsuitable candidate, infer authorization from a recommendation request, leak local context through search, or lose its tool result when Host restarts. F007 therefore stays last, uses deterministic keyless behavior snapshots and real Desktop acceptance, limits Registry queries, asks focused confirmation for material ambiguity, and makes Electron persist and acknowledge the exact operation before the Agent turn settles.

The documents freeze an architecture-audit baseline rather than promising upstream APIs will not change. Before implementation changes a pinned DeepSeek Harness/Codex-derived seam, the developer must refresh that narrow source audit and update the governing contract instead of adding a compatibility layer by assumption.
