# Pi 多模型自动分流设计

## 1. 摘要

本设计通过一个自包含的 Pi Extension，为“下一次 provider request”选择静态配置的弱模型或强模型：

- **阶段 1：Shadow**——执行规则判定、固定分类器调用、效果评估和日志记录，但不调用 `pi.setModel()`。
- **阶段 2：Active**——在同一 session 内切换模型。首轮在 `before_agent_start` 决策；有工具结果的 turn 在 `turn_end` 评估并为下一次 provider request 决策。
- **阶段 3：Sub-pi block delegation**——对边界完整的任务 capsule，使用固定弱模型启动隔离 child pi；主路由不依赖该能力。
- **阶段 4：明确排除**——不修改 Pi request 级 model API，不实现自定义 SDK launcher。

安全边界不是“分类器认为简单”，而是：

```text
确定性规则允许
    AND 固定分类器明确判为 weak
    AND capsule 完整
    AND 图片能力匹配
    AND 未触发升级信号
        => weak
否则 => 配置的 strong
```

分类器、弱模型、强模型均由配置固定指定，不存在候选池、健康探针或动态换模。

---

## 2. 目标

1. 降低强模型 provider request 次数及 token 成本。
2. 以“下一次 provider request”为路由粒度，不丢失同一 agent loop 中的工具结果上下文。
3. 对弱模型执行结果持续评估，在失败、漂移或无进展时自动升级到固定强模型。
4. 让 shadow 数据可用于离线评估准确率、延迟、usage、成本和验收结果。
5. 支持图片能力声明与确定性路由。
6. 支持运行时关闭、恢复启用前模型，以及删除 Extension 后完整剥离。
7. 阶段 3 为明确边界的块级任务提供隔离委派，而不改造 Pi session/export 关联。

## 3. 非目标

- 不在同一次已经发出的 provider request 中途切模型。
- 不按单个 tool call 选择模型。
- 不实现候选模型池、轮询、健康探针、熔断器或任意模型 fallback。
- 不以工具黑名单限制弱模型；`edit`、`write`、Git 和本地进程重启均可执行。
- 不让分类器成为唯一安全门。
- 不为 classifier/weak/strong 自动选择“当前可用的相近模型”。
- 不增强父子 session、JSONL 或 HTML export 的关联关系。
- 不侵入 `extensions/plan-runner.ts` 或 Pi 核心。
- 不修改 Pi 临时 request model API，不实现自定义 SDK launcher。
- 不保证 `nvidia-free/minimaxai/minimax-m3` 连通；能力声明不等于连通性探测。

---

## 4. 术语

| 术语 | 定义 |
|---|---|
| Agent run | 一次用户输入触发的完整 agent loop，可能包含多个 turn。 |
| Turn | 一次模型响应及其工具 batch。 |
| Provider request | Pi 向某个 provider/model 发出的单次模型请求。 |
| Initial route | `before_agent_start` 为 agent run 的第一次 provider request 所做的决策。 |
| Continuation route | `turn_end` 在工具 batch 完成后，为下一次 provider request 所做的决策。 |
| Weak lease | 当前 agent run 获准继续使用弱模型的状态；有 turn 上限。 |
| Strong sticky | 当前 agent run 已使用或已升级到强模型，后续 continuation 不再降级。 |
| Deterministic admission | 不依赖模型输出、可单元测试的保守准入规则。 |
| Classifier | 静态配置的单一模型，仅输出严格分类 JSON；不参与候选模型选择。 |
| Task capsule | 描述目标、cwd、范围、步骤、预期产物和验收条件的紧凑任务契约。 |
| Upgrade signal | 使 weak lease 终止并切换到固定强模型的执行信号。 |
| Actual model | Assistant 消息中实际记录的 `provider/model`，而非仅看目标配置。 |

---

## 5. 已知约束与依据

- 目标 Pi 版本约为 `0.80.6`，当前包名是 `@earendil-works/pi-coding-agent`。
- `before_agent_start` 位于首轮 provider request 之前；`turn_end` 位于当前模型响应和工具 batch 之后。
- `turn_end` 的 handler 完成后，Pi 才可继续下一 turn，因此可在此处调用 `pi.setModel()`。
- 工具结果保留在同一 agent loop 的上下文中，切模型不会丢失前序工具结果。
- `pi.setModel()` 会修改 session 当前模型、全局默认选择，并产生 `model_change` 记录；本设计接受该副作用。
- 标准 JSONL 和 HTML export 已保留 model change，以及每条 Assistant 的 provider/model。
- Pi `0.80.6` 的运行时模型注册表通过事件/命令上下文 `ctx.modelRegistry` 使用；实现不依赖动态候选发现。
- 分类器实验中 `opencode/deepseek-v4-flash-free` 在 40 点数据上准确率为 72.5%，存在 5 个危险误判，且每次约增加 11～13 秒。因此它只能处理已通过确定性规则的候选项。

---

## 6. 总体架构

```text
                              ┌──────────────────────────┐
User prompt + images ────────→│ Deterministic Admission  │
                              └────────────┬─────────────┘
                                           │ hard-strong
                                           ├──────────────────────→ Strong
                                           │ eligible
                                           ▼
                              ┌──────────────────────────┐
                              │ Fixed Classifier         │
                              │ strict JSON, no pool     │
                              └────────────┬─────────────┘
                                      weak │ strong/error
                                           ▼
                         ┌─────────────────────────────────┐
                         │ Route Decision                  │
                         │ shadow: log only                │
                         │ active: pi.setModel(fixed role) │
                         └───────────────┬─────────────────┘
                                         │
                                         ▼
                         ┌─────────────────────────────────┐
                         │ Tool Observation + Evaluator    │
                         │ error/drift/repeat/no-progress  │
                         │ artifacts/verification/turn cap │
                         └───────────────┬─────────────────┘
                                  healthy│ upgrade
                                         ├──────→ keep Weak lease
                                         └──────→ Strong sticky
```

建议的生产代码仍为单文件入口 `extensions/model-router.ts`，但内部按纯函数边界组织：

1. **Config loader/validator**：读取、严格验证、应用可选字段默认值。
2. **Model resolver**：只解析配置中的固定 provider/id，并校验凭据和声明能力。
3. **Admission engine**：执行确定性规则并生成可测试的 reason codes。
4. **Classifier adapter**：调用固定分类器并严格解析协议。
5. **Capsule builder/validator**：从显式用户约束构造 capsule；不允许分类器凭空补全安全字段。
6. **Route state machine**：维护 mode、activation snapshot、request/turn、weak lease 和 strong sticky。
7. **Tool observer/evaluator**：观察调用与结果，不阻止工具，仅产生效果和升级信号。
8. **Router actuator**：在 active 模式下调用 `pi.setModel()`；shadow 不调用。
9. **Audit logger**：best-effort JSONL，不记录密钥或完整 prompt。
10. **Sub-pi adapter**：阶段 3 可独立启用的 capsule 校验、tmux 启动和结果回收。
11. **Command/UI adapter**：`/routing off|shadow|active|status`、状态栏、恢复与清理。

单文件不意味着大函数：事件 handler 只做编排，核心规则应导出为短小纯函数，函数原则上控制在 50 行以内。

---

## 7. 配置

### 7.1 配置位置与加载规则

默认配置路径：

```text
~/.pi/agent/model-router.json
```

实现使用 `getAgentDir()` 构造路径，不硬编码用户主目录。阶段 1～3不合并项目内配置，避免 repo-controlled 配置改变全局模型或把 prompt 发给非预期 provider。

加载语义：

1. **文件缺失**：有效模式为 `off`，不报错、不切模型。
2. **文件存在但 JSON 或 schema 无效**：有效模式为 `off/error`，给出明确错误；不得使用部分配置继续。
3. **未知字段**：报错，避免拼写错误被静默忽略。
4. **`shadow`/`active`**：三个固定模型配置必须齐全。
5. **运行时命令**只覆盖当前 extension 实例的 mode，不改写配置文件。
6. **默认值只用于明确标为可选的字段**；模型 identity 永无默认值。

### 7.2 Schema 示例

以下 provider/model 仅为结构示例；实际部署必须明确填写并确认凭据。`supportsImages` 是路由器的保守声明，不能由运行时从候选池推导。

```json
{
  "version": 1,
  "mode": "off",
  "models": {
    "classifier": {
      "provider": "opencode",
      "id": "deepseek-v4-flash-free",
      "supportsImages": false
    },
    "weak": {
      "provider": "opencode",
      "id": "mimo-v2.5-free",
      "supportsImages": true
    },
    "strong": {
      "provider": "anthropic",
      "id": "claude-opus-4-6",
      "supportsImages": true
    }
  },
  "classification": {
    "ruleProfile": "conservative-v1",
    "minWeakConfidence": 0.9,
    "timeoutMs": 20000,
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

### 7.3 默认值

| 字段 | 默认值 | 说明 |
|---|---:|---|
| 整个配置文件缺失 | `mode=off` | 唯一安全的安装默认值。 |
| `classification.ruleProfile` | `conservative-v1` | 仅接受实现明确支持的 profile。 |
| `classification.minWeakConfidence` | `0.90` | 低于阈值走 strong。 |
| `classification.timeoutMs` | `20000` | 超时走 strong，并记录原因。 |
| `classification.maxInputChars` | `12000` | 超限任务不截断后误判为 weak，直接走 strong。 |
| `limits.maxWeakContinuationTurns` | `4` | 达到上限后升级。 |
| `limits.maxNoProgressTurns` | `2` | 连续无进展达到上限后升级。 |
| `limits.maxRepeatedOperationCount` | `2` | 同一规范化操作超过上限后升级。 |
| `logging.directory` | `<agentDir>/model-router-logs` | 仅在 shadow/active best-effort 写入。 |
| `logging.maxReasonChars` | `240` | 防止自由文本泄漏和日志膨胀。 |
| `subPi.enabled` | `false` | 主路由不依赖 sub-pi。 |
| `subPi.maxConcurrent` | `1` | 首版避免并行写冲突。 |
| `subPi.timeoutMs` | `1800000` | 超时明确失败，不改派其他模型。 |

数值字段必须是有限值并处于实现定义范围，例如 confidence 为 `[0,1]`、timeout 为正整数、turn/count 上限至少为 1。provider/id 必须是非空字符串；不得出现 URL、token 或 API key 字段。

### 7.4 图片能力

配置必须为 classifier、weak、strong 分别声明 `supportsImages`。路由器还会与 registry 中模型的 `input` 能力交叉检查：

- 声明为 `true`，但 registry 不含 `image`：配置错误或模型不可用。
- 声明为 `false`，但 registry 支持图片：按 `false` 保守处理。
- 本设计不保留独立 `imageWorker` 字段，减少第四个模型角色。

已知示例：`opencode/mimo-v2.5-free` 与 `nvidia-free/minimaxai/minimax-m3` 可声明图片支持；后者的连通性不保证，且不会为它执行健康探针。

---

## 8. 运行状态与状态机

### 8.1 Session 状态

每个 session 维护：

```text
configuredMode         配置文件模式
runtimeMode            命令覆盖后的有效模式
effectiveState         off | shadow-ready | active-ready | error
activationModel        首次从 off 启用时捕获的 provider/id
requestId              当前用户请求的关联 id
turnIndex              Pi turn index
routeState             undecided | weak-lease | strong-sticky
weakContinuationCount  已使用弱模型 continuation 次数
noProgressCount        连续无进展次数
operationCounts        规范化工具操作计数
capsule                 当前 agent run 的已验证 capsule（若有）
upgradeSignals         当前 run 已发现的升级信号
lastTargetModel         最近目标模型
lastActualModel         最近 Assistant 实际模型
```

只把恢复和审计所需的最小状态通过 `pi.appendEntry("model-router-state", ...)` 写入 session：runtime mode、activation model、request id、route state 和最近升级原因。完整 prompt、工具输出和密钥不进入 custom entry。

### 8.2 路由状态机

```text
                       /routing shadow
            ┌────────────────────────────────┐
            │                                ▼
[off] ───────────────→ [shadow-ready] ──────────────┐
  │ /routing active       │                         │ log only
  ▼                       │ /routing active         │
[active-ready] ←──────────┘                         │
  │ initial weak                                    │
  ▼                                                 │
[weak-lease] ── upgrade signal / turn cap ──→ [strong-sticky]
  │ healthy tool batch                               │
  └──────────────────→ [weak-lease]                  │
                                                    │
任意非 off 状态 ── /routing off ──→ restore activation model ──→ [off]
active/weak/strong ── /routing shadow ──→ restore activation model ──→ [shadow-ready]
```

关键不变量：

- 同一 agent run 一旦进入 `strong-sticky`，不再降级。
- 新用户请求重置 route state，可重新获得 weak lease。
- shadow 从不调用 `pi.setModel()`。
- off 不执行分类器、不写路由日志、不更新路由状态栏。
- active 下每次切换只允许指向配置的 weak 或 strong。

### 8.3 模式注册与关闭语义

Extension factory 始终注册 `/routing` 命令，以便查看状态和重新启用。若启动时为 `off`，不注册路由事件 handler；首次切到 shadow/active 时按一次性 guard 注册。之后即使切回 off，已注册 handler 也立即 no-op，不产生路由副作用。

首次从 off 进入 shadow/active 时捕获当前模型。关闭时：

1. 等待命令上下文 idle（必要时 `ctx.waitForIdle()`）。
2. 调用 `pi.setModel(activationModel)` 恢复启用前模型。
3. 清除 weak lease、operation fingerprints、capsule、升级信号和状态栏。
4. 追加最小 custom state，表明 routing 已关闭。
5. 若恢复模型缺失或无凭据，明确报错；不尝试其他模型。路由仍关闭，但状态明确标为 `restore-error`。

---

## 9. 路由时序

### 9.1 首轮 provider request

```text
User           Extension                 Classifier            Pi/Provider
 │ prompt+images   │                          │                      │
 ├────────────────→│ before_agent_start       │                      │
 │                 │ reset request state      │                      │
 │                 │ deterministic admission  │                      │
 │                 │── eligible capsule ─────→│ fixed model complete │
 │                 │←── strict JSON ──────────│                      │
 │                 │ decide weak/strong       │                      │
 │                 │ shadow: log only         │                      │
 │                 │ active: pi.setModel() ─────────────────────────→│
 │                 │ optional capsule message │                      │
 │                 │ log decision             │                      │
 │                 └────────────────────────────────────────────────→│ provider request
```

首轮步骤：

1. 如果 mode=off，立即返回。
2. 为当前用户请求分配 request id 并清空前一 run 的 evaluator 状态。
3. 执行图片能力和确定性准入。
4. 若确定性规则判 strong，不调用分类器。
5. 若 eligible，构造仅含显式约束的 capsule，并调用固定分类器。
6. 严格解析分类器结果；只有 `route=weak`、confidence 达阈值、无 risk flags、capsule 完整时才给 weak。
7. shadow 仅计算 `targetModel`；actual 仍是当前 Pi 模型。
8. active 解析固定模型并调用 `pi.setModel()`。若 weak 不可用，升级到 fixed strong；若 strong 不可用则显式中止/报错，不能在 weak 上继续。
9. active+weak 时可注入一条隐藏的 `model-router-capsule` custom message，让弱模型看到边界；shadow 不注入。
10. 写入审计日志并更新状态栏。

### 9.2 工具 batch 后的 continuation

```text
Weak model ─→ tool calls ─→ tool_result observers ─→ turn_end
                                                  │
                                                  ├─ no tools: agent run ends, no switch
                                                  │
                                                  ├─ healthy: keep weak lease
                                                  │
                                                  └─ signal/cap: pi.setModel(strong)
                                                                      │
                                                                      ▼
                                                        next provider request
```

`turn_end` 处理：

1. 从 `event.message` 和 `event.toolResults` 确认本 turn 是否产生工具 batch。
2. 无工具 batch 表示没有自动 continuation，不为假设中的未来请求提前切模型。
3. 汇总 `tool_result`、工具调用 fingerprint、实际 Assistant 模型和 usage。
4. 执行效果评估。
5. 若当前为 strong-sticky，保持 strong，不调用分类器，不降级。
6. 若当前为 weak-lease 且健康、未到上限，保持 weak。
7. 若触发任一升级信号，切换到 fixed strong，并进入 strong-sticky。
8. 在 handler 返回前完成 `pi.setModel()`，使下一 provider request 使用已决策模型。

Continuation 不重复调用分类器。这样既避免每个工具 turn 额外增加约 11～13 秒，又避免同一任务内 strong→weak 振荡。

---

## 10. 确定性准入规则

### 10.1 判定顺序

规则输出：

```ts
type Admission = {
  verdict: "eligible" | "strong" | "reject";
  reasonCodes: string[];
  capsule?: TaskCapsule;
};
```

按以下优先级执行：reject > strong > eligible。规则只能把任务推向更保守的方向。

### 10.2 直接 strong/reject 条件

| 条件 | 结果 | reason code |
|---|---|---|
| 有图片且 weak 不支持图片、strong 支持 | strong | `image_requires_strong` |
| 有图片且 strong 也不支持 | reject | `no_configured_image_model` |
| prompt 超过 `maxInputChars` | strong | `classifier_input_too_large` |
| 目标、允许范围或 cwd 无法明确 | strong | `scope_ambiguous` |
| 没有明确预期结果、验收命令或可检查后置条件 | strong | `acceptance_missing` |
| 要求大范围根因分析、架构/跨模块设计或开放式探索 | strong | `broad_analysis_or_design` |
| 涉及多个 repo，或目标模块/路径超过 conservative profile 上限 | strong | `cross_boundary_task` |
| 要求长期多步骤一致性，步骤存在显著共享状态或顺序推理 | strong | `long_horizon_consistency` |
| 用户意图互相冲突、包含未解决的选择 | strong | `intent_ambiguous` |
| 涉及生产凭据、认证授权、安全策略或不可逆数据操作且约束不足 | strong | `sensitive_or_irreversible` |
| capsule 的路径逃逸 repo root，或 allowed write 范围为空 | reject | `invalid_capsule_scope` |
| 当前 agent run 已升级 | strong | `strong_sticky` |

“要求 Git、edit、write 或重启进程”本身**不是** strong 条件，也不会阻止工具。判断依据是任务边界和验收是否清晰，而非工具名称。

### 10.3 Eligible 条件

只有同时满足下列条件才进入分类器：

- 单 repo、明确绝对 cwd/repository root。
- 允许读取/写入范围可枚举或可由明确目录前缀表示。
- 目标是局部、边界明确的修改/检查。
- 步骤明确，或可由用户给出的顺序直接规范化。
- 至少有一个预期产物。
- 至少有一个验收命令或机器可检查后置条件。
- 无图片能力冲突。
- 无 broad/cross-boundary/long-horizon/sensitive hard rule。

分类器不得补写缺失的 cwd、allowed scope 或验收条件来使任务 eligible。

---

## 11. 分类器协议

### 11.1 输入

分类器使用配置中的固定 classifier 模型，通过 `@earendil-works/pi-ai/compat` 的 `complete()` 直接调用；不通过 `pi.setModel()`，因此不会污染 session 模型和 model change 历史。

输入是紧凑分类记录：

```json
{
  "protocolVersion": 1,
  "requestId": "opaque-id",
  "promptExcerpt": "normalized text, bounded by maxInputChars",
  "cwd": "/absolute/project/path",
  "imageMetadata": [{"mimeType": "image/png"}],
  "explicitPaths": ["src/a.ts", "tests/a.test.ts"],
  "explicitSteps": ["..."],
  "expectedArtifacts": ["..."],
  "verification": ["node --test ..."],
  "deterministicReasonCodes": ["capsule_complete"]
}
```

不发送图片二进制、环境变量、auth 数据、完整历史或工具输出。`promptExcerpt` 会发给配置的 classifier provider，但不会写入路由日志。

### 11.2 输出

分类器必须只返回一个 JSON object：

```json
{
  "protocolVersion": 1,
  "route": "weak",
  "confidence": 0.96,
  "riskFlags": [],
  "reasonCode": "localized_explicit_task"
}
```

约束：

- `route` 只能为 `weak | strong`。
- `confidence` 必须为 `[0,1]` 的有限数值。
- `riskFlags` 只能取固定枚举，例如 `ambiguous_scope`、`cross_module`、`long_horizon`、`sensitive`、`image_uncertain`、`acceptance_uncertain`。
- `reasonCode` 只能取固定枚举，不接受自由解释文本。
- 禁止 markdown fence、前后缀文本、额外字段。

解析失败、超时、abort、模型缺失、凭据缺失或 provider error 均得到 `classifier_failure`，目标升级为 fixed strong。不会尝试第二个 classifier。

### 11.3 安全组合

```text
if deterministic == reject: reject
else if deterministic == strong: strong
else if classifier failed: strong
else if classifier.route != weak: strong
else if classifier.confidence < threshold: strong
else if classifier.riskFlags not empty: strong
else: weak
```

现有 40 点实验中的 5 个危险误判必须由确定性规则或 capsule 完整性校验截获，才允许进入 active gate。

---

## 12. Task capsule

### 12.1 Schema

```ts
type TaskCapsule = {
  version: 1;
  taskId: string;
  objective: string;
  cwd: string;
  repositoryRoot: string;
  allowedRead: string[];
  allowedWrite: string[];
  forbidden: string[];
  steps: string[];
  expectedArtifacts: Array<{
    path?: string;
    condition: string;
  }>;
  verification: Array<{
    command?: string;
    postcondition?: string;
  }>;
};
```

### 12.2 构造原则

- `cwd` 和 `repositoryRoot` 由当前可信 session 上下文确认。
- allowed/forbidden scope 只能来自用户明确约束和可靠路径归一化。
- objective、steps、expected artifacts、verification 可压缩措辞，但不得新增用户未要求的权限。
- 所有路径在使用前转为绝对路径并检查是否位于 repository root 内。
- 若无法构造完整 capsule，当前请求走 strong，而不是让 classifier 猜测。

### 12.3 Active 同 session 用法

weak initial route 时，将 capsule 作为隐藏 custom message 注入当前 agent run，强调：

- 目标 repo/cwd；
- 允许写范围；
- 预期产物；
- 验收条件；
- 越界或无法满足时明确报告。

该 message 会参与 LLM context，但不是工具黑名单或执行拦截器。

---

## 13. 执行效果评估

### 13.1 观察点

- `tool_call`：记录规范化操作 fingerprint 和可识别路径；不 block、不改写参数。
- `tool_result`：记录 `isError`、bash exit code、产物/路径摘要和截断后的统计信息。
- `turn_end`：汇总当前工具 batch、Assistant actual model、usage、进展和验收状态。
- 文件系统后置检查：仅检查 capsule 明确列出的预期路径是否存在；检查失败本身也形成信号。

### 13.2 进展定义

一个 weak turn 至少满足一项才算有进展：

- 新的预期产物出现；
- allowed scope 内出现新的修改目标；
- 一个尚未完成的步骤有可观察完成信号；
- 验收命令首次执行并成功；
- 明确发现阻塞且没有重复同一操作。

只有重复读取、重复同一失败命令、同参数反复 edit/write，或没有新增产物/状态，均不算进展。

### 13.3 范围漂移

- 对有显式 path 的 read/edit/write/grep/find/ls，按规范化绝对路径与 capsule scope 比较。
- 对 bash/Git，识别明确的 cwd、`git -C`、`cd` 和已知产物路径；无法可靠解析时不伪装为“安全”，产生 `scope_observation_uncertain` 升级信号。
- 漂移检测只观察并升级下一 request，不基于工具名拦截当前工具。

### 13.4 验收命中

- capsule 中的 verification command 使用规范化命令 fingerprint 匹配。
- 非零 exit 或 `isError` 为验收失败。
- expected artifact/postcondition 在 turn_end 后检查。
- agent run 结束时若要求的验收从未执行或产物缺失，日志标记 `expected_acceptance_hit=false`；若还有 continuation，则立即升级。

---

## 14. 自动升级策略

任一信号触发 fixed strong：

| 信号 | 示例 reason code |
|---|---|
| 工具结果 `isError=true` | `tool_error` |
| bash/验证命令非零退出 | `nonzero_exit` / `verification_failed` |
| 工具访问超出 capsule 范围 | `scope_drift` |
| bash/Git 范围无法可靠判断 | `scope_observation_uncertain` |
| 同一规范化操作超过上限 | `repeated_operation` |
| 预期产物缺失 | `expected_artifact_missing` |
| 验收命令未执行或后置条件未满足 | `acceptance_missing_after_work` |
| 连续无进展达到上限 | `no_progress_limit` |
| weak continuation 达到上限 | `weak_turn_limit` |
| actual model 与目标不一致 | `actual_model_mismatch` |
| weak provider/model request 失败 | `weak_model_failure` |
| capsule 在执行中被证明不完整 | `capsule_invalidated` |

升级动作是原子的：

1. 追加 signal 到当前 request 状态。
2. 解析配置中的 fixed strong。
3. `await pi.setModel(strong)`。
4. 成功后进入 `strong-sticky` 并记录 model change。
5. 失败则 `ctx.abort()` 当前 agent operation（若仍活跃）、明确通知并记录 `strong_switch_failed`；不得留在 weak 上自动继续，也不得尝试其他模型。

强模型本身调用失败时明确失败，由 Pi 正常暴露 provider 错误；路由器不换第三个模型。

---

## 15. 图片处理

决策矩阵：

| 请求有图片 | weak 支持 | strong 支持 | 行为 |
|---|---:|---:|---|
| 否 | 任意 | 任意 | 走普通规则。 |
| 是 | 是 | 是 | 仍需普通规则和 classifier；可 weak。 |
| 是 | 否 | 是 | 直接 fixed strong，不调用 classifier。 |
| 是 | 是 | 否 | 配置不满足安全 fallback；active 拒绝，shadow 记录。 |
| 是 | 否 | 否 | active 明确拒绝；shadow 记录 `no_configured_image_model`。 |

分类器默认只接收图片 metadata，不接收图片内容，因此 classifier 的 `supportsImages` 不会被用于图像理解。该字段仍必须声明，以保证固定模型能力清单完整，并为未来协议变更保留显式约束。

---

## 16. Shadow/active 日志

### 16.1 存储

默认：

```text
~/.pi/agent/model-router-logs/YYYY-MM-DD.jsonl
```

每行一个 JSON object。目录和文件创建权限应尽量收紧；日志写失败只进行一次限频 warning，不中断 Pi、分类或模型请求。

### 16.2 最小记录

```json
{
  "schemaVersion": 1,
  "timestamp": "2026-07-11T12:00:00.000Z",
  "mode": "shadow",
  "sessionId": "uuid",
  "requestId": "opaque-id",
  "turnIndex": 0,
  "decisionKind": "initial",
  "admission": {
    "verdict": "eligible",
    "reasonCodes": ["capsule_complete"]
  },
  "classification": {
    "status": "ok",
    "route": "weak",
    "confidence": 0.94,
    "riskFlags": [],
    "reasonCode": "localized_explicit_task",
    "latencyMs": 12140,
    "usage": {"input": 320, "output": 28}
  },
  "targetModel": "opencode/mimo-v2.5-free",
  "actualModel": "anthropic/claude-opus-4-6",
  "reasonCodes": ["eligible_and_classifier_weak"],
  "upgradeSignals": [],
  "toolSummary": {
    "count": 0,
    "errors": 0,
    "nonzeroExits": 0,
    "operationHashes": []
  },
  "providerLatencyMs": null,
  "actualUsage": null,
  "expectedAcceptanceHit": null
}
```

Continuation 记录相同关联 id，并更新工具摘要、升级信号、actual model、usage 和 acceptance。

### 16.3 隐私约束

不得记录：

- API key、OAuth token、Authorization/header；
- 完整 prompt、完整 system prompt 或完整历史；
- 图片数据；
- 完整工具 stdout/stderr；
- 文件内容；
- 未经裁剪的 classifier 自由文本。

允许记录：reason code、模型 identity、计数、延迟、usage、exit code、相对路径类别、不可逆 hash、字节数和布尔验收结果。

---

## 17. Sub-pi 块级委派（阶段 3）

### 17.1 边界

阶段 3 注册一个可独立关闭的自包含工具，例如 `route_task_block`。它只接受完整 TaskCapsule，不接受“帮我处理一下”之类开放式字符串。

准入条件：

- `subPi.enabled=true`；
- capsule schema 严格有效；
- 单 repo/cwd，allowed write 范围明确；
- 步骤和验收完整；
- 无跨模块设计、大范围根因分析、意图冲突或长期一致性要求；
- 图片任务仅当 fixed weak 支持图片且 capsule 能明确提供图片输入时才允许；首版可以保守拒绝 child 图片委派并留在父 strong。

### 17.2 执行

```text
Parent model
   │ route_task_block(TaskCapsule)
   ▼
Extension validates capsule
   │ writes 0600 capsule/prompt/status paths
   │ starts project-prefixed tmux session
   ▼
child pi --model <fixed weak> --mode json --no-session -p @capsule.md
   │ child reads files itself; parent does not inline file contents
   │ writes/produces JSON event stream + compact summary
   ▼
Extension validates exit/artifacts/acceptance
   │ success -> compact tool result
   └ failure -> isError + parent continuation upgrades to fixed strong
```

child 必须使用配置的 weak provider/id，不动态挑选；不做 health probe。tmux session 名含项目 slug 和 task id，代理环境变量显式透传。超时、非零退出、缺产物或验收失败都明确失败，不改派其他 child 模型。

### 17.3 不做的关联增强

- child 使用 `--no-session`，不建立 parentSession。
- 不修改父 JSONL header、HTML export 或 session tree。
- 父 session 仅保留普通工具调用/结果和必要摘要。
- 不把 child 完整事件流注入父上下文。

### 17.4 与主路由解耦

- `subPi.enabled=false` 时不注册委派工具或工具立即明确不可用。
- 首轮/continuation 路由完全不调用 sub-pi。
- 删除 sub-pi 代码路径不影响 `before_agent_start`/`turn_end` 路由。

---

## 18. 命令、状态栏与恢复

命令：

```text
/routing off
/routing shadow
/routing active
/routing status
```

行为：

| 命令 | 行为 |
|---|---|
| `status` | 显示配置路径、configured/effective mode、fixed models、activation model、当前 lease、最近 reason/signal、日志目录、sub-pi 是否启用。 |
| `shadow` | 捕获 activation model；验证配置；只分类/记录；若从 active 进入则先恢复 activation model。 |
| `active` | 捕获 activation model；严格校验 strong 可解析且有凭据；启用自动切换。classifier/weak 不可用时 active 可退化为全 strong，但必须明确显示原因。 |
| `off` | 等待 idle、恢复 activation model、清理状态/状态栏，停止分类和日志副作用。 |

状态栏示例：

```text
routing:shadow · target=weak · actual=strong
routing:active · weak · turn=2/4
routing:active · strong · upgraded=verification_failed
routing:error · strong_switch_failed
```

非 TUI 模式中 UI 调用允许 no-op，但日志与路由语义保持一致。

---

## 19. 失败模式

| 失败 | 行为 |
|---|---|
| 配置缺失 | effective off；普通 Pi 不受影响。 |
| 配置 JSON/schema 错误 | effective off/error；明确错误；不部分启用。 |
| classifier model 缺失/无凭据/超时/调用失败 | fixed strong；记录 `classifier_failure`。 |
| weak model 缺失或 `setModel=false` | fixed strong；记录 `weak_unavailable`。 |
| strong model 缺失/无凭据 | 拒绝进入 active；已在 weak continuation 时则 abort 并明确失败。 |
| 模型声明支持图片但 registry 不支持 | 配置错误；不得 active。 |
| weak provider request 失败 | 下一 continuation 升级 fixed strong；不尝试其他 weak。 |
| strong provider request 失败 | 明确失败；无第三模型 fallback。 |
| 日志目录不可写/磁盘满 | 限频 warning；继续普通 Pi 和路由。 |
| classifier 输出非法 JSON | fixed strong；保留结构化错误码，不记录原始响应全文。 |
| activation model 恢复失败 | routing 关闭并标记 restore-error；不尝试候选模型。 |
| session reload/resume | 从 custom entry 恢复最小状态；按 session id 隔离；过期 request 状态清零。 |
| 用户手动 `/model` | 记录 actual model 变化；下一次路由按 mode 决策；`/routing off` 仍恢复 activation snapshot。 |
| sub-pi 非零/超时/验收失败 | 工具结果失败；父 continuation 升级 fixed strong。 |

---

## 20. 安全与隐私

1. **静态 identity**：模型 provider/id 均来自严格配置，不接受 prompt 提供的模型名。
2. **无密钥配置**：配置 schema 不允许 API key；凭据交给 Pi AuthStorage/ModelRegistry。
3. **保守失败**：classifier/weak 失败走 strong；strong 失败显式中止。
4. **规则先于模型**：hard-strong/reject 不可被 classifier 覆盖。
5. **不拦工具但持续评估**：不因工具名阻止弱模型；通过 capsule、结果和升级控制风险窗口。
6. **路径规范化**：所有 capsule 路径 realpath/resolve 后检查 repo root，拒绝 `..`、symlink escape 和空写范围。
7. **日志最小化**：不记录完整敏感 prompt、工具输出、图片或密钥。
8. **项目配置隔离**：阶段 1～3只读取 agentDir 下的用户配置，不信任 repo-controlled 模型配置。
9. **child 隔离**：临时 capsule 权限 0600、tmux 命名隔离、固定 cwd、固定模型、输出上限和超时。
10. **显式错误**：禁止空 catch；只有日志写入允许降级，但必须限频报告。

---

## 21. 关闭与完整剥离

### 21.1 运行时关闭

1. 执行 `/routing off`。
2. 确认状态显示 `off`，activation model 已恢复。
3. 确认状态栏已清空。
4. 如有 child tmux，等待结束或按记录名称显式关闭；主路由本身不依赖 child。

### 21.2 剥离

按顺序删除：

```text
extensions/model-router.ts
~/.pi/agent/model-router.json
~/.pi/agent/model-router-logs/        # 可选审计数据
```

若 Extension 安装到其他 auto-discovery 位置，删除对应副本并 `/reload`。不需要恢复 Pi 核心、修改 `plan-runner.ts`、迁移 session 或删除普通 model change。历史 JSONL 中已存在的 model change 是标准 Pi 记录，可保留。

---

## 22. 阶段边界

### 阶段 1：Shadow

包含：严格配置、model resolution、确定性规则、fixed classifier、capsule 校验、工具观察、效果评估、JSONL 日志、`/routing off|shadow|status`。

不包含：`pi.setModel()`、active 命令实际启用、sub-pi。

### 阶段 2：同 session Active

新增：`/routing active`、activation snapshot/restore、首轮切换、continuation weak lease、strong sticky、自动升级、图片路由、状态栏和 model change 验证。

### 阶段 3：Sub-pi block delegation

新增：独立配置开关、严格 capsule 工具、固定弱模型 child、tmux、摘要/状态回收、父 continuation 升级。

### 阶段 4：排除

不实施 request-scoped 临时 model API，不修改 Pi SDK/core，不创建自定义 SDK launcher。

---

## 23. 验收指标

### 23.1 阶段 1 → 阶段 2 gate

- 单元测试不调用真实模型/API，全部使用 fake classifier/registry/tool results。
- 现有 40 点数据中的 5 个危险误判全部被 deterministic/capsule gate 推到 strong。
- 新增不少于 100 个真实 shadow 决策后再评审 active；每个决策可与人工标签关联。
- 标注为 dangerous/strong 的样本 false-weak 数必须为 0。
- weak precision 目标至少 95%；weak coverage 单独报告，不以牺牲 precision 达标。
- classifier 协议有效响应率至少 99%；失败项全部可观察地转 strong。
- classifier p95 增量延迟目标不高于 15 秒；同时报告 p50/p95，不隐藏已有 11～13 秒成本。
- 日志抽检无密钥、完整 prompt、完整工具输出或图片内容。

### 23.2 阶段 2 验收

- fake harness 证明 `before_agent_start` 的 setModel 在首轮 provider request 前完成。
- fake harness 证明 `turn_end` 升级在下一 provider request 前完成。
- 注入的非零退出、tool error、scope drift、重复操作、产物缺失、验收失败、无进展和 turn cap 均 100% 升级 fixed strong。
- strong-sticky 在同一 agent run 内不降级。
- shadow 模式 `setModel` 调用次数严格为 0。
- `/routing off` 恢复 activation model 并清理状态；恢复失败明确可见。
- active 试运行中验收通过率不得低于 all-strong 基线；应报告 strong provider request 降幅，初始目标为至少 25%，但正确性 gate 优先。
- Assistant actual provider/model 与日志可对账，model change 出现在标准 session 记录中。

### 23.3 阶段 3 验收

- capsule 缺任一 cwd/scope/steps/artifact/verification 字段时拒绝委派。
- child 命令固定 `--model <configured weak>`，没有候选遍历或 health probe。
- child task 只接收 capsule，不内联父会话文件内容或完整历史。
- fake child 的非零、超时、越界、产物缺失和验收失败都返回失败并使父 continuation 升级 strong。
- `subPi.enabled=false` 时主路由全部测试仍通过。
- 不创建 parentSession/export 关联，不修改 `plan-runner.ts`。

### 23.4 最终运行 gate

- 离线单元测试、schema/fixture 测试和 Git hygiene 全部通过。
- 实际联网 smoke test 是最后一个独立、显式 gate；它的网络/provider 失败不得被报告为单元测试失败。
- smoke 只使用配置中的 classifier/weak/strong，不尝试任何候选模型。
