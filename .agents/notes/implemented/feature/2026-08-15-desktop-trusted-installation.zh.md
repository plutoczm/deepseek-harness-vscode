# Agent Note: Desktop 可信安装

Status: implemented

[English](2026-08-15-desktop-trusted-installation.md) | 中文

## 问题

目录结果本身不是安装权威。Desktop 必须把一个经过校验的确定版本转换为串行 Profile 变更，在不关闭窗口的情况下替换回环 Host，并区分进程就绪与能力真实激活。渲染器重载后必须观察同一操作，而包名、压缩包 URL、可执行文件、registry、参数、环境与运行证据继续由 Desktop 拥有。

F003 实现成功事务及其持久恢复基础。F005 随后基于同一日志与快照闭合回滚和中断操作恢复；生产变更现已通过该控制器开放。

## 决策

**一个控制器拥有一个有序持久操作。** 控制器解码 `{ pluginId, version, idempotencyKey }`，让重复键加入同一操作，把另一并发请求拒绝为忙碌，并原子发布不可变阶段。变更前记录当前兼容指纹，以及 Profile manifest、锁文件、patch、模块元数据和目标包是否存在的私有快照。

**Desktop 重建全部变更权威。** 它解析经过校验的确定目录候选，只下载其固定制品，限制大小并禁用重定向，校验摘要、压缩包安全、包身份、Bundle 声明、证据声明与安装生命周期脚本缺失，再通过操作拥有的压缩包路径调用打包的 `pnpm@11.7.0`，使用固定无 shell 参数、精简环境、固定 store 和 registry，并禁用脚本。

**只有联合运行证据通过后才提交。** 事务通过 `@deepseek-ai/dsh-app-boot` 核对 Bundle 成员，校验已安装确定包与 Profile 投影，替换受监管 Host 代次，在新 origin 上重载现有窗口，验证回环健康，并要求全部声明的 Loader 条目、客户端模块与 Skill id 出现；随后才发布 `committed`。

**渲染器只观察，不推断成功。** Electron 暴露固定 install/get/event 方法。紧凑的目录行动作会先针对确定版本重新执行兼容检查；允许时打开与详情页相同的应用级广泛权限确认，拒绝或检查失败时则进入确定版本详情并展示原因。只有完成确认才会发送固定安装意图。页面同时订阅事件并调用 `getOperation()`，因此组件重建或 Host 重连会恢复持久状态；实现阶段在界面中归并为四个稳定的用户进度步骤。Web 开发桥接通过 session storage 回放同一阶段，不拥有文件系统或进程权限。生产 preload 现以 `mutationsEnabled=true` 暴露同一恢复事务控制器。

## 曾考虑的替代方案

**让渲染器传入 npm 目标或压缩包路径。** 不采用：这会把展示元数据转换为包、网络和进程权威。

**把替代 Host 就绪当作安装成功。** 不采用：Bundle 仍可能不完整加载，Host 条目、客户端贡献或 Skill 可能缺失。

**从 PATH 运行系统 `pnpm`。** 不采用：已安装应用必须能在干净机器运行，不能信任环境中的可执行文件或配置解析。

**成功路径通过后就启用动作。** 不采用：失败或中断变更仍需验证回滚，才能让用户安全到达。

## 验证

局部测试覆盖操作归属和日志恢复、Profile 锁与快照、macOS/Windows 路径下的确定包管理器调用、真实已审核压缩包、真实 Host 加客户端 fixture 与 Skill fixture、经过替代 Host 代次的有序事务阶段、提交前运行证据、目录行确定版本预检与阻断跳转、明确的信任确认、分组客户端进度与组件重建恢复，以及 PATH 不含系统 Node/pnpm 时的安装与全新 Profile 读取。Desktop 与客户端源码类型检查通过。

独立目录包验收进一步修复并验证只在真实 Host/包体暴露的问题：Desktop 直接拥有 `dsh-app-boot` 的四个实际运行 peer，使其进入 `app.asar`；运行验证器按 Typert Remote 合同发送 `payload: { args: {} }`；没有待恢复事务时，Desktop 在读取兼容指纹前初始化 shipped Web Profile，使空 `DSH_HOME` 首次启动不再失败。最新 macOS arm64 目录包在无系统 Node/pnpm 的 PATH 下从 npm 搜索 `dsh-latex-tools@0.1.2`，保持事务不变直到用户明确确认，随后安装、换代 Host 并观察到 active Loader 与客户端证据；三点菜单卸载在下一代 Host 提交后移除已安装投影。本轮只生成未签名目录包，未生成正式发布安装器。

## 后果

安装、停用、启用、确定版本更新与卸载现在复用同一已安装身份、操作词汇、日志、Profile 快照、固定包管理器边界、Host 重启路径、运行验证器和恢复控制器。公开 npm 索引仍是社区分发源，技术校验不等于 DeepSeek 代码审计。
