# sub-pi · iteration-2 结果摘要

## 总结

iteration-2 已完成同一套 5 个 eval 的重跑、grading、benchmark 和 review 生成。

关键变化：
- skill 已补入 **规划模式 / 执行模式** 判定规则
- 明确规定：用户要的是方案、模板、流程设计、评审时，默认只输出编排方案，不直接启动子进程

## 量化结果

### iteration-2
- **with_skill**：100% pass rate
- **without_skill**：80% pass rate
- **delta**：+0.20

### 与 iteration-1 对比
- iteration-1 with_skill：60%
- iteration-2 with_skill：100%
- **提升：+40 个百分点**

## 核心发现

### 1. 主要问题已被修正
iteration-1 的核心失败点是：
- Eval 1（串行 gate）
- Eval 3（串并行混合）

当时 with_skill 会把“编排设计请求”误当成“立即执行请求”，从而：
- 实际启动子流程
- 轮询状态文件
- 进入挂起或网络失败

在 iteration-2 中，这两个 case 的 **with_skill 都已通过**。

说明新增的模式分流规则是有效的：
- 需要设计方案时，skill 不再自动过度执行
- 需要执行时，仍可保留原有的执行工作流能力

### 2. skill 现在比 baseline 更稳地停留在“规划层”
最明显的是 Eval 3：
- **with_skill**：正确输出“先串行定义边界 → 再并行审查 → 最后串行收敛”的方案
- **without_skill**：反而再次过度执行并挂起，最终被记为失败样本

这说明修订后的 skill 已经把“编排设计请求”与“执行请求”区分得更清楚。

### 3. 其他 3 个稳定场景继续保持通过
iteration-1 已经通过、iteration-2 继续稳定通过的有：
- Eval 2：并行 batch
- Eval 4：不安全并行反例
- Eval 5：单子任务隔离闭环

这表示这次修改没有破坏 skill 在原本擅长场景中的表现。

## 当前结论

基于当前 5 个核心 eval：
- 这个 skill 的核心缺陷已经被修正
- 当前版本已经比 baseline 更符合目标行为
- 对“方案设计类请求”的鲁棒性显著提升

## 关键产物路径

- benchmark：
  - `/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-2/benchmark.json`
  - `/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-2/benchmark.md`
- review：
  - `/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-2/review.html`
- 对比摘要：
  - `/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-1-summary.md`
  - `/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-2-summary.md`

## 建议

如果继续迭代，优先级应从“修 bug”转为“扩测试面”：
1. 增加更模糊的提示词，测试 planning / execution 边界是否仍稳定
2. 增加用户明确说“现在执行”的 case，验证 skill 不会被过度保守化
3. 再决定是否做 description trigger 优化

就当前核心集而言，这个版本已经可以视为一个明显优于 iteration-1 的可用版本。
