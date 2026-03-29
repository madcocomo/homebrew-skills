# Pi Skill 触发调优笔记

本文总结了在 **pi** 环境里调优 skill 触发的一套实用方法，重点针对如下问题：

- skill 明明应该触发，但 agent 直接参考工程文档后开工
- 误把 Claude Code 的触发评测方式当成 pi 的默认方式
- skill 的 description 写了很多框架名，但用户真实提示词并不会显式提这些词

> 核心结论：在 pi 中，判断 skill 是否被触发，最直接的标准不是“最终回答里有没有提到 skill”，而是 **agent 是否实际 `read` 了该 skill 的 `SKILL.md`**。

---

## 1. Pi 与 Claude Code 的 skill 评测方式不同

### Claude Code 常见做法
很多现成的 skill-creator / description optimization 流程默认用：

```bash
claude -p ...
```

这类流程是在模拟 Claude Code 的 `available_skills` 触发机制。

### Pi 中更合适的做法
Pi 原生支持 skills，触发流程是：

1. 启动时扫描 skill 的 `name + description`
2. 将 skill metadata 放入系统上下文
3. 当模型判断匹配时，调用 `read` 去加载该 skill 的 `SKILL.md`
4. 再按照 skill 内容执行

因此在 pi 中，**更可靠的 trigger eval** 是：

```bash
pi --mode json "<prompt>"
```

然后检查 JSON 事件流中是否出现：

- `tool_execution_start`
- `toolName = read`
- `args.path = <target-skill>/SKILL.md`

如果出现，就说明这个 skill 在该 prompt 下被 pi 实际加载了。

---

## 2. 推荐的 pi-native 触发评测方法

### 单条 probe

```bash
pi --mode json --tools read,grep,find,ls "帮我补一个 feature 文件测试 DM 创建接口，不要乱写 step definitions。"
```

观察输出事件里有没有：

```json
{
  "type": "tool_execution_start",
  "toolName": "read",
  "args": {
    "path": "/path/to/your-skill/SKILL.md"
  }
}
```

### 批量 probe
可写一个轻量脚本，逐条运行 prompt，然后统计：

- should-trigger 是否真的读了 skill
- should-not-trigger 是否避免读取 skill

对于 pi，这比直接复用 `claude -p` 脚本更稳，也更符合真实运行环境。

---

## 3. Description 该怎么写

### 原则 1：写“用户意图”，不要只写框架名

差的写法：

```yaml
description: BDD testing guide using Cucumber, JFactory, and RESTful-cucumber.
```

这种写法的问题是：
- 过于像知识标签
- 用户如果只说“补 feature”“给接口加场景”，不一定能命中

更好的写法：

```yaml
description: 遇到 avia-base 后端 BDD / feature 测试任务就使用本 skill：新增或修改 src/test/resources/features 下的 feature 文件、给 API 补 Given/When/Then 场景、把 JUnit/MockMvc 接口测试改成项目现有 feature 风格 ...
```

关键点：
- 描述 **什么时候用**
- 覆盖用户自然说法
- 框架名只是补充，不应成为唯一触发线索

### 原则 2：写真实 cue，而不是理想化 cue

不要假设用户会说：
- “请用 JFactory”
- “请用 Cucumber”

更常见的是：
- “补 BDD 测试”
- “新增 feature 文件”
- “给这个接口加场景”
- “把这个 JUnit 测试改成 BDD”
- “按项目现有方式补测试”

### 原则 3：显式写排除项

除了说明“什么时候该触发”，还应说明“不该在什么时候触发”，例如：

- 前端 e2e
- OpenAPI 设计
- 纯运行时排障
- 只重构测试基础设施，不改 feature 场景

这类排除项能显著减少误触发。

---

## 4. 真正常见的干扰源：不是 description，而是上层上下文

在真实项目里，skill 不触发，往往不是因为 skill 完全写错，而是因为 **更高优先级的工程上下文已经足够让模型直接开工**。

典型干扰源：

- `AGENTS.md`
- 上层 workflow skill（如“new-api-dev”）
- 简化版 testing-patterns 文档
- 邻近 feature / steps / specs

### 一个常见现象
模型可能会直接读取：

- `avia-base/AGENTS.md`
- `ApplicationSteps.java`
- `CucumberTestRunner.java`
- 相邻 `.feature`

然后开始写测试，**却没有先读 `jfactory-bdd/SKILL.md`**。

### 解决方式
上层文档不要只写：

> 参考 jfactory-bdd

而应尽量写成：

> 先读取 `.pi/skills/jfactory-bdd/SKILL.md`（或 `/skill:jfactory-bdd`），再看相邻 feature

这比单纯继续堆 description 更有效。

---

## 5. 一套实用的调优顺序

建议按下面顺序做，而不是一开始就疯狂改 description：

### 第一步：确认 skill 是否真的被读了
先用 `pi --mode json` 验证。

### 第二步：检查上层文档是否把活抢走了
重点看：
- `AGENTS.md`
- 上层 workflow skill
- 工程内“快速参考”文档

### 第三步：再优化 description
description 应该：
- 覆盖真实用户说法
- 讲清楚适用范围
- 讲清楚排除范围
- 避免只堆框架词

### 第四步：做 should-trigger / should-not-trigger eval
至少准备两类：
- 正向：补测试 / 补 feature / 改成 BDD / 复用现有 step
- 反向：纯开发 / 纯排障 / 纯设计 / 纯重构测试基础设施

---

## 6. jfactory-bdd 这个案例的经验

在一个 avia-base 风格项目里，调优 `jfactory-bdd` 时有几个特别关键的经验：

### 经验 1：不要依赖 “JFactory” 这个词
用户真实说法通常不会显式提框架名。

### 经验 2：仓库现有 cue 比框架名更有效
例如：
- `src/test/resources/features`
- `Given Exists data`
- `Then response should be`
- `ApplicationSteps`
- `Scenario Outline`
- “不要乱写 step definitions”

### 经验 3：仅改 skill 还不够
如果 `AGENTS.md` / `new-api-dev` 之类的上层文档没有引导先读 skill，skill 可能仍然被绕过。

### 经验 4：误触发常出现在“测试基础设施重构”
比如：
- 重构 `ApplicationSteps`
- 整理 step definitions
- 调整 Cucumber config

这些 prompt 虽然提到测试术语，但目标不是“编写/修改 feature 场景”，应尽量排除。

---

## 7. 建议沉淀成团队规范

对于会被频繁复用的 skill，建议在仓库里形成三层约束：

1. **skill description**：定义什么时候触发
2. **上层 AGENTS / workflow skill**：显式要求先读该 skill
3. **pi-native trigger eval**：用 JSON 事件流持续验证

这样可以避免：
- skill 写得很好，但从不被真正加载
- 项目越长越复杂，skill 越容易被高层文档绕过

---

## 8. 最小命令参考

### 单条触发验证

```bash
pi --mode json --tools read,grep,find,ls "帮我补一个 feature 文件测试 DM 创建接口，不要乱写 step definitions。"
```

### 观察是否读取 skill
搜索 JSON 输出中的：

- `tool_execution_start`
- `toolName: read`
- `path: .../your-skill/SKILL.md`

### 如果项目里允许 slash command

```bash
/skill:jfactory-bdd
```

可用于手工强制加载 skill，验证 skill 内容本身是否合理。

---

## 9. 一句话总结

> 在 pi 中，调 skill 触发时，**先验证有没有读到 skill，再优化 description；先处理上层文档抢活问题，再处理 wording 问题。**
