# Agent Note: GitHub Topic 插件候选采集

Status: proposed

[English](2026-08-15-github-topic-plugin-candidate-ingestion.md) | 中文

## 问题

DeepSeek Harness 推荐使用 GitHub `dsh-plugin` Topic 作为发现机制，但 Topic 匹配只能证明仓库选择了一个标签，不能证明仓库包含可安装的 Harness Bundle、包版本不可变、代码经过审核或具有安装资格。2026-08-15 查阅的上游公开文档没有描述另一套官方提交、审核或已验证市场收录流程。

[DeepSeek Harness Studio 仓库](https://github.com/fufankeji/deepseek-harness-studio)已经设置 `dsh-plugin`，并被[GitHub Topic](https://github.com/topics/dsh-plugin)索引，因此应用已经能通过[官方 README](https://github.com/deepseek-ai/deepseek-harness#community-and-support)指定的渠道被发现。但是，Studio 仓库仍属于桌面应用 monorepo：其[根包](../../../../package.json)和[Desktop 包](../../../../apps/desktop/package.json)都是私有应用包，且没有声明 `dsh.bundle.patch`。把其中任一包改成 Bundle 都会错误描述分发单元，并把应用发布与插件安装耦合起来。

插件中心注册表只接受经过审核、不可变的精确版本，并明确排除任意包来源。[Feature Map](../../../../docs/specs/feature-map.md#out-of-scope-and-deferred-items)允许外部仓库在后续成为运营审核输入，而[插件中心架构](../../../../docs/architecture/plugin-center.md)继续以注册表作为目录权限源，以所选 Profile 作为本地安装真源。未来实现需要一项持久决策，说明 Topic 发现如何接入该系统，同时不取得安装权限。

## 提案

保持 Desktop 仓库的应用定位，仅保留 `dsh-plugin` 用于生态发现。每个真正可安装的扩展都应发布为独立 npm 包、Git 仓库或预构建 tarball，并遵循[官方 Bundle 发布格式](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)：非私有精确包版本、已打包运行时文件、`cordis.patch.yml` 和 `dsh.bundle.patch` 声明。每个插件仓库都应标明许可证、源码仓库、发布产物和精确安装命令。

以后在获得明确功能授权时，在现有注册表导入和审核路径上游增加 GitHub Topic 候选源适配器。其暂定规划标识为 `F006A`；该标识不会把它加入当前 Feature Map，也不授权实现。适配器将执行以下阶段：

1. 把带有 `dsh-plugin` 的仓库读入仅运营人员可见的候选队列。
2. 定位真实包及其 `dsh.bundle.patch` 声明，不把仓库根目录直接视为包。
3. 解析不可变 commit、包子目录、精确包版本、许可证和预构建产物。
4. 把产物提交给现有非执行式发布校验器和审核工作流。
5. 把审核通过的产物镜像到注册表拥有的对象源，并且只发布经过审核的精确版本。

Topic 候选绝不直接显示为可安装目录条目。Desktop 渲染器不会收到 Git URL、任意包位置、commit 选择器、包管理器参数或未经审核的元数据。只有现有注册表发布路径能够生成目录版本，也只有其经过审核的精确产物能够进入兼容性检查和安装。现有[产物校验器](../../../../apps/desktop/src/plugin-center/artifact-verifier.ts)继续在不 import、不执行插件代码的情况下检查包身份、版本、`dsh.bundle.patch`、被禁生命周期脚本、声明的运行时证据、归档路径、大小、媒体来源和产物摘要。

候选记录把来源证据与目录身份分开保存：仓库 URL、不可变 commit SHA、包子目录、发现的包名与版本、许可证结果、发现时间和最近观测时间。这些字段只作为运营侧证据，不会成为渲染器可控制的安装输入。仓库描述、Topic 成员关系、GitHub star、fork 和 release 热度可以辅助候选分流，但绝不建立验证、排行权限或官方背书。

开始实现前，重新核对官方 README、Bundle 发布指南、CLI 行为和 GitHub Topic 语义。上游发现或分发方式发生变化时，应替换本提案中的假设，而不是围绕陈旧证据增加兼容层。

## 所有权与信任

| 输入或状态 | 权限源 | 允许的结果 |
|---|---|---|
| GitHub Topic 成员关系 | GitHub 仓库所有者 | 仅创建或刷新运营候选 |
| 源码仓库和 commit | 候选源适配器 | 记录不可变来源；绝不授予安装资格 |
| 包与产物检查 | 注册表发布校验器 | 在不执行代码的情况下拒绝或生成审核证据 |
| 审核决定和精确版本 | 插件注册表 | 发布、撤回、精选或保留已审核目录版本 |
| 已安装包和 Bundle 组合 | 所选 Desktop Profile | 保持唯一的本地安装真源 |
| 运行时 Host、客户端和 Skill 证据 | 当前 Host 代次 | 在普通 Desktop 事务后确认激活 |

## 考虑过的替代方案

**直接安装所有带有 `dsh-plugin` 的仓库。** Topic 成员关系由仓库自行声明，其中包含应用、仅源码项目、不相关仓库以及需要不可信构建的包。直接安装会绕过精确版本审核、产物完整性、兼容性、恢复和运行时验证。

**把 Desktop 应用仓库改成可安装 Bundle。** 该应用打包 Electron、Host 运行时、注册表集成和平台安装程序，并非一个可组合 Harness 扩展。在应用根目录声明 Bundle 会形成错误的包约定，并使两条发布路径复杂化。

**在渲染器中执行 GitHub 发现和包解析。** 这会把 URL 和包选择暴露给不可信展示进程，并重复注册表策略。候选发现应属于审核上游的认证运营服务。

**在精选结果旁允许任意 GitHub、npm、URL 或路径安装。** 这会破坏现有固定来源、精确产物、禁止生命周期脚本和恢复模型。开发者 CLI 安装继续与普通插件中心分离。

## 验收标准

- 只有取得明确功能授权并重新核对上游证据后，才能开始实现。
- 通过 `dsh-plugin` 选择的仓库可以进入运营队列，但未经审核的不可变精确产物不能出现在可安装目录中。
- 适配器能够区分应用仓库、多包仓库、仅源码包、缺少 Bundle 声明、包含被禁生命周期脚本、缺少许可证和产物不受支持等情况，并且不执行候选代码。
- 每个已发布目录版本都保留不可变源码与产物来源，并通过现有注册表校验和审核路径。
- 渲染器与 Agent 安装路径继续只提交已验证目录身份和精确版本，绝不获得任意来源权限。
- 禁用候选源适配器或适配器失败时，手工注册表导入、目录读取、已安装管理和本地 Profile 真源保持不变。

## 风险

Topic 噪声较多且由仓库自行选择，因此自动发现可能产生大量审核队列和误报。速率限制、仓库删除、分支强制推送、monorepo 布局、许可证变化和仅源码 TypeScript 包都会增加解析难度。捕获不可变 commit、限制刷新范围、给出明确不支持原因并由运营人员分流，可以控制成本但不能消除问题。

镜像并批准产物会产生供应链责任。静态包检查无法证明运行时行为无害，已审核 Harness 插件仍具有广泛的 Host 级 Node 权限。本提案保留当前披露和审核模型；更强隔离需要另一项架构决策。

在 Desktop 应用上使用 `dsh-plugin` 可以提高生态发现能力，但也可能被误解为应用本身是可安装插件或获得官方背书。仓库文案必须把它描述为带插件中心的 Desktop 应用，而独立 Bundle 仓库承担可安装插件约定。
