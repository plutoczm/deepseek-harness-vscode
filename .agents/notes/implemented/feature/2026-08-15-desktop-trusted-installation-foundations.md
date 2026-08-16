# Agent Note: Desktop trusted-installation foundations

Status: implemented

English | [中文](2026-08-15-desktop-trusted-installation-foundations.zh.md)

## Problem

F003 needs to replace the Desktop Web Host during an accepted plugin mutation without closing the application, losing the new origin, or letting a late event from the old child invalidate the replacement. The existing supervisor owned only one start and one permanent shutdown. At the same time, `dsh plugin` privately mutated `dsh.profile.bundles`; copying that behavior into Desktop would create two owners for Profile composition semantics before the trusted transaction exists.

These primitives did not make installation reachable from the renderer by themselves. The complete transaction is recorded in [Desktop trusted installation](2026-08-15-desktop-trusted-installation.md), and the later recovery controller now protects the enabled production mutation path.

## Decision

**The Desktop Host supervisor owns explicit generations.** Each spawned child receives a monotonically increasing id and privately owns its readiness settlement, exit settlement, bounded startup output, origin, and stop owner. `start()` preserves the existing `Promise<string>` contract and joins the active start. `current` exposes only a ready `{ id, origin }`. `restart(reason)` serializes replacement operations, marks the old stop as operation-owned before signaling it, waits for that exact child to exit with the existing TERM-to-KILL escalation, then returns the ready replacement generation. `shutdown()` closes the supervisor permanently and owns the final stop.

**Only the current generation may publish an unexpected exit.** Every exit callback compares its captured generation object with the active object before clearing state or notifying the application. A restart-owned or shutdown-owned exit is expected, and a repeated or delayed event from an older child cannot affect a newer generation.

**Profile Bundle reconciliation has one shared pure owner.** `@deepseek-ai/dsh-app-boot` exports `reconcileProfileBundles(before, after, exportsBundle)`. It inspects each current dependency once through the caller-supplied function, appends Bundle dependencies in manifest order, removes only entries that were dependency-managed and no longer export a Bundle, preserves template and other user-managed Bundles, and reports newly added plain dependencies. It does not mutate either input and returns the original `after` manifest when no Bundle transition is required.

**Callers retain platform policy.** The CLI resolves installed packages, emits orientation warnings, and writes the changed manifest. The Desktop trusted transaction supplies its own reviewed package inspection and persistence boundary while consuming the same transition. The shared package does not run pnpm, resolve renderer input, or gain filesystem mutation authority.

## Alternatives considered

**Reuse one mutable child slot across restarts.** Rejected because old exit listeners could clear or terminate state belonging to the replacement and concurrent restarts would not have deterministic ownership.

**Duplicate the CLI reconciliation loop in Desktop.** Rejected because add, update, and remove behavior could drift between entry points, especially for a dependency whose installed version gains or loses `dsh.bundle`.

**Move package resolution and manifest persistence into the shared helper.** Rejected because CLI and packaged Desktop have different package-authority, runtime, and transaction boundaries. The shared owner is the deterministic state transition, not the surrounding I/O policy.

**Connect restart to `main.ts` or expose install in this foundation Task.** Rejected at that stage because the shared bridge and moving-origin sender policy remained owned by the F002/F003 integration window, and public mutation still awaited F005 recovery acceptance.

## Verification

`apps/desktop/tests/host-supervisor.spec.ts` covers shared start, generation identity, two serialized restarts, restart-owned exit, a stale repeated exit, readiness conflicts, startup timeout, TERM-to-KILL shutdown escalation, unexpected current exit, and permanent shutdown. `packages/boot/app-boot/tests/profile.spec.ts` covers ordered add, template retention, dependency-managed removal, plain dependencies, unchanged identity, and input immutability. `apps/cli/tests/plugin.spec.ts` proves the CLI consumes the shared result for package inspection, warning, and persistence. Focused Desktop, app-boot, and CLI type checks pass; no root build or Desktop package was run.

## Consequences

These interfaces underpin the transaction: window navigation and IPC ownership read `supervisor.current`, operation-owned restarts do not appear as application failures, and Desktop and CLI share Bundle reconciliation. Production mutation now uses the completed recovery-backed controller.
