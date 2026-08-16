# Agent Note: Stage cross-platform desktop preview releases

Status: implemented

English | [中文](2026-08-16-staged-desktop-preview-release.zh.md)

## Problem

Development previews need a macOS package that can be reviewed immediately and a Windows package built on a native Windows runner. The signed desktop release workflow requires both platform-signing environments and publishes only after both jobs finish, so it cannot represent a deliberately unsigned preview that starts from an already accepted macOS application payload.

## Decision

A preview uses an immutable `desktop-preview-v<version>` tag and a new prerelease. The macOS arm64 ZIP is built locally from that tag and uploaded first. The dispatch-only Windows preview workflow checks out the same tag, validates the release name, asset name, and accepted `app.asar` SHA-256, then downloads that exact macOS ZIP.

The Windows runner extracts the accepted platform-neutral application payload, stages its Host and desktop resources, builds an unsigned Windows x64 Electron shell and NSIS installer, and restores the byte-exact accepted `app.asar`. It silently installs the result, observes the packaged Host, and silently uninstalls it. Only after those checks pass does the workflow retain an Actions artifact and attach the installer, optional blockmap, checksum, and verification receipt to the existing prerelease. Existing release assets are never overwritten. The signed `desktop-v<version>` workflow remains the formal release path.

## Alternatives considered

**Use the signed release workflow for every preview.** This blocks ordinary preview delivery on Apple notarization and Windows Authenticode secrets and delays macOS review until both platform jobs finish.

**Build Windows independently from the current default branch.** The resulting platforms could contain different application code when the branch moves after the macOS package was accepted.

**Attach the Windows installer without a native smoke test.** A successful package command does not prove that the installer, packaged Host startup, and uninstaller work on Windows.

## Consequences

Reviewers can receive the macOS preview before the Windows runner finishes while both platforms retain the same application payload. Windows preview publication is conditional on native install, Host-start, and uninstall evidence. These preview packages remain unsigned development artifacts; signed public releases still require the formal release workflow and its signing environments.
