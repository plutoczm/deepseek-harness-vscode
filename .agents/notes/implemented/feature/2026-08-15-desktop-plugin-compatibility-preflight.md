# Agent Note: Desktop plugin compatibility preflight

Status: implemented

English | [中文](2026-08-15-desktop-plugin-compatibility-preflight.zh.md)

## Problem

Catalog discovery identifies a reviewed exact version but does not establish whether one action is safe for the current application, runtime, platform, Profile composition, or catalog revision. Letting the renderer supply package identity, artifact evidence, environment facts, or policy would turn presentation input into installation authority. Reusing a decision after the catalog or Profile changes would have the same defect. Compatibility also needs a visible negative result without granting F002 permission to download, mutate the Profile, or restart the Host.

## Decision

**One compatibility decision belongs to one exact Desktop-owned fingerprint and one renderer intent.** The renderer sends only `pluginId`, exact `version`, and a closed `action`. The fixed preload method forwards that value through the existing current-window and origin check. Desktop resolves the exact trusted catalog preflight, rebuilds current Desktop/DSH/Node/platform/catalog-freshness/Profile/protected-identity facts for every request, and returns an ordered `CompatibilityDecision`. Unknown fields, ranges in the exact-version seat, package names, URLs, paths, artifact evidence, environment facts, and policy values fail at the bridge contract.

**The catalog stores private preflight authority beside renderer-safe detail.** Every decoded snapshot contains one exact `CatalogVersionPreflight` for every exact detail. Snapshot decoding requires their ETag, review, eligibility, withdrawal, risk, capabilities, and expected runtime evidence to agree. List and detail projections never return package identity, semantic-version ranges, artifact URLs, digests, conflicts, or supported-action policy; `CatalogRepository.resolvePreflight()` is the Desktop-only lookup.

**The selected Profile projection is rebuilt from durable files without assigning catalog identity to unknown Bundles.** Desktop reads the Profile manifest, user patch, lockfile, dependency Bundle manifests, and Bundle patches; it derives enabled order and Loader ids and hashes every consumed authority file into `profileRevision`. An installed package maps to a plugin id only when its package name and exact version match one trusted catalog preflight. Unknown local Bundles retain `pluginId: null`, so package identity cannot impersonate catalog review. Protected package and Loader identities come from the shipped Bundle composition instead of a client-maintained allowlist.

**Denial is a normal read-only product result.** Catalog review, withdrawal, freshness, release ranges, platform artifacts, evidence completeness, protected identities, installed collisions, declared conflicts, current operation state, and action state produce stable ordered reasons. The client renders allowed and denied states, current fingerprint facts, restart expectation, capabilities, risk, and the broad-application-authority warning. Install is visible for orientation but remains disabled; F002 has no mutation bridge.

**Artifact verification is non-executing and remains behind Desktop authority.** The verifier consumes trusted exact-version evidence and archive bytes supplied by later controlled download code. It bounds compressed and expanded content, verifies digests and identity, rejects unsafe paths and links, denies lifecycle scripts, and checks Bundle and runtime-evidence declarations without importing or executing plugin code. Its result contains reasons and observed identity only, never archive bytes or local paths.

**Browser development uses deterministic decisions, not local authority.** `dev:desktop:web` reuses the production client components and supplies allowed, stale, explicit-denial, empty, and error scenarios. It does not read the user's Profile or gain Electron, filesystem, package-manager, MCP, or Host-restart access.

## Alternatives considered

**Accept environment or artifact fields from the renderer.** Rejected because a compromised renderer could select the evidence against which its own request is approved.

**Use the F001 compatibility summary as the action decision.** Rejected because a discovery summary is not scoped to an action, current Profile revision, protected composition, catalog freshness, or installed conflicts.

**Cache one allowed decision for a later transaction.** Rejected because catalog ETag, Profile files, running versions, operation ownership, or selected action can change. The later transaction must resolve the exact version and recompute against current facts.

**Expose a working Install button while recovery is incomplete.** Rejected because an allowed compatibility decision is not a package transaction, activation proof, or rollback guarantee. The disabled state communicates the result without advertising an unimplemented lifecycle.

**Give the browser development bridge access to the real Profile.** Rejected because the Web lane exists for fast UI and state acceptance; system authority belongs to Electron and requires separate Desktop acceptance.

## Verification

Contract and Desktop tests cover strict catalog/preflight pairing, exact renderer intent, current release and protected identities, semantic-version and action matrices, unknown local Bundle projection, stale-catalog denial, archive safety, and bridge ownership. The keyless preflight integration suite runs 17 metadata denials and 15 artifact denials against a temporary Profile and proves identical pre/post hashes for the Profile manifest, lockfile, Bundle order, Host generation, and installed projection. Client tests and built-bundle replay cover allowed, ordered-denial, failure, broad-authority, disabled-action, return, stale-cache, session, and retained Settings journeys. Focused types and bundles pass; this implementation pass does not build Electron or produce a Desktop package.

## Consequences

F002 provides a visible compatibility and risk result without creating another installation owner or changing local state. F003 can consume the same exact-version catalog lookup, fresh fingerprint, reason vocabulary, and artifact verifier, but must recompute before mutation and remains responsible for controlled download and transaction mechanics. F004 reuses the action semantics for installed-state operations, and F005 remains the condition for making those operations reachable. The cost is an intentionally disabled Install control and separate Desktop acceptance for preload, packaged manifest paths, and real current-Profile facts.
