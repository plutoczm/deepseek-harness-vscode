# Agent Note: 分阶段发布跨平台桌面预览版

Status: implemented

[English](2026-08-16-staged-desktop-preview-release.md) | 中文

## Problem

开发预览版需要先提供可立即评审的 macOS 包，再由原生 Windows runner 构建 Windows 包。签名桌面发布工作流依赖两个平台的签名环境，并且只在两个任务都完成后发布，因此无法表达从已验收 macOS 应用载荷开始、明确不签名的预览发布流程。

## Decision

预览版使用不可变的 `desktop-preview-v<version>` 标签和全新的预发布 Release。macOS arm64 ZIP 从该标签对应的代码在本地构建并优先上传。仅支持手动触发的 Windows 预览工作流检出同一个标签，验证 Release 名称、附件名称和已验收 `app.asar` 的 SHA-256，然后下载该 macOS ZIP。

Windows runner 会提取已验收的跨平台应用载荷，暂存其中的 Host 与桌面资源，构建未签名的 Windows x64 Electron 外壳和 NSIS 安装程序，并恢复字节完全一致的 `app.asar`。随后，它会静默安装产物、确认打包 Host 已启动，再执行静默卸载。只有这些检查全部通过后，工作流才会保留 Actions artifact，并将安装程序、可选 blockmap、校验和与验证回执附加到已有预发布 Release。工作流不会覆盖任何现有 Release 附件。签名 `desktop-v<version>` 工作流继续作为正式发布路径。

## Alternatives considered

**每次预览都使用签名发布工作流。** 普通预览会被 Apple 公证和 Windows Authenticode 密钥阻塞，而且 macOS 评审必须等待两个平台任务都完成。

**基于持续变化的默认分支独立构建 Windows。** 若 macOS 包验收后默认分支继续变化，两个平台可能包含不同的应用代码。

**不做原生冒烟测试就附加 Windows 安装程序。** 打包命令成功无法证明安装程序、打包 Host 启动和卸载程序能在 Windows 上正常工作。

## Consequences

评审者可以在 Windows runner 完成前先取得 macOS 预览包，同时两个平台仍使用相同的应用载荷。Windows 预览版只有在取得原生安装、Host 启动与卸载证据后才会发布。这些预览包仍是未签名的开发产物；签名公开发布仍必须使用正式发布工作流及其签名环境。
