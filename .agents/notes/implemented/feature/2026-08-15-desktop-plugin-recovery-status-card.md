# Agent Note: Desktop plugin recovery status card

Status: implemented

English | [中文](2026-08-15-desktop-plugin-recovery-status-card.zh.md)

## Problem

F005 exposes a closed recovery state with stable machine reason codes, retry authority, and diagnostic-export authority. A compact banner that shows only the raw code is difficult to understand, while a generic error message hides the evidence needed for support. The browser fixture must present the same renderer contract without implying that it owns Profile or process changes.

## Decision

The Plugin Center renders every non-rolled-back recovery snapshot as one status card above the read-only catalog. Recovery progress and recovery failure use distinct titles, icons, semantic colors, and live-region priority. The card translates every closed `PluginRecoveryReasonCode` into a user-readable explanation while retaining the stable code and attempt number as secondary evidence.

Retry recovery remains the primary action and diagnostic export remains secondary. Both buttons consume the existing `operationId`-only intents, follow the bridge capability flags, and disable together while either request is active. A `rolled-back` response removes the card; the renderer never infers success from a button click. The layout collapses to two columns on narrow windows and disables spinner animation when reduced motion is requested.

## Alternatives considered

**Show only the raw recovery code in a red banner.** Rejected because users cannot distinguish an integrity failure, Profile ownership conflict, Host failure, or runtime verification failure without consulting source code.

**Open recovery failure as a modal inside the Plugin Center.** Rejected because catalog inspection remains safe while mutations are closed, and a blocking modal would duplicate the independent startup recovery page owned by Desktop.

**Copy the standalone recovery page styling into the Web client.** Rejected because the standalone page must work before the normal Host starts, while the Plugin Center must use the shared Web semantic tokens and primitives.

## Verification

Component tests cover readable failure evidence, stable reason code, attempt count, diagnostic feedback, same-operation retry, removal after `rolled-back`, and the disabled recovering state. `pluginCenterRecovery=failed` remains the browser acceptance entry and performs no Profile or file mutation.

## Consequences

Recovery failure is understandable without losing support evidence, and the Web fixture stays honest about its lack of system authority. Production mutation is enabled, but an unresolved recovery failure blocks another operation until retry succeeds.
