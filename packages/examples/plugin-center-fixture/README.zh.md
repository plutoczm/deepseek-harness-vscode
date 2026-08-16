# @deepseek-ai/dsh-plugin-center-fixture

[English](README.md) | 中文

Desktop 插件中心可信安装链路的受审查开发测试包。其 Bundle patch 添加 `fixture.workspace-tools` Host 条目；同一个包还声明浏览器 client half（客户端半部），提供可见的“工作区工具”页面。生产功能不得依赖此测试包。

## 模型体验

无，因为该测试包只提供产品 UI 和 Host 激活证据。

#### KV Cache 影响

无。

## 已知限制与延后工作

- **仅用于开发证据** — 该包只用于确定性的 F003 测试，不作为生产插件或面向用户的工作区工具提供支持。
