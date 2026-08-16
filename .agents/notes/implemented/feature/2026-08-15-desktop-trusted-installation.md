# Agent Note: Desktop trusted installation

Status: implemented

English | [中文](2026-08-15-desktop-trusted-installation.zh.md)

## Problem

A catalog result is not installation authority by itself. Desktop must convert one exact validated version into a serialized Profile mutation, replace the loopback Host without closing the window, and distinguish readiness from actual activation. Renderer reloads must observe the same operation, while package name, archive URL, executable, registry, arguments, environment, and runtime evidence remain Desktop-owned.

F003 implements the successful transaction and its durable recovery foundation. F005 later closed rollback and interrupted-operation recovery over the same journal and snapshots; production mutation is now exposed through that controller.

## Decision

**One controller owns one ordered durable operation.** The controller decodes `{ pluginId, version, idempotencyKey }`, joins a repeated key, rejects a different concurrent request as busy, and atomically publishes immutable phases. Before mutation it records the current compatibility fingerprint and a private snapshot of the Profile manifest, lockfile, patch, module metadata, and target-package existence.

**Desktop reconstructs all mutation authority.** It resolves the exact validated catalog candidate, downloads only its fixed artifact with bounded size and redirects disabled, verifies digest, archive safety, package identity, Bundle declaration, evidence declaration, and absence of install lifecycle scripts, then invokes staged `pnpm@11.7.0` with fixed no-shell arguments, a scrubbed environment, fixed store and registry, scripts disabled, and the operation-owned archive path.

**Commit follows joined runtime evidence.** The transaction reconciles Bundle membership through `@deepseek-ai/dsh-app-boot`, validates the installed exact package and Profile projection, replaces the supervised Host generation, reloads the existing window at the new origin, verifies loopback health, and requires every declared Loader entry, client module, and Skill id. Only then does it publish `committed`.

**The renderer observes; it does not infer success.** Electron exposes fixed install/get/event methods. A compact catalog-row action first reruns compatibility for the exact version; an allowed result opens the same explicit broad-authority acknowledgement used by detail, while a denial or check failure opens exact-version detail with the reason visible. Only confirmation sends the fixed install intent. The page subscribes and calls `getOperation()` so a remount or Host reconnect resumes the durable state, while implementation phases are grouped into four stable user-facing progress steps. The Web development bridge replays the same phases through session storage without filesystem or process authority. Production preload now exposes the same recovery-backed controller with `mutationsEnabled=true`.

## Alternatives considered

**Let the renderer pass an npm target or archive path.** Rejected because it would turn display metadata into package, network, and process authority.

**Treat a ready replacement Host as installation success.** Rejected because the Bundle can load incompletely: Host entries, client contributions, or Skills may still be absent.

**Run a system `pnpm` from PATH.** Rejected because installed applications must work on a clean machine and cannot trust ambient executable or configuration resolution.

**Enable the action after the success path passes.** Rejected because a failed or interrupted mutation still needs verified rollback before users can safely reach it.

## Verification

Focused tests cover operation ownership and journal hydration, Profile locking and snapshots, exact package-manager invocation on macOS and Windows paths, real reviewed archives, a real Host-plus-client fixture and Skill fixture, ordered transaction phases through a replacement Host generation, runtime evidence before commit, catalog-row exact preflight and denial routing, explicit trust confirmation, grouped client progress and remount hydration, and installation with a PATH containing no system Node or pnpm followed by a fresh Profile read. Desktop and client source type checks pass.

Independent directory-package acceptance then repaired and verified defects visible only against the real Host/package boundary: Desktop directly owns the four actual `dsh-app-boot` runtime peers so they enter `app.asar`; the runtime verifier sends `payload: { args: {} }` as required by the Typert Remote contract; and, when no transaction needs recovery, Desktop initializes the shipped Web Profile before reading its compatibility fingerprint so an empty `DSH_HOME` can launch. The latest macOS arm64 directory package searched npm for `dsh-latex-tools@0.1.2` with no system Node or pnpm in PATH, left the operation journal unchanged until explicit user confirmation, then installed it, replaced the Host, and observed active Loader and client evidence. Uninstall from the row menu removed the installed projection only after the next Host committed. This round produced an unsigned directory package, not a formal release installer.

## Consequences

Install, disable, enable, exact update, and uninstall now reuse one installed identity, operation vocabulary, journal, Profile snapshot, fixed package-manager boundary, Host restart path, runtime verifier, and recovery controller. The public npm index remains a community distribution source, so technical validation does not imply DeepSeek code review.
