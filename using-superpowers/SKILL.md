---
name: using-superpowers
description: Pi 的 superpowers 启动引导。通常由 superpowers-bootstrap extension 自动注入；仅在手动检查或调试该引导时使用。
disable-model-invocation: true
---

# Using Superpowers in Pi

<EXTREMELY-IMPORTANT>
只要某个 skill 有哪怕 1% 的适用可能，就先读取它，再决定是否使用。
不要凭记忆执行 skill；总是读取当前版本。
</EXTREMELY-IMPORTANT>

## 优先级

1. 用户直接要求、`AGENTS.md`、项目约束
2. 适用的 skills
3. 默认行为

## Pi 里的 skill 使用方式

- Pi 启动时已把 available skills 的 `name + description` 放进上下文
- 当某个 skill 可能适用时，用 `read` 打开对应的 `SKILL.md`
- 在回答、提澄清问题、执行命令、修改文件之前，都先判断有没有适用 skill
- 如果读完发现不适用，可以不用；但不能跳过检查

## 先后顺序

1. 先看 process skills：`brainstorming`, `systematic-debugging`, `test-driven-development`, `verification-before-completion`, `writing-plans`
2. 再看实现或领域 skill

常见场景：

- 新功能 / 行为改动 → 先 `brainstorming`
- bug / 测试失败 / 异常行为 → 先 `systematic-debugging`
- 实现 feature 或 bugfix → 先 `test-driven-development`
- 要宣称完成、修复、通过 → 先 `verification-before-completion`

## 不要这样合理化

- “先看看代码再说”
- “我先问个澄清问题”
- “这个太小了，不需要 skill”
- “我记得这个 skill 怎么做”
- “我先改一点，等会再补 skill”

这些都不是跳过 skill 的理由。

## Pi 适配说明

- Claude Code 的 `Skill` tool，在 Pi 里对应为：用 `read` 读取 skill 文件
- Claude Code 的 `TodoWrite` 在 Pi 里没有同名内建工具；如果某个 skill 需要 checklist，就用普通结构化步骤执行
- 这个 skill 一般由启动 extension 自动注入；不需要反复手动读取
