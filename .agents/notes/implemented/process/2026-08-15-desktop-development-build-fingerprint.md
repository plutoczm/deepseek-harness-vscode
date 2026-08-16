# Agent Note: Reuse verified desktop development builds

Status: implemented

English | [中文](2026-08-15-desktop-development-build-fingerprint.zh.md)

## Problem

`pnpm run dev:desktop` previously rebuilt the complete workspace before every Electron launch. That guaranteed fresh Host, Client, Web, and Electron outputs, but imposed the same full-build wait when no relevant input had changed. Starting Electron directly was faster but could silently combine stale outputs from different workspace faces.

## Decision

The desktop development launcher computes a SHA-256 fingerprint over relevant source, manifest, lock, and build-configuration files plus the Node platform, architecture, version, and selected build environment. It excludes generated outputs, tests, and documentation. The launcher reuses a build only when the fingerprint matches its ignored state record and the Desktop main, preload, CLI, and Web entry outputs all exist.

The state record lives under `apps/desktop/lib/`, so ordinary cleaning removes it. Before any required or forced rebuild, the launcher removes the old record. It writes a replacement atomically only after the complete root-workspace build succeeds, every required output exists, and the inputs remain stable. If inputs move during the first build, it rebuilds once against the new snapshot; a second movement stops without recording reusable state. `pnpm run dev:desktop:rebuild` provides an explicit recovery and diagnostic path. Packaging and distribution commands continue to run the complete workspace build unconditionally.

## Alternatives considered

**Launch Electron directly without checking freshness.** This shortens every restart but can run stale Host, Client, Web, preload, or main-process code without warning.

**Build only the Electron package.** The desktop main process launches the CLI Host and serves the Web output, so rebuilding only `apps/desktop` does not keep the complete product path current.

**Compare modification times.** Preserved archive timestamps, clock resolution, and copied files can make timestamps disagree with content. A content fingerprint gives deterministic invalidation across those cases.

## Consequences

An unchanged desktop restart pays for one bounded content scan and then launches Electron without compiling the workspace. Relevant changes still perform the existing complete build, so this change does not introduce a partial-build dependency model or a Host hot-reload promise. The state file is disposable and never authoritative without the required outputs. Developers can force a clean freshness decision without changing packaging behavior.
