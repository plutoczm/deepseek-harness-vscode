# Agent Note: Desktop 可信安装基础

Status: implemented

[English](2026-08-15-desktop-trusted-installation-foundations.md) | 中文

## 问题

F003 需要在已允许的插件变更期间替换 Desktop Web Host，同时不能关闭应用、丢失新 origin，或让旧 child 的迟到事件使替代进程失效。原有监管器只拥有一次启动和一次永久关闭。与此同时，`dsh plugin` 私下改变 `dsh.profile.bundles`；若在可信事务建立前把这段行为复制到 Desktop，就会出现两个 Profile 组合语义拥有者。

这些原语本身当时不会让渲染器获得可达的安装入口。完整事务记录在 [Desktop 可信安装](2026-08-15-desktop-trusted-installation.md)；后续恢复控制器现已保护开放的生产变更路径。

## 决策

**Desktop Host 监管器拥有明确代次。** 每个 spawn 的 child 都获得单调递增 id，并私有拥有就绪结算、退出结算、有界启动输出、origin 与停止归属。`start()` 保留既有 `Promise<string>` 约定，并加入活动启动。`current` 只公开已就绪的 `{ id, origin }`。`restart(reason)` 串行执行替换操作，在发出信号前把旧停止标记为操作归属，以既有 TERM 到 KILL 升级等待该确定 child 退出，然后返回已就绪的替代代次。`shutdown()` 永久关闭监管器，并拥有最后一次停止。

**只有当前代次可以发布意外退出。** 每个退出回调在清除状态或通知应用前，都会比较其捕获的代次对象与活动对象。重启归属或关机归属的退出属于预期事件，旧 child 的重复或延迟事件不能影响更新代次。

**Profile Bundle 核对只有一个共享纯函数拥有者。** `@deepseek-ai/dsh-app-boot` 导出 `reconcileProfileBundles(before, after, exportsBundle)`。它通过调用方提供的函数仅检查每个当前依赖一次，按 manifest 顺序追加 Bundle 依赖，只移除曾由依赖管理且已不再导出 Bundle 的条目，保留模板和其他用户管理的 Bundle，并报告新加入的普通依赖。它不改变任一输入；不需要 Bundle 转换时返回原始 `after` manifest。

**调用方继续拥有平台策略。** CLI 负责解析已安装包、输出引导告警，并写入已变化的 manifest。Desktop 可信事务提供自己的已审核包检查与持久化边界，同时消费同一个转换。共享包不会运行 pnpm、解析渲染器输入或获得文件系统变更权威。

## 曾考虑的替代方案

**跨重启复用一个可变 child 槽位。** 不采用：旧退出监听器可能清除或终止属于替代进程的状态，并发重启也无法拥有确定归属。

**在 Desktop 中复制 CLI 核对循环。** 不采用：添加、更新与移除行为可能在两个入口间漂移，尤其是依赖的已安装版本新增或失去 `dsh.bundle` 时。

**把包解析和 manifest 持久化移入共享辅助函数。** 不采用：CLI 与打包 Desktop 具有不同的包权威、运行时和事务边界。共享拥有者应是确定状态转换，而不是外围 I/O 策略。

**在本基础 Task 中就把重启接入 `main.ts` 或开放安装。** 当时不采用：共享桥接与动态 origin 发送方策略仍归 F002/F003 联调窗口所有，公开变更也仍等待 F005 恢复验收。

## 验证

`apps/desktop/tests/host-supervisor.spec.ts` 覆盖共享启动、代次身份、两次串行重启、重启归属退出、旧进程重复退出、就绪冲突、启动超时、TERM 到 KILL 关机升级、当前代次意外退出和永久关闭。`packages/boot/app-boot/tests/profile.spec.ts` 覆盖有序添加、模板保留、依赖管理条目移除、普通依赖、未变化身份与输入不变性。`apps/cli/tests/plugin.spec.ts` 证明 CLI 消费共享结果完成包检查、告警和持久化。Desktop、app-boot 与 CLI 的局部类型检查通过；本轮没有运行根构建或 Desktop 打包。

## 后果

这些接口支撑事务：窗口导航和 IPC 归属读取 `supervisor.current`，操作归属重启不会表现为应用失败，Desktop 与 CLI 共享 Bundle 核对。生产变更现使用完整的恢复事务控制器。
