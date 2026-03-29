# sub-pi · iteration-1 运行方案

## 目标

对 `sub-pi` 做第一轮定性 + 基础定量验证。

本轮重点不是文件产物质量，而是看 skill 是否能正确做出这些编排判断：
- 串行 gate
- 并行 batch
- 串并行混合
- 错误并行识别
- 单子任务隔离闭环

## 技能与基线

- **with_skill**：使用 `sub-pi`
- **without_skill**：不加载该 skill，作为 baseline

因为这是一个新建 skill，所以 baseline 统一使用 **without_skill**，而不是旧版本 skill。

## 工作区路径

- Skill 目录：`/Users/wuke/code/AH/.claude/skills/sub-pi`
- Workspace 根目录：`/Users/wuke/code/AH/.claude/skills/sub-pi-workspace`
- 本轮结果目录：`/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-1`

## 建议执行策略

一次性启动全部 10 个运行：
- 5 个 with_skill
- 5 个 without_skill

这样便于：
- 同批完成，减少时间偏差
- 更容易横向比较
- 统一进入 grading / benchmark / viewer 阶段

运行方式建议：
- 用 `tmux` 为每个运行单独开 session
- 主会话只负责发起、观察完成情况、收集结果
- 不要在主会话里展开每个运行的完整日志

## iteration-1 评测项映射

### Eval 1
- **目录名**：`eval-1-serial-acorn-avia-base`
- **测试重点**：串行 gate + 自动推进
- **with_skill run id**：`eval-1-with-skill`
- **without_skill run id**：`eval-1-without-skill`

### Eval 2
- **目录名**：`eval-2-parallel-controller-review`
- **测试重点**：并行 batch + fan-in
- **with_skill run id**：`eval-2-with-skill`
- **without_skill run id**：`eval-2-without-skill`

### Eval 3
- **目录名**：`eval-3-mixed-api-refactor`
- **测试重点**：串并行混合
- **with_skill run id**：`eval-3-with-skill`
- **without_skill run id**：`eval-3-without-skill`

### Eval 4
- **目录名**：`eval-4-unsafe-parallel-shared-scope`
- **测试重点**：识别不应并行的反例
- **with_skill run id**：`eval-4-with-skill`
- **without_skill run id**：`eval-4-without-skill`

### Eval 5
- **目录名**：`eval-5-isolated-debug-loop`
- **测试重点**：单子任务局部闭环
- **with_skill run id**：`eval-5-with-skill`
- **without_skill run id**：`eval-5-without-skill`

## 每个 eval 的目录结构

实际运行时按需创建，不要一次性提前铺满所有目录。

```text
iteration-1/
  eval-1-serial-acorn-avia-base/
    eval_metadata.json
    with_skill/
      outputs/
      timing.json
      grading.json
    without_skill/
      outputs/
      timing.json
      grading.json

  eval-2-parallel-controller-review/
    eval_metadata.json
    with_skill/
      outputs/
      timing.json
      grading.json
    without_skill/
      outputs/
      timing.json
      grading.json
```

## 每个 eval 需要的 eval_metadata.json

每个 eval 目录里放一个：

```json
{
  "eval_id": 1,
  "eval_name": "serial-acorn-avia-base",
  "prompt": "...",
  "assertions": []
}
```

说明：
- 如果后续完全按 skill-creator schema 对齐，也可把这里的 `assertions` 理解为 grader 阶段要检查的事项
- 真正的输入测试集仍以 `evals/evals.json` 里的 `expectations` 为准

## 每个运行要保存的输出

即使输出主要是文本方案，也建议统一保存到 `outputs/`：

- `final-response.md`：最终回答
- `transcript.txt`：如可获取，则保存执行转录
- `metrics.json`：如可统计，则保存工具调用信息
- `notes.txt`：执行过程中的不确定点（可选）

最少应保证：
- 有最终回答
- 有 timing.json
- 后续可生成 grading.json

## with_skill 与 without_skill 的差异

### with_skill
使用包含该 skill 的项目根目录执行，让模型能读取：
- `SKILL.md`
- `references/serial-task-template.md`
- `references/parallel-batch-template.md`
- `references/fan-in-summary-template.md`
- `references/examples.md`

### without_skill
使用**不包含该 skill**的执行环境，避免模型读取该 skill。

最稳妥的 baseline 方式：
- 建一个临时 baseline 项目根目录
- 不放 `sub-pi` skill
- 其余环境尽量保持一致

## 推荐的 baseline 环境做法

### with_skill 根目录
可直接使用当前项目根：
- `/Users/wuke/code/AH`

### without_skill 根目录
建议单独准备，例如：
- `/tmp/pi-skill-eval-baseline-ah`

其中：
- 可以保留最小 `.claude/` 结构
- 但不要放 `sub-pi`
- 这样可以最大限度避免 baseline 被 skill 污染

## 启动顺序

### 第 1 步：先准备 iteration-1 的 eval 目录与 metadata
按 eval 启动时逐个创建：
- `eval_metadata.json`
- `with_skill/`
- `without_skill/`

### 第 2 步：同一波次启动全部运行
原则：
- 对每个 eval，同时启动 with_skill 和 without_skill
- 不要先跑完全部 with_skill，再回头补 baseline

### 第 3 步：保存 timing 信息
每个运行完成后立刻记录：

```json
{
  "total_tokens": 0,
  "duration_ms": 0,
  "total_duration_seconds": 0
}
```

如果当前执行方式拿不到 token，也至少记录：
- `duration_ms`
- `total_duration_seconds`

## 评分方式

本轮优先用 `evals/evals.json` 中的 `expectations` 做 grading。

建议对每个运行生成：
- `<run-dir>/grading.json`

每条 expectation 最终都要转成：
- `text`
- `passed`
- `evidence`

## benchmark 聚合

完成所有 grading 后，在 workspace 上运行：

```bash
python -m scripts.aggregate_benchmark \
  /Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-1 \
  --skill-name sub-pi
```

脚本位置：
- `/Users/wuke/code/AH/.agents/skills/skill-creator/scripts/aggregate_benchmark.py`

运行时建议在该脚本所在目录或可导入 `scripts` 模块的目录下执行。

## viewer 生成

如果本环境没有稳定图形界面，优先使用静态 HTML：

```bash
python /Users/wuke/code/AH/.agents/skills/skill-creator/eval-viewer/generate_review.py \
  /Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-1 \
  --skill-name "sub-pi" \
  --benchmark /Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-1/benchmark.json \
  --static /Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-1/review.html
```

## 本轮关注点

优先看这些差异：
- with_skill 是否比 without_skill 更稳定地区分串行 / 并行 / 混合
- with_skill 是否更常提到 gate、batch、fan-in、summary-only consumption
- with_skill 是否更少犯“错误并行”的问题
- with_skill 是否更清晰地下沉局部阅读、验证和诊断到子进程

## 运行完成后的理想产物

`iteration-1/` 下应至少有：
- 5 个 eval 目录
- 每个 eval 对应的 with_skill / without_skill 结果
- 10 份 timing.json
- 10 份 grading.json
- 1 份 benchmark.json
- 1 份 benchmark.md
- 1 份 review.html

## 建议下一步

若准备正式开跑，可再补两个小文件：
1. `iteration-1-run-checklist.md`：实际执行清单
2. 每个 eval 的 `eval_metadata.json` 初始内容模板
