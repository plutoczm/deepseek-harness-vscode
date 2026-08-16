# Agent Note: Desktop installed composition management

Status: implemented

English | [中文](2026-08-15-desktop-installed-composition-management.zh.md)

## Problem

An installed package, an active Bundle, and observable runtime capability are different facts. A management page that stores its own installed database or treats package-manager success as activation would drift from the Profile and Host. Update and uninstall also cross loaded-process and destructive-data boundaries, while application updates must not let an incompatible external Bundle prevent the entire Host from starting.

## Decision

**The installed view is rebuilt from existing authorities.** Desktop joins the Profile dependency manifest, active and disabled Bundle order, exact installed package manifests, verified catalog cache, protected release identities, the current operation journal, and Host/client/Skill runtime evidence. System, catalog-owned, and unmatched local rows remain distinct. Configuration and advanced runtime inventory remain owned by Settings and are reached through navigation rather than copied.

**All supported lifecycle actions reuse one transaction owner.** Enable and disable atomically move a package between ordered `bundles` and `disabledBundles`; update replaces one reviewed exact version while preserving that intent; uninstall stops the Host before package removal and removes dependency plus both Bundle memberships. Every action uses the existing lock, snapshot, journal, Host replacement, health check, runtime transition proof, commit marker, and recovery handoff.

**Runtime continuity compares only identities that persist across Host replacement.** Loader children below `include:agent-presets:` belong to live preset instances and may be absent until a session resumes, so mutation continuity and recovery comparison exclude them. Candidate-declared Loader entries, client modules, and Skill ids remain exact requirements; the owning `agent-presets` row and every other unrelated runtime identity must remain present.

**Plugin-owned data is a second destructive decision.** Uninstall always retains configuration and data. While the exact package still exists, Desktop binds its bounded relative-path declarations to the uninstall operation. Only a matching committed uninstall plus a separate fixed confirmation may delete a selected declaration under the product-owned plugin storage root. Traversal, undeclared paths, overlapping selections, symlinks, system identities, and local identities are rejected.

**The data decision survives Host and renderer replacement.** A committed uninstall changes the dynamic Host origin and destroys the old page state, so Desktop re-projects one data offer from the current committed journal and its operation-bound authority. After the user explicitly retains data or finishes selective deletion, Desktop consumes only that offer metadata. Unselected data and configuration remain intact, and a full relaunch does not show the offer again.

**Application compatibility is reconciled before normal Host composition.** A reviewed external Bundle whose exact version conflicts with the current Desktop, DSH, Node, platform, artifact evidence, or installed composition moves to `disabledBundles` before Host start. Packages, prior disabled intent, system components, and unmatched local Bundles remain intact. The installed projection derives the same reason codes and withholds enable until compatibility returns.

Production preload exposes these actions with `mutationsEnabled=true`; the same recovery controller still closes mutation after an unresolved recovery failure.

## Alternatives considered

**Keep installed state in a Plugin Center database.** Rejected because Profile, package, journal, and runtime facts can change outside the page.

**Delete configuration or caches as part of uninstall.** Rejected because package ownership does not grant authority over user data, credentials, workspaces, or shared configuration.

**Start the Host and disable an incompatible Bundle afterward.** Rejected because the incompatible code can fail composition before the management UI exists.

**Wait for the renderer to recreate live preset instances before runtime verification.** Rejected because recovery verifies before renderer reload, and session presence is not a deterministic property of the restored Profile.

## Verification

Focused contracts and tests cover source classification, explicit disabled Profile state, retained Settings routes, exact update selection, confirmation before every action, enable/disable runtime transitions, enabled and disabled update intent, uninstall with unchanged configuration, committed-operation-bound owned-data deletion, traversal and symlink rejection, pre-Host application-update deactivation, restart persistence, restart-scoped preset-instance disappearance, and Windows package mutation only after the Host releases loaded files. Real Desktop acceptance also verifies the Host's `include:`/`module:` evidence identities, intentionally disabled system Loader rows, pnpm 11 remove arguments, and data-offer restoration after Host replacement. The related focused suites, contract generation, Desktop typecheck, the Plugin Center client Bundle, and an unsigned macOS arm64 directory package build pass.

Earlier `/tmp` package acceptance connected the management controller to an isolated Profile with no system Node or pnpm in PATH and passed real disable/enable, uninstall, Host replacement, default data retention, selective deletion, and full quit/relaunch while system and Skill Pack runtime evidence stayed healthy. Production now exposes that controller. Real cross-version update, application-upgrade deactivation, and Windows loaded-file behavior remain outside the evidence gathered on this macOS source-validation round.

## Consequences

Catalog discovery does not gain installed-state ownership. Reinstall can discover retained configuration and data, but no lifecycle action silently re-enables a Bundle that application compatibility deactivated. Runtime comparison gives up exact continuity for live preset-instance children while retaining exact target evidence and stable unrelated identities. A recovery failure closes new mutation until the existing recovery flow succeeds.
