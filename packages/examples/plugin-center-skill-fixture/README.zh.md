# @deepseek-ai/dsh-plugin-center-skill-fixture

[English](README.md) | 中文

Desktop 插件中心 Skill pack（技能包）安装链路的受审查开发测试包。其 Bundle patch 激活一个 Host provider（宿主提供方），后者注册全局可发现的 `fixture-harness-basics` Skill。生产功能不得依赖此测试包。

## 模型体验

### `fixture-harness-basics` Skill

#### 模型看到的内容

消费方纳入或调用已安装 Skill 时，模型会看到该包自有的确定性内容，说明这个受审查测试包用于证明 Host 重启后的持久性。

#### Token 影响

普通提示词不会增加 token；纳入 `fixture-harness-basics` 时，只会把该确定性 Skill 内容加入当前消费请求。

#### KV Cache 影响

安装后 Skill 目录会变化，但普通请求前缀保持不变，直到消费方纳入或调用 `fixture-harness-basics`。

## 已知限制与延后工作

- **仅用于开发证据** — Skill 文本为 F003 激活测试而固定，并非生产学习资源。
