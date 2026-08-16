# Agent Note: 复用已验证的桌面开发构建

Status: implemented

[English](2026-08-15-desktop-development-build-fingerprint.md) | 中文

## Problem

`pnpm run dev:desktop` 过去会在每次启动 Electron 前完整构建工作区。这能保证 Host、Client、Web 与 Electron 产物为最新状态，但即使相关输入完全没有变化，也要等待同一次完整构建。直接启动 Electron 虽然更快，却可能在没有提示的情况下混用不同工作区 face 的陈旧产物。

## Decision

桌面开发启动器会对相关源码、manifest、锁文件与构建配置文件计算 SHA-256 指纹，并纳入 Node 平台、架构、版本和选定的构建环境；生成产物、测试与文档不参与计算。只有指纹与已忽略的状态记录一致，且 Desktop main、preload、CLI 和 Web 入口产物全部存在时，启动器才会复用构建。

状态记录位于 `apps/desktop/lib/`，因此常规清理会将其删除。任何必要或强制重建开始前，启动器都会先删除旧记录。只有根工作区完整构建成功、全部关键产物存在且输入保持稳定后，才会原子写入新记录。若输入在第一次构建期间发生变化，启动器会基于新快照再构建一次；若第二次仍发生变化，则停止且不记录可复用状态。`pnpm run dev:desktop:rebuild` 提供显式恢复与诊断入口。打包和发行命令继续无条件执行完整工作区构建。

## Alternatives considered

**不检查新鲜度，直接启动 Electron。** 这能缩短每次重启时间，却可能在没有提示的情况下运行陈旧的 Host、Client、Web、preload 或 main-process 代码。

**只构建 Electron 包。** 桌面 main 进程会启动 CLI Host 并提供 Web 产物，因此只重建 `apps/desktop` 无法保证完整产品链为最新状态。

**比较修改时间。** 归档保留的时间戳、时钟精度和复制文件都可能使时间戳与内容不一致。内容指纹在这些情况下提供确定性的失效判断。

## Consequences

桌面输入未变化时，每次重启只需一次有界内容扫描，随后无需编译工作区即可启动 Electron。相关内容变化时仍执行现有完整构建，因此本次改动没有引入部分构建依赖模型，也不承诺 Host 热重载。状态文件可以随时丢弃，且在关键产物缺失时不具权威性。开发者无需改变打包行为即可强制重新判断构建新鲜度。
