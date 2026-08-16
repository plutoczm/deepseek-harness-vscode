# Agent Note: GitHub Topic plugin candidate ingestion

Status: proposed

English | [中文](2026-08-15-github-topic-plugin-candidate-ingestion.zh.md)

## Problem

DeepSeek Harness recommends the GitHub `dsh-plugin` Topic as a discovery mechanism, but a Topic match proves only that a repository selected a label. It does not prove that the repository contains an installable Harness Bundle, that a package version is immutable, that its code was reviewed, or that it is eligible for installation. The public upstream documentation reviewed on 2026-08-15 describes no separate official submission, moderation, or verified-marketplace intake process.

The [DeepSeek Harness Studio repository](https://github.com/fufankeji/deepseek-harness-studio) already carries `dsh-plugin` and is indexed through the [GitHub Topic](https://github.com/topics/dsh-plugin), so the application is discoverable through the channel named by the [official README](https://github.com/deepseek-ai/deepseek-harness#community-and-support). The Studio repository is nevertheless a desktop application monorepo: its [root package](../../../../package.json) and [Desktop package](../../../../apps/desktop/package.json) are private application packages and do not declare `dsh.bundle.patch`. Turning either package into a Bundle would misrepresent the distribution unit and couple application releases to plugin installation.

The Plugin Center Registry accepts reviewed, immutable, exact versions and deliberately excludes arbitrary package sources. The [Feature Map](../../../../docs/specs/feature-map.md#out-of-scope-and-deferred-items) allows external repositories to become a later operator-review input, while the [Plugin Center architecture](../../../../docs/architecture/plugin-center.md) keeps the Registry as catalog authority and the selected Profile as local installation truth. A future implementation needs a durable decision explaining how Topic discovery may feed that system without becoming installation authority.

## Proposal

Keep the Desktop repository as an application and retain `dsh-plugin` only for ecosystem discovery. Publish each genuinely installable extension as a separate npm package, Git repository, or prebuilt tarball that follows the [official Bundle publication format](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md): a non-private exact package version, packaged runtime files, `cordis.patch.yml`, and a `dsh.bundle.patch` declaration. Each plugin repository should identify its license, source repository, release artifact, and exact installation command.

When explicitly authorized as a later Feature, add a GitHub Topic candidate-source adapter upstream of the existing Registry import and moderation path. Its working planning label is `F006A`; this label does not add it to the active Feature Map or authorize implementation. The adapter will perform the following stages:

1. Read repositories carrying `dsh-plugin` into an operator-only candidate queue.
2. Locate an actual package and `dsh.bundle.patch` declaration instead of treating the repository root as a package.
3. Resolve an immutable commit, package subdirectory, exact package version, license, and prebuilt artifact.
4. Submit the artifact to the existing non-executing publication verifier and moderation workflow.
5. Mirror an approved artifact to the Registry-owned object origin and publish only the reviewed exact version.

Topic candidates never appear as installable catalog entries. The Desktop renderer receives no Git URL, arbitrary package location, commit selector, package-manager argument, or unreviewed metadata. Only the existing Registry publication path may produce a catalog version, and only its exact reviewed artifact may reach compatibility checking and installation. The current [artifact verifier](../../../../apps/desktop/src/plugin-center/artifact-verifier.ts) continues to check package identity, version, `dsh.bundle.patch`, denied lifecycle scripts, declared runtime evidence, archive paths, sizes, media origin, and artifact digests without importing or executing plugin code.

The candidate record will preserve source provenance separately from catalog identity: repository URL, immutable commit SHA, package subdirectory, discovered package name and version, license result, discovery timestamp, and last observation. These fields remain operator-side evidence and do not become renderer-controlled installation inputs. Repository descriptions, Topic membership, GitHub stars, forks, and release popularity may help triage candidates but never establish verification, ranking authority, or official endorsement.

Before implementation, refresh the official README, Bundle publication guide, CLI behavior, and GitHub Topic semantics. Upstream discovery or distribution changes replace assumptions in this proposal rather than creating a compatibility layer around stale evidence.

## Ownership and trust

| Input or state | Authority | Permitted outcome |
|---|---|---|
| GitHub Topic membership | GitHub repository owner | Create or refresh an operator candidate only |
| Source repository and commit | Candidate-source adapter | Record immutable provenance; never grant installation eligibility |
| Package and artifact inspection | Registry publication verifier | Reject or produce review evidence without execution |
| Moderation decision and exact version | Plugin Registry | Publish, withdraw, feature, or retain a reviewed catalog version |
| Installed package and Bundle composition | Selected Desktop Profile | Remain the only local installation truth |
| Runtime Host, client, and Skill evidence | Current Host generation | Confirm activation after the ordinary Desktop transaction |

## Alternatives considered

**Install every repository carrying `dsh-plugin` directly.** Topic membership is self-asserted and includes applications, source-only projects, unrelated repositories, and packages that require untrusted builds. Direct installation would bypass exact-version review, artifact integrity, compatibility, recovery, and runtime verification.

**Convert the Desktop application repository into an installable Bundle.** The application packages Electron, a Host runtime, Registry integration, and platform installers rather than one composable Harness extension. A Bundle declaration at the application root would create a false package contract and complicate both release paths.

**Run GitHub discovery and package resolution in the renderer.** This would expose URLs and package selection to an untrusted presentation process and duplicate Registry policy. Candidate discovery belongs to an authenticated operator service upstream of moderation.

**Allow arbitrary GitHub, npm, URL, or path installation alongside curated results.** This would defeat the existing fixed-origin, exact-artifact, no-lifecycle-script, and recovery model. Developer CLI installation remains separate from the ordinary Plugin Center.

## Acceptance criteria

- The implementation begins only after an explicit Feature authorization and a refreshed upstream evidence review.
- A repository selected through `dsh-plugin` can enter an operator queue but cannot appear in the installable catalog without an approved immutable exact artifact.
- The adapter distinguishes application repositories, multi-package repositories, source-only packages, missing Bundle declarations, denied lifecycle scripts, missing licenses, and unsupported artifacts without executing candidate code.
- Every published catalog version retains immutable source and artifact provenance and passes the existing Registry verification and moderation path.
- The renderer and Agent installation paths continue to submit only verified catalog identity and exact version; they never receive arbitrary source authority.
- Disabling or failing the candidate-source adapter leaves manual Registry import, catalog reads, installed management, and local Profile truth unchanged.

## Risks

The Topic is noisy and self-selected, so automated discovery can create large review queues and false positives. Rate limits, deleted repositories, force-pushed branches, monorepo layouts, changing licenses, and source-only TypeScript packages complicate resolution. Immutable commit capture, bounded refresh, explicit unsupported reasons, and operator triage limit this cost but do not eliminate it.

Mirroring and approving an artifact creates supply-chain responsibility. Static package checks cannot prove benign runtime behavior, and a reviewed Harness plugin still runs with broad Host-level Node authority. This proposal preserves the current disclosure and review model; stronger isolation requires a separate architecture decision.

Using `dsh-plugin` on the Desktop application improves ecosystem discovery but can be mistaken for proof that the application itself is an installable plugin or officially endorsed. Repository copy must describe it as a Desktop application with a Plugin Center, while separate Bundle repositories carry the installable-plugin contract.
