# @deepseek-ai/dsh-host-plugin-inventory

[English](README.md) | 中文

当前 Cordis Loader 树与组合后运行时激活证据的只读 Host 投影。`PluginInventoryGateway` 注册 `pluginInventory` 服务，并发布一个由 Typert 生成的直接 Remote：`pluginInventory/list`。每次调用都直接读取 `ctx.loader.entries()`，跳过结构性的 group 行，再按 Loader 顺序返回其余条目的 Loader id、模块标识、有效启用状态与当前根 Fiber 阶段。同一份快照还组合当前 client module（客户端模块）图 id 和全局可发现的 Skill id，让 Desktop 只有在受审查 Bundle 声明的全部运行面都已激活后才通过验证。

阶段为 `pending`、`loading`、`active`、`failed` 或 `unloading`；条目没有存活的根 Fiber 时则为 `null`。该快照刻意只表示调用当下：Loader 仍是唯一的生命周期权威，本包不拥有缓存、历史、来源模型、事件流或修改路径。公开 payload 类型位于 `./types`，Typert 生成由 `./typert` 与 `./remote` 导出的 Host 和 Client Remote 产物。

该服务仅供 Remote 使用，刻意不声明同进程 Cordis `Context` merge。Client 包通过显式的 [`api-remotes`](../../api/remotes/README.md) 组合消费它，而不导入 Host 实现。它仍然只读：client module 与 Skill 数组只是激活证据，不是第二套注册表或修改入口。

## 模型体验

无，因为这个仅限 Host 的清单投影不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **仅表示调用当下** —— 结果不包含持久的失败历史或订阅；只要不存在存活的根 Fiber，就会报告 `null`，而不区分其原因。
- **无来源与修改能力** —— 服务不识别条目、client module 或 Skill 由哪个 bundle、profile 或 override 引入，也不能启用、停用、添加或移除插件。
