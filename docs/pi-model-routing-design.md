# Pi 多模型自动分流设计

> **状态：已放弃（2026-07-12）**
> 此方案的核心机制——在 `turn_end` 预测下一轮 LLM 请求的复杂度——被评估为不可靠的预测问题，不符合原始需求。详见 [`model-router/README.md`](../model-router/README.md)。
> 所有相关代码、配置、测试和数据分析已归档至 [`model-router/`](../model-router/) 目录。
> 以下文档保留为历史记录，不反映当前推荐做法。

## 1. 摘要

Model Router 是一个 downgrade-only Pi Extension。它在每个 provider request 边界独立决定使用：

- **user**：当前 agent run 开始时用户选择的精确模型对象；
- **weak**：严格配置的 weak 候选池中的模型。

Router 不配置第三种模型，不发现配置外模型，也不修改 Pi core。初始请求在 `before_agent_start` 分类；有工具结果且会自动继续时，在 awaited `turn_end` 中重新分类，并在 handler 返回前完成模型切换。

```text
agent run 开始 → 捕获 requestUserModel
  ├─ initial：准入规则 → classifier v2 → user | weak
  └─ 每个 tool continuation：边界安全门 → classifier v2 → user | weak
                                    ↓
                       下一 provider request 使用所选模型
```

因此 active 模式允许 `user → weak → user → weak`，不存在 sticky route 或最短 lease。

## 2. 目标与非目标

### 目标

1. 独立路由每个可继续的工具边界。
2. 只在证据充分、风险可控时降级到 weak。
3. 所有恢复路径使用 agent run 开始时捕获的精确 `requestUserModel` 对象。
4. classifier 使用有界、脱敏的 continuation evidence。
5. classifier 与 weak 使用显式、有序候选池和跨进程冷却。
6. shadow 生成真实的逐边界建议，但从不调用 `pi.setModel()`。
7. 审计可解释且不持久化 prompt、assistant text、工具正文或秘密。

### 非目标

- 不修改 Pi core 或增加 request-scoped model API。
- 不配置“更强模型”或第三模型 fallback。
- 不把工具名称直接当作 weak 批准规则。
- 不增加 hysteresis、最短 lease 或 sticky routing。
- 不自动发现模型、后台探活或动态质量排序。
- sub-pi 继续消费 weak 池，但不采用 continuation classifier 语义。

## 3. 状态机与安全不变量

`before_agent_start` 在任何降级之前捕获一次：

```ts
requestUserModel: RuntimeModel
```

后续模型变化不会覆盖该对象。

每个边界的 route 为 `user | weak | reject`：

- `user`：已在精确 user model 上则 no-op，否则恢复该对象；
- `weak`：已在所选 weak 上则 no-op，否则按池顺序解析并切换；
- `reject`：仅用于确定性拒绝初始无效请求。

安全不变量：

1. 确定性拒绝或 hard-user 信号不能被 classifier 覆盖。
2. Router 只能切到配置 weak，或恢复精确 user model。
3. registry 只按配置的 `provider/id` 精确查找。
4. abort 不冷却候选，也不继续 fallback。
5. 图片与 context window 不兼容时不降级。
6. 技术冷却按 `role/provider/id` 隔离。
7. classifier 与 sub-pi fallback 链都受总时间预算约束。
8. prompt、assistant text、result excerpt、异常正文、auth/header/env 不落盘。

## 4. 配置

默认路径：`~/.pi/agent/model-router.json`。配置 `version` 仍为 `1`；未知字段和非法范围严格拒绝。模型角色接受单对象或有序非空数组。

```json
{
  "version": 1,
  "mode": "shadow",
  "models": {
    "classifier": [
      { "provider": "nvidia-free", "id": "z-ai/glm-5.2", "supportsImages": false },
      { "provider": "deepseek", "id": "deepseek-v4-flash", "supportsImages": false }
    ],
    "weak": [
      { "provider": "google", "id": "gemini-3.5-flash", "supportsImages": true },
      { "provider": "opencode", "id": "mimo-v2.5-free", "supportsImages": true }
    ]
  },
  "classification": {
    "ruleProfile": "conservative-v1",
    "minWeakConfidence": 0.9,
    "timeoutMs": 20000,
    "totalTimeoutMs": 30000,
    "maxInputChars": 12000,
    "maxContinuationResultChars": 6000
  }
}
```

| 字段 | 默认值 | 语义 |
|---|---:|---|
| `classification.timeoutMs` | 20000 | 单个 classifier 尝试上限 |
| `classification.totalTimeoutMs` | 30000 | classifier fallback 链总预算 |
| `classification.maxInputChars` | 12000 | 最终序列化 classifier input 上限 |
| `classification.maxContinuationResultChars` | 6000 | continuation result excerpt 聚合上限，且不得超过 `maxInputChars` |
| `limits.maxWeakContinuationTurns` | 4 | 当前 weak 连续边界上限 |
| `limits.maxNoProgressTurns` | 2 | 无可观察进展边界上限 |

配置缺失时为 off；配置无效时为 off/error，不使用部分配置继续。

## 5. Classifier protocol v2

classifier 必须只返回一个 JSON 对象：

```json
{
  "protocolVersion": 2,
  "route": "weak|user",
  "confidence": 0.0,
  "riskFlags": [],
  "reasonCode": "localized_explicit_task"
}
```

输入包含 `decisionKind: initial | continuation`。Continuation input 包含 allowlisted tool metadata、路径、错误/exit code、progress 状态以及脱敏 excerpt；工具名和成功状态只是证据，不直接批准 weak。

合法 `user`、低置信度 weak、带 risk flag 的 weak 都立即选择 user，不进行投票。技术/协议失败按候选池 fallback；总预算耗尽时恢复或保留 user model。

## 6. Continuation evidence 与隐私边界

每个工具结果最多 2000 字符；所有结果合计受 `maxContinuationResultChars` 限制。预算在结果间公平分配，最终再确保 `JSON.stringify(input).length <= maxInputChars`，优先保留结构化 metadata，再裁剪 prose。

发送 classifier 前启发式脱敏：

- Authorization、Bearer/Basic token；
- API key、access token、password、client secret 等赋值；
- PEM private key；
- 常见 cloud credential；
- 可疑长高熵字符串。

启发式脱敏只能降低风险，**不是绝对保密保证**。Evidence 仅发送给显式配置的 classifier provider，严格有界且从不写入 audit JSONL。

## 7. Continuation 安全门

当前边界出现以下信号时跳过语义 classifier，下一请求直接使用 user model：

- 工具错误、非零退出或 verification failure；
- 当前敏感/不可逆操作；
- 有有效 capsule 时确认 scope drift；
- repeated/no-progress/weak-turn limit；
- weak context window 不足（包含保守 output/reserve allowance）；
- actual model mismatch；
- weak provider failure或 abort。

工具/verification/sensitive/mismatch 信号只影响当前边界。后续安全且有可观察进展的边界可再次分类 weak。无 capsule 时不能确定 scope drift；这种不确定性进入 classifier。可观察进展会重置 no-progress 和 repeated-operation 状态。

`turn_end` 没有工具结果时表示完成，不调用 continuation classifier。

## 8. 候选池、冷却与失败恢复

候选按配置顺序处理：跳过冷却项，精确 registry lookup，检查声明/registry capability 和 auth，返回首个 ready 模型。技术失败冷却 30 分钟并继续；用户 abort、任务质量或验收失败不冷却模型。

健康文件为 `~/.pi/agent/model-router-health.json`（`0600`），内存与磁盘同 key 保留更晚 `retryAfter`，使用临时文件原子替换。

恢复矩阵：

| 边界 | 行为 |
|---|---|
| classifier failure，当前 user | no-op |
| classifier failure，当前 weak | 恢复精确 user model |
| weak resolution/auth/setModel 耗尽 | 保留或恢复 user；Router 可 suspended |
| weak provider error | 冷却实际 weak，恢复 user |
| user provider error | 交给 Pi；不选择其他模型 |
| abort | 恢复 user，不冷却 user |
| agent end | 若仍在 weak，恢复 user |
| restore failure | 报告 `restore-error`，不选择第三模型 |

Suspended 期间普通 agent run 继续使用 user model。冷却到期后的下一请求重新解析候选并恢复原 shadow/active intent。

## 9. Shadow 与 audit schema v2

Shadow 执行相同的边界安全门、classifier、readiness 和 recommendation，但 `pi.setModel()` 调用数恒为零。每个 continuation 记录自己的 classification，而不是复制 initial 结果。

新记录使用 `schemaVersion: 2`，包括：

- `route: user | weak | reject` 与 `decisionKind`；
- classifier identity、fallback、latency、固定失败码；
- `classifierInputChars`、`resultExcerptChars`、`excerptsTruncated`；
- recommended/actual model、usage 与 allowlisted tool summary。

记录不包含 prompt、assistant text、tool result、excerpt、脱敏前后秘密、auth/header/env。`/routing review` 和 `/routing shadow-review` 同时读取 schema 1/2；schema-1 的 legacy `strong` 只在 review 中归一化为 user/no-downgrade，历史文件不重写。

## 10. Sub-pi 与运行命令

`route_task_block` 只接受严格、单 repo TaskCapsule，复用 weak 池、冷却和总预算。模型技术失败可尝试下一 weak；scope/验收/普通进程失败和 abort 不重试。

命令：

```text
/routing off
/routing shadow
/routing active
/routing status
/routing review
```

`off` 恢复 activation model 并清理运行状态，但不清除健康文件。

## 11. Trade-offs

- 每个 eligible continuation 增加 classifier latency 与费用。
- 频繁切换 provider 可能降低 prompt-cache 命中率。
- weak 首次接管时可能需要读取较大历史上下文。
- Pi 的 `setModel()` 有持久选择副作用；Router 通过恢复精确 user model 缓解。
- 跨 provider history 由 Pi 归一化，但候选兼容性仍需实际验证。
- Shadow 只衡量推荐频率，不能直接证明 counterfactual weak 输出质量。

## 12. 验收基线

- 每个 eligible tool continuation 独立分类。
- active 支持 user/weak 双向切换且不选择第三模型。
- hard-user 边界之后可重新降级。
- classifier v2 evidence 有界、脱敏且不进入审计。
- shadow 不切模型并产生逐边界 schema-2 记录。
- 旧 version-1 config 和 schema-1 audit review 兼容。
- `node --test tests/model-router.test.mjs` 与 `git diff --check` 通过。
