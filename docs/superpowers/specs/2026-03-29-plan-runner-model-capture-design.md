# Plan Runner 模型固定与记录设计

## 背景

全局 `plan-runner` extension 当前会启动一个子 `pi` 进程执行计划，但没有显式记录或固定执行该 run 的 model / thinking level。

这会带来一个风险：如果用户在另一个 pi 会话中切换了全局生效模型，那么当前会话执行 `/run-plan` 时启动的子 `pi` 可能错误继承“最后一次全局选择的模型”，而不是发起 `/run-plan` 的主会话当下生效的模型。

## 目标

1. `/run-plan` 必须使用**执行该命令的当前 pi 会话**生效的 model。
2. 同时固定并记录该 run 的 thinking level。
3. 运行状态条应显示精确模型标识，而不是友好名。
4. 新的 run 需要把 model / thinking 信息落盘，便于事后追溯。
5. 不要求迁移历史 run 数据。

## 非目标

- 不为旧 run 补录 model 信息。
- 不引入单独的运行配置体系或额外 `run-config.json`。
- 不改变 plan runner 的整体执行模型（仍然使用单子进程 + tmux）。

## 方案选择

### 方案 A：只在启动子进程时传 `--model` / `--thinking`
优点：改动最小。
缺点：可追溯性弱，历史 run 目录看不出实际执行模型。

### 方案 B：固定执行配置并同步落盘（采用）
在 `/run-plan` 时捕获当前 `ctx.model` 与 `pi.getThinkingLevel()`，作为本次 run 的固定配置：
- 启动子进程时显式传入 `--model` / `--thinking`
- 在状态条、`status.json`、`summary.md`、`README.txt` 中显示和记录

优点：同时解决正确性与可观察性问题。
缺点：比方案 A 多少量字段维护成本。

### 方案 C：新增完整 `run-config.json`
优点：结构最规范。
缺点：对当前问题偏重。

## 设计

### 1. 在 `/run-plan` 时固定 model / thinking
`run-plan` 命令启动时读取：
- `ctx.model.provider`
- `ctx.model.id`
- `pi.getThinkingLevel()`

将其写入本次 `RunState`。一旦 run 创建完成，该配置即固定，后续其他会话或当前会话切换模型都不应影响已启动的子 `pi`。

如果 `ctx.model` 不存在，则拒绝启动 run，并向用户报告无法确定当前会话生效模型。

### 2. 扩展运行时与状态数据结构
为 `RunState` 增加：
- `modelProvider`
- `modelId`
- `thinkingLevel`
- `modelDisplay`（格式：`provider/id:thinking`）

为 `StatusData` 增加同样字段，用于落盘和恢复。

### 3. 子 `pi` 启动时显式指定模型
当前 run 脚本仅执行：

```bash
pi --mode json -p @task.md
```

调整为：

```bash
pi --model 'provider/id' --thinking 'level' --mode json -p @task.md
```

这样子 `pi` 的模型选择将来自本次 run 的固定快照，而不是外部全局状态。

### 4. 状态条显示精确模型标识
状态条在现有 `state + phase` 的基础上追加：

```text
anthropic/claude-opus-4-6:high
```

示例：

```text
▶ running · implementing-gate-1 · anthropic/claude-opus-4-6:high
```

仅显示精确标识，不显示友好名。

### 5. 运行工件落盘
以下工件需要记录 model / thinking：
- `.pi/runs/<run>/status.json`
- `.pi/runs/<run>/summary.md`
- `.pi/runs/<run>/README.txt`

至少保证用户事后可以直接从 run 目录看出：
- 计划文件
- 执行分支
- 执行模型
- thinking level
- 当前/最终状态

### 6. 兼容策略
不迁移历史 run。对于旧状态文件缺失 model 字段的情况：
- 读取逻辑保持容错
- UI 允许不显示模型信息
- 新 run 始终写入新字段

## 预期修改文件

### 生产代码
- 修改：`extensions/plan-runner.ts`
  - 在 run 创建时捕获当前会话 model / thinking
  - 扩展 `RunState` / `StatusData`
  - 启动子 `pi` 时传入 `--model` / `--thinking`
  - 状态条与摘要信息追加 model 展示

### 文档/计划
- 本设计文档：`docs/superpowers/specs/2026-03-29-plan-runner-model-capture-design.md`

## 测试与验证思路

1. 单元级验证（如果当前仓库没有测试框架，则以最小可执行验证为主）
   - 断言 run 脚本包含显式 `--model` 与 `--thinking`
   - 断言初始状态文件包含 model / thinking 字段
   - 断言状态条文案拼装包含 `provider/id:thinking`

2. 手工回归验证
   - 在当前会话选择一个强模型执行 `/run-plan`
   - 在另一会话切到弱模型
   - 检查新建 run 的 `run.zsh`、`status.json`、`summary.md` 是否仍使用当前会话模型

3. 兼容性验证
   - 没有 model 字段的旧 `status.json` 不应导致状态刷新报错

## 风险

- `ctx.model` 在命令执行上下文中为空时，需要明确报错，不能静默回退到默认模型。
- 状态条如果过长，可能略影响可读性，但精确模型标识是本需求的优先级更高项。

## 结论

采用“固定执行配置并同步落盘”的方案：在 `/run-plan` 触发瞬间捕获当前会话 model 与 thinking，启动子 `pi` 时显式传参，并在状态条与 run 工件中记录精确标识，以确保执行正确性与事后可追溯性。