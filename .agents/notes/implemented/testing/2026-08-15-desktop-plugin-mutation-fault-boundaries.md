# Agent Note: Desktop plugin mutation fault boundaries

Status: implemented

English | [中文](2026-08-15-desktop-plugin-mutation-fault-boundaries.zh.md)

## Problem

A recovery test that fabricates an open journal can prove snapshot replay, but it cannot prove that the real install and management executors persist the correct state on both sides of each mutation side effect. It can stay green while an executor mutates the Profile or replaces a Host without leaving enough durable evidence for restart recovery.

## Decision

`PluginOperationController` owns a constructor-only fault injector that runs after a selected journal point is durable. Production assembly does not provide it, and no renderer, bridge, environment variable, or packaged command can select a fault. Trusted install and management runners use `completeSideEffect()` to append an `after-side-effect` point without publishing a duplicate renderer phase after Host stop, Profile or package mutation, Host start, and renderer reconnect.

The recovery matrix drives the real F003 install runner and the real F004 enable, disable, update, and uninstall runner. It injects one failure per case at eleven post-snapshot points and requires byte-identical restoration of the four Profile authority files, prior target-package presence, exact prior Host/client/Skill evidence, no commit marker, and a durable `rolled-back` terminal result.

## Alternatives considered

**Keep constructing journal records directly.** Rejected because it tests the recovery consumer without proving that the mutation producers record the states recovery needs.

**Add executor-specific failure flags.** Rejected because five implementations could drift and because production options would carry test vocabulary. One controller-owned seam observes the shared durable state machine.

**Expose fault selection through the development bridge or environment.** Rejected because renderer or packaged-process access would create an unnecessary production failure capability.

## Consequences

The source-level matrix covers five actions at eleven deterministic failure points, so a future executor change fails at the exact missing boundary. The matrix performs more filesystem and Host-generation work than fabricated records, but remains keyless and isolated under temporary Profiles. Production mutations remain disabled until the separate Windows x64 packaged interruption and restart acceptance passes.
