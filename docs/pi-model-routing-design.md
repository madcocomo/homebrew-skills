# Pi 多模型自动分流设计

## 1. 摘要

Model Router 是一个 downgrade-only Pi Extension：复杂任务继续使用用户当前模型；只有确定性规则与 classifier 都允许时，才临时租用 weak 模型。

classifier 与 weak 都由严格配置的**有序候选池**提供。Router 不发现配置外模型、不发健康探测请求。技术故障会按 `role/provider/id` 冷却 30 分钟，并通过 `~/.pi/agent/model-router-health.json` 在 session 和进程之间共享。

```text
[用户请求]
    → [确定性准入]
    → [classifier 有序 fallback，总预算约束]
    → strong：不干预用户模型
    → weak：[weak 有序选择] → [临时 lease]

{classifier 或 weak 必需角色耗尽}
    → [suspended]
    → 普通请求继续使用用户模型
    → 冷却到期后的下一请求重新解析并自动恢复
```

## 2. 目标与非目标

### 目标

1. 仅在边界明确、验收完整、风险较低时降级到 weak。
2. classifier 与 weak 使用显式、有序、固定身份的候选池。
3. 技术失败候选跨 session/process 冷却 30 分钟。
4. classifier fallback 受单次和整条链路两个超时约束。
5. active lease 与 `route_task_block` 共享 weak 池和健康状态。
6. 候选耗尽时暂停 Router，而不阻断普通 Pi 请求。
7. 状态、审计和健康文件可解释且不泄露敏感内容。

### 非目标

- 不自动搜索配置外模型。
- 不做后台健康探测、Provider 级熔断或动态质量排序。
- 不建立 strong 模型池；strong verdict 只表示“不干预”。
- 不因任务质量、验收失败、scope drift 或 no-progress 冷却模型。
- weak 已开始生成后，不在同一 agent run 内切到其他 weak。
- 不提供手动清空冷却状态的命令。
- 不修改 Pi core 或 request-scoped model API。

## 3. 安全不变量

1. **规则优先**：deterministic reject/strong 不能被 classifier 覆盖。
2. **仅降级**：Router 只切到已配置 weak，或恢复 lease 前捕获的精确用户模型对象。
3. **固定身份**：registry 只执行配置中的 `provider/id` 精确查找，不枚举候选。
4. **用户取消优先**：abort 不冷却且不继续 fallback。
5. **能力保守**：图片能力不匹配时不向 text-only weak 降级。
6. **失败隔离**：冷却 key 是 `role/provider/id`，不扩大到整个 provider。
7. **时间有界**：classifier 与 sub-pi fallback 链都受总预算约束。
8. **最小持久化**：不落盘 prompt、响应正文、异常正文、auth、header 或环境变量。

## 4. 配置

默认路径：`~/.pi/agent/model-router.json`。`version` 仍为 `1`，未知字段严格拒绝。

`models.classifier` 和 `models.weak` 同时接受旧单对象与新数组；内部统一归一化为非空数组。同一角色内重复 `provider/id` 无效。数组顺序就是 fallback 顺序。

```json
{
  "version": 1,
  "mode": "shadow",
  "models": {
    "classifier": [
      { "provider": "nvidia-free", "id": "z-ai/glm-5.2", "supportsImages": false },
      { "provider": "nvidia-free", "id": "deepseek-ai/deepseek-v4-pro", "supportsImages": false },
      { "provider": "deepseek", "id": "deepseek-v4-flash", "supportsImages": false }
    ],
    "weak": [
      { "provider": "google", "id": "gemini-3.5-flash", "supportsImages": true },
      { "provider": "opencode", "id": "mimo-v2.5-free", "supportsImages": true },
      { "provider": "opencode", "id": "deepseek-v4-flash-free", "supportsImages": false }
    ]
  },
  "classification": {
    "ruleProfile": "conservative-v1",
    "minWeakConfidence": 0.9,
    "timeoutMs": 20000,
    "totalTimeoutMs": 30000,
    "maxInputChars": 12000
  },
  "limits": {
    "maxWeakContinuationTurns": 4,
    "maxNoProgressTurns": 2,
    "maxRepeatedOperationCount": 2
  },
  "logging": {
    "directory": "~/.pi/agent/model-router-logs",
    "maxReasonChars": 240
  },
  "subPi": {
    "enabled": false,
    "maxConcurrent": 1,
    "timeoutMs": 1800000
  }
}
```

关键默认值：

| 字段 | 默认值 | 语义 |
|---|---:|---|
| `classification.timeoutMs` | 20000 | 每个 classifier 尝试的上限 |
| `classification.totalTimeoutMs` | 30000 | classifier fallback 链总预算 |
| `classification.maxInputChars` | 12000 | 超限时保守使用用户模型 |
| `subPi.timeoutMs` | 1800000 | 整条 child fallback 链总预算 |

配置文件缺失时 Router 为 off；配置无效时为 off/error，不能使用部分配置继续。

## 5. 候选选择与冷却

每个请求或 child invocation 边界都会刷新持久冷却，并按配置顺序：

1. 跳过尚未到期的冷却候选。
2. 图片请求跳过声明 `supportsImages:false` 的 weak；不冷却它。
3. 精确执行 registry `find(provider, id)`。
4. 交叉检查声明和 registry 图片能力。
5. 获取 auth readiness。
6. 返回第一个 ready 候选。
7. 技术解析失败则冷却并继续。

进入冷却的固定原因包括：

- `not_found`
- `auth_missing`
- `image_capability_mismatch`
- `provider_error`
- `timeout`
- `empty_response`
- `invalid_protocol`
- `set_model_failed`
- `weak_model_error`
- `child_model_error`

### 持久健康文件

路径：`~/.pi/agent/model-router-health.json`，权限 `0600`。

```json
{
  "version": 1,
  "entries": [
    {
      "role": "classifier",
      "provider": "nvidia-free",
      "id": "z-ai/glm-5.2",
      "failedAt": 1780000000000,
      "retryAfter": 1780001800000,
      "reason": "provider_error"
    }
  ]
}
```

内存与磁盘同 key 取更晚 `retryAfter`。写入前重新读取并合并其他进程记录，删除过期记录，再用 mode `0600` 临时文件原子替换。文件损坏或 I/O 失败只产生限频通用 warning；当前进程的内存冷却仍生效。

## 6. Classifier fallback

Classifier 仅在 deterministic admission 为 `eligible` 时运行。每次尝试使用：

```text
min(classification.timeoutMs, totalTimeoutMs 剩余时间)
```

以下失败会冷却当前 classifier 并尝试下一候选：模型/auth 不可用、timeout、provider/error stop、空响应、严格 JSON 协议失败。

以下结果立即结束扫描，不投票、不继续调用：

- 合法 strong；
- 合法 weak 但置信度低；
- 合法 weak 但 riskFlags 非空；
- 用户 abort。

总预算耗尽时，未尝试候选不冷却，本次保守使用用户模型。生产适配器每次尝试 `maxRetries: 0`。

## 7. Active weak lease

Classifier 最终允许 weak 后，Router 在切换前捕获一次 `leaseReturnModel`，随后按 weak 池顺序解析并调用 `pi.setModel()`：

- resolution/auth/声明能力失败：冷却并继续；
- `setModel=false` 或抛错：以 `set_model_failed` 冷却并继续；
- 首个切换成功者成为实际 `targetModel`；
- 审计和状态栏使用实际成功模型，而不是池首项。

图片请求只尝试 image-capable weak。若没有图片 weak，但健康 text weak 仍存在，本请求保留用户模型，不全局暂停。

### 生成阶段

实际 weak 返回技术性 `stopReason=error` 时：

1. 以 `weak_model_error` 冷却实际 weak；
2. 结束 lease；
3. 恢复精确 `leaseReturnModel`；
4. 当前 run 不再切换；
5. 下一请求跳过该 weak。

用户 abort 会释放 lease，但不冷却。验收失败、scope drift、工具错误、重复操作、无进展、turn cap、产物缺失等质量/任务信号也只释放 lease，不冷却模型。

## 8. Suspended 与自动恢复

`runtimeMode` 保留用户意图：`off | shadow | active`。有效状态包括：

```text
off | shadow-ready | active-ready | suspended | restore-error | error
```

classifier 或 weak 必需角色耗尽、active weak 切换耗尽、sub-pi 技术 fallback 耗尽时进入 `suspended`。暂停前若有 lease，先恢复 return model。

暂停期间：

- 普通请求继续使用用户当前模型；
- 不调用 classifier；
- 不切 weak、不注入 capsule；
- `route_task_block` 拒绝委派；
- shadow/active 运行意图保持。

最早 `retryAfter` 之前，请求不会重新查 registry。到期后的下一请求重新精确解析两个角色；都可用时恢复原 shadow/active 状态并继续处理该请求。失败则重新冷却并保持 suspended。`/routing off` 不删除健康文件。

## 9. Sub-pi fallback

`route_task_block` 只接受完整、严格、单 repo 的 TaskCapsule。它与 active lease 共享 weak 池和冷却状态。

生产 child runner 每次只执行 invocation 指定的一个 weak；池编排留在 Router 工具层。明确的模型技术失败会冷却当前 weak，并在 `subPi.timeoutMs` 剩余总预算内用下一 weak 重跑同一逻辑 task/capsule。

不重试：scope drift/uncertain、产物缺失、verification failed、非模型进程失败、admission/capsule 无效和用户 abort。slot 对一次逻辑工具调用只 acquire/release 一次；每次 child 的 tmux 和临时文件仍独立清理。

## 10. 命令、状态与审计

命令：

```text
/routing off
/routing shadow
/routing active
/routing status
```

当模型不可用时，`active`/`shadow` 保存请求的 runtime intent 并报告 suspended。`off` 恢复 activation model、清理运行状态，但不清除冷却。

`/routing status` 显示：

- configured/runtime/effective 状态；
- classifier 与 weak 有序池；
- 实际 selected classifier/weak；
- 冷却 reason、retryAfter；
- suspended reason 与最早重试时间；
- 单次和总 classifier timeout；
- 日志目录与 sub-pi 开关。

审计记录只包含 allowlist 字段：实际 identity、fallback 次数、固定失败码、决策、计数、延迟、usage 与验收布尔值。不得写入完整 prompt、模型响应、provider 异常正文、auth/header、环境变量、图片或完整工具输出。

## 11. 失败矩阵

| 失败 | 行为 |
|---|---|
| 配置缺失/无效 | off 或 off/error；普通 Pi 不受影响 |
| 单个 classifier 技术失败 | 冷却并尝试下一 classifier |
| classifier 总预算耗尽 | 本请求保守使用用户模型；未尝试候选不冷却 |
| weak resolution/setModel 失败 | 冷却并立即尝试下一 weak |
| weak 生成 error | 冷却实际 weak，恢复 return model；下一请求 fallback |
| 用户 abort | 不冷却、不继续 fallback |
| 必需角色耗尽 | suspended；普通请求继续使用用户模型 |
| 冷却到期仍失败 | 重新冷却 30 分钟并保持 suspended |
| child 模型技术失败 | 同一总预算内尝试下一 weak |
| child 任务/进程/验收失败 | 不重试，返回固定错误码 |
| 健康/审计文件 I/O 失败 | 通用限频 warning；普通请求继续 |
| lease restore 失败 | 明确 warning，结束 lease，不改派其他模型 |

## 12. 验收基线

- 旧单对象配置仍可解析。
- 数组严格、非空、去重且保持顺序。
- 只查找配置中的 identity。
- 冷却边界为 29:59 仍冷却、30:00 可重试。
- classifier 和 sub-pi 总预算不随候选数倍增。
- active 与 sub-pi 共享 weak 冷却。
- suspended 在请求边界自动恢复。
- lease 始终恢复进入前捕获的精确模型对象。
- 健康文件、状态和审计不含敏感 payload。
- `tests/model-router.test.mjs` 与相关 extension 回归套件通过。
