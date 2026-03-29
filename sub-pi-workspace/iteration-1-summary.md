# sub-pi · iteration-1 结果摘要

## 总结

本轮已完成 5 个 eval 的实际运行，并生成：
- `benchmark.json`
- `benchmark.md`
- `review.html`
- 各 run 的 `timing.json`
- 各 run 的 `grading.json`

## 量化结果

- **with_skill**：60% pass rate
- **without_skill**：100% pass rate
- **delta**：-0.40

时间统计（平均）：
- with_skill：155.4s
- without_skill：96.2s

## 核心发现

### 1. skill 在“明确要求给出编排方案”的场景下，容易过度执行
最明显的是：
- Eval 1（串行 gate）
- Eval 3（串并行混合）

在这两个 case 中，with_skill 没有稳定停留在“输出方案”，而是进一步尝试：
- 真的启动子流程
- 真的轮询状态文件
- 进入等待 / 重试 / 网络失败

这说明 skill 目前有一个重要问题：
> **缺少“规划模式 vs 执行模式”的明确切换规则**。

### 2. skill 在“边界很清楚的局部场景”表现不错
通过的 with_skill case：
- Eval 2：并行 batch
- Eval 4：不安全并行反例
- Eval 5：单子任务隔离闭环

这些 case 的共同点是：
- 目标单一
- 冲突规则明确
- 输出形式清楚
- 不容易被模型理解为“现在就开跑”

### 3. baseline 反而更稳定地给出“纯规划答案”
without_skill 在这轮全部通过，说明当前 skill 的主要问题不是“信息缺失”，而是：
- **指令把模型推向执行过深**
- 尤其在串行编排与串并行混合编排里，模型会把“如何组织”误读成“立刻开始编排并执行”

## 建议修正方向

下一轮应优先修改 skill：

1. 增加 **Planning Mode / Execution Mode** 判定规则
   - 如果用户要的是“设计流程”“编排方式”“模板”“方案”，默认只输出方案
   - 只有用户明确要求“现在启动”“直接执行”“帮我开跑”时，才进入执行模式

2. 在 skill 中显式加入一句类似规则
   - 当任务目标是设计或评审工作流时，不要实际启动子进程或 tmux session
   - 先输出任务拆分、文件结构、验证门槛和汇总方式

3. 给串行 / 混合场景补一条防过度执行说明
   - 尤其是涉及 `acorn -> avia-base` 或 `先定边界再并行分析` 这种描述时
   - 优先理解为 orchestration design，而不是 immediate execution

## 关键产物路径

- benchmark：
  - `/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-1/benchmark.json`
  - `/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-1/benchmark.md`
- review：
  - `/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-1/review.html`

## 特殊说明

Eval 1 和 Eval 3 的 with_skill 原始运行被保留为 partial 证据：
- 它们真实反映了当前 skill 的“过度执行”倾向
- 后续修 skill 时应重点参考这些 case
