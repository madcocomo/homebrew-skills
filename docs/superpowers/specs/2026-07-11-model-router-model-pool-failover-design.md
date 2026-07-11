# Model Router 多模型候选池与故障转移设计

## 背景

当前 `extensions/model-router.ts` 为 classifier 和 weak 角色分别配置一个固定模型：

- classifier 不可解析、无凭据、调用失败、超时或协议解析失败时，本次路由保守回到 strong，不尝试其他 classifier；
- active 模式切换 weak 失败时保留用户模型，不尝试其他 weak；
- weak 在生成阶段失败时释放 lease，但后续请求仍会再次选择同一模型；
- `route_task_block` 只使用单个固定 weak；
- readiness 在 extension 实例内缓存，无法表达跨 session/process 的临时故障。

NVIDIA Free 模型的分类效果较好，但模型可用性、限流和响应时间不能保证。继续使用单一固定模型会导致 Router 整体无法使用，或因反复尝试故障模型造成明显延迟。

---

## 目标

1. classifier 和 weak 均支持有序的多模型配置。
2. 候选出现技术性不可用时，按配置顺序尝试下一项。
3. 故障候选按 `role/provider/id` 冷却 30 分钟，冷却期间不再尝试。
4. 冷却状态对所有 Pi session/process 生效，并在 reload、session 切换和进程重启后保持。
5. 任一必需角色没有可用候选时，Router 自动进入 `suspended`；最早冷却到期后在下一次请求自动恢复。
6. classifier fallback 同时受单候选超时和整条 fallback 链总超时约束。
7. weak 候选池同时服务 active weak lease 和 `route_task_block` child pi。
8. 保持 downgrade-only 安全语义：strong verdict 始终不干预用户模型。
9. 保持严格配置、显式 identity、无候选发现、无健康探测、无凭据落盘。

---

## 非目标

本次设计不包含：

- 自动搜索配置外的模型；
- Provider 级熔断；
- 后台定时健康探测；
- 基于价格、吞吐或动态评分重新排序候选；
- 质量失败后自动更换 weak；
- 用户手动清空冷却状态的命令；
- strong 模型池或 strong fallback；
- 在 weak 已开始生成且失败后，在同一 agent run 中再次切换 weak。

---

## 方案比较

### 方案 1：有序候选池与持久冷却

按配置顺序惰性扫描候选。冷却中、当前请求能力不匹配或技术失败的候选被跳过；技术失败写入持久冷却；所有候选耗尽后进入 `suspended`。

优点：

- 无额外探测调用；
- 故障隔离到具体角色和模型；
- 与现有严格配置和按请求路由架构一致；
- classifier、active weak 和 sub-pi 可共享选择语义。

缺点：

- 第一次遇到故障时仍需支付一次失败延迟；
- 需要持久健康状态和多进程合并逻辑。

结论：**采用本方案**。

### 方案 2：后台主动健康探测

定时调用候选模型并缓存结果。

不采用原因：探测消耗额度并可能触发 429；探测成功不保证真实请求成功；需要额外后台资源和关闭清理。

### 方案 3：Provider 级熔断

任一模型失败时冷却整个 provider。

不采用原因：粒度过粗，同一 provider 中其他模型可能仍可用，会浪费已配置 fallback。

---

## 配置设计

### 外部格式

`version` 保持为 `1`。`models.classifier` 与 `models.weak` 同时接受旧单对象和新数组格式：

```json
{
  "version": 1,
  "mode": "shadow",
  "models": {
    "classifier": [
      {
        "provider": "nvidia-free",
        "id": "z-ai/glm-5.2",
        "supportsImages": false
      },
      {
        "provider": "nvidia-free",
        "id": "deepseek-ai/deepseek-v4-pro",
        "supportsImages": false
      },
      {
        "provider": "deepseek",
        "id": "deepseek-v4-flash",
        "supportsImages": false
      }
    ],
    "weak": [
      {
        "provider": "google",
        "id": "gemini-3.5-flash",
        "supportsImages": true
      },
      {
        "provider": "opencode",
        "id": "mimo-v2.5-free",
        "supportsImages": true
      },
      {
        "provider": "opencode",
        "id": "deepseek-v4-flash-free",
        "supportsImages": false
      }
    ]
  },
  "classification": {
    "ruleProfile": "conservative-v1",
    "minWeakConfidence": 0.9,
    "timeoutMs": 20000,
    "totalTimeoutMs": 30000,
    "maxInputChars": 12000
  }
}
```

### 归一化与校验

内部统一为：

```ts
type ModelPoolConfig = {
  classifier: ModelIdentityConfig[];
  weak: ModelIdentityConfig[];
};
```

规则：

- 单对象归一化为单元素数组；
- 两个角色的数组都必须非空；
- 数组顺序即 fallback 优先级；
- 同一角色内重复的 `provider/id` 为配置错误；
- 每项继续严格要求 `provider`、`id`、`supportsImages`；
- 未知字段继续报错；
- 不从 registry 或 prompt 补充未配置候选；
- `classification.timeoutMs` 保持单候选超时语义；
- 新增 `classification.totalTimeoutMs`，默认 `30000`，作为 classifier fallback 链总预算；
- 两个 timeout 都使用明确整数范围校验。

### 实际用户配置

实施完成后，将 `~/.pi/agent/model-router.json` 更新为上例确认的候选顺序。该用户配置不提交到项目仓库。

---

## 持久冷却设计

### 文件位置与内容

冷却状态保存到：

```text
~/.pi/agent/model-router-health.json
```

概念结构：

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

### Key 与隔离范围

冷却 key 为：

```text
role/provider/id
```

因此同一 identity 作为 classifier 失败，不会自动冷却其 weak 角色。一个 provider 的某个模型失败，也不会影响该 provider 的其他模型。

### 失败原因

只保存固定枚举，例如：

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

不得保存异常正文、HTTP body、prompt、模型输出、header、环境变量或凭据。

### 读写规则

- 文件权限为 `0600`；父目录沿用 agentDir 安全边界；
- 内存保留当前进程已知冷却；
- 每次选择候选前重新读取磁盘并与内存合并，使其他 Pi 进程的冷却可见；
- 写入前重新读取现有文件、合并新记录、删除过期记录，再通过临时文件原子替换；
- 同一 key 以更晚的 `retryAfter` 为准；
- 到期记录在选择时直接忽略，并在后续成功写入时清理；
- 配置中已删除的 identity 在选择时忽略；
- 文件损坏或读写失败只发出一次限频告警；当前进程的内存冷却仍然生效；
- 健康文件故障不记录任何敏感数据，也不使普通 Pi 请求失败。

冷却时长固定为 30 分钟，不新增手动绕过冷却的命令。

---

## 候选解析与选择

### 候选状态

候选可表现为：

- `ready`
- `cooling-down`
- `not-found`
- `auth-missing`
- `image-capability-mismatch`

候选选择器按配置顺序执行：

1. 刷新持久冷却；
2. 跳过未到 `retryAfter` 的候选；
3. 对候选执行精确 registry 查找；
4. 检查配置声明与 registry 图片能力；
5. 获取 auth readiness；
6. 返回第一个 ready 候选；
7. 技术性 resolution 失败时写入冷却并继续扫描。

readiness 不再作为整个 extension 生命周期内永久不变的单模型缓存。选择发生在请求或 child invocation 边界，以反映凭据和临时可用性的变化。

### 图片能力

- `supportsImages:true` 但 registry 不含 image，视为候选配置/解析失败并进入冷却；
- 正常声明 `supportsImages:false` 的 weak 遇到图片请求时只跳过本次请求，不进入全局冷却；
- 若当前图片请求没有能力匹配的 weak，但仍存在健康的文本 weak，当前请求保守留在用户模型，Router 不进入 suspended；
- classifier 仍只接收图片 metadata，不接收图片内容。

---

## Classifier fallback

### 调用流程

Classifier 只在 deterministic admission 为 `eligible` 时调用：

```text
eligible
  → 刷新 classifier/weak 可用性
  → classifier 按顺序调用
      → 合法协议响应：停止扫描
      → 技术/协议失败：冷却并尝试下一项
      → 用户 abort：停止本次，不冷却，不继续 fallback
      → 总预算耗尽：本次 classifier_failure
```

### 进入冷却的 classifier 失败

- 模型不存在；
- auth 缺失或获取失败；
- 单候选调用超时；
- provider error / error stop reason；
- 空响应；
- 严格 JSON 协议解析失败。

### 不进入冷却且不继续 fallback

- 合法返回 `strong`；
- 合法返回低置信度 weak；
- 合法返回非空 riskFlags；
- 用户主动 abort。

合法响应代表该 classifier 已成功完成职责。是否最终允许 weak 仍由现有安全组合决定，不通过调用更多模型“投票”。

### 超时预算

每个尝试的实际 timeout 为：

```text
min(classification.timeoutMs, totalTimeoutMs 剩余时间)
```

- provider 立即失败时，可继续尝试更多候选；
- 总预算耗尽时，尚未调用的候选不进入冷却；
- 总预算耗尽得到本次 `classifier_failure`；
- 只有实际调用并发生技术/协议失败的候选进入冷却。

---

## Weak fallback 与 lease

Classifier 安全组合最终得到 weak 后，按配置顺序选择 weak：

1. 跳过冷却候选；
2. 图片请求跳过不支持图片的候选；
3. registry/auth/声明能力失败时冷却并继续；
4. `pi.setModel()` 返回 false 或抛错时冷却并继续；
5. 第一个成功切换的模型成为本次 `targetModel` 并建立 weak lease；
6. 所有适用候选耗尽时进入 suspended，保留用户模型。

Request state 必须记录实际选中的 weak identity，而不是池中的第一项。审计、target/actual mismatch 检查和状态栏均使用实际选中项。

### 生成阶段失败

若实际 weak 已经开始生成，随后 assistant stop reason 为技术性 `error`：

1. 冷却该 request 实际使用的 weak；
2. 释放 lease；
3. 恢复进入 lease 前捕获的精确用户模型；
4. 当前 agent run 不再切换到另一 weak；
5. 下一次请求从后续可用候选开始。

用户 abort 不冷却模型。

### 质量信号

以下信号继续只释放 lease，不冷却模型：

- 验收失败或缺失；
- expected artifact 缺失；
- no progress；
- repeated operation；
- weak turn limit；
- scope drift 或 scope observation uncertain；
- target/actual mismatch 中不能归因于技术性模型失败的情况。

这些信号说明任务执行效果或边界有问题，不证明模型基础设施不可用。

---

## Sub-pi fallback

`route_task_block` 使用与 active lease 相同的 weak 候选池和持久冷却。

流程：

1. child 启动前刷新 weak 冷却；
2. 选择第一个可用 weak，并把实际 identity 写入 invocation；
3. child 出现明确模型技术失败时，冷却当前 weak；
4. 在 `subPi.timeoutMs` 剩余总预算内，使用下一 weak 重新执行同一 capsule；
5. weak 候选耗尽时使 Router 进入 suspended，并返回明确错误。

`subPi.timeoutMs` 是整条 child fallback 链的总预算，不随候选数倍增。

以下任务级失败不 fallback：

- scope drift / uncertain；
- expected artifact 缺失；
- verification failed；
- child 非模型类非零退出；
- 用户 abort；
- capsule/admission 无效。

---

## Suspended 状态与自动恢复

### 状态模型

保留配置和运行模式：

```text
configured/runtime mode: off | shadow | active
```

扩展 effective state：

```text
off
shadow-ready
active-ready
suspended
restore-error
error
```

`suspended` 不是 `off`。它保留进入暂停前的 shadow/active 意图。

### 进入条件

满足任一条件时进入 suspended：

- classifier 角色没有任何非冷却且可解析的候选；
- weak 角色没有任何非冷却且可解析的候选；
- active weak 切换扫描耗尽；
- sub-pi technical fallback 扫描耗尽。

单个图片请求没有支持图片的 weak 时只保守处理该请求，不因文本 weak 仍健康而全局 suspended。

### 暂停行为

- 若存在 weak lease，先恢复 lease return model；
- 不调用 classifier；
- 不调用 `pi.setModel()` 切 weak；
- `route_task_block` 拒绝新委派；
- 普通用户请求继续使用当前用户模型；
- configured/runtime mode 保持不变。

### 自动恢复

每次新请求和 sub-pi invocation 只刷新冷却与 readiness，不发健康探测请求：

- 若最早 `retryAfter` 尚未到达，继续 suspended；
- 到期后重新精确解析候选；
- classifier 与 weak 均至少有一个通用可用候选时，恢复暂停前的 shadow/active effective state；
- 当前触发恢复的请求继续走正常路由流程；
- 若到期候选仍失败，则重新冷却 30 分钟并继续 suspended。

`/routing off` 不清除冷却。`/reload`、session 切换和新进程从健康文件恢复状态。

---

## 命令、状态栏与审计

### `/routing status`

增加：

- classifier 与 weak 的有序候选列表；
- 当前实际选中的 classifier 与 weak；
- 每个冷却候选的固定 reason、`retryAfter` 和剩余时间；
- suspended 原因和最早重试时间；
- `classification.timeoutMs` 与 `classification.totalTimeoutMs`；
- configured mode、runtime mode 与 effective state。

### 状态栏

示例：

```text
routing:active · weak=google/gemini-3.5-flash · turn=1/4
routing:suspended · retry=12m
```

### 审计日志

在现有脱敏记录上增加：

- 实际 classifier identity；
- 实际 weak identity；
- fallback attempt count；
- 固定失败码列表；
- suspended/resumed reason code。

不得记录异常正文、provider 响应、分类器自由文本、prompt、auth 或环境变量。

---

## 错误处理与安全性质

1. **无候选发现**：仅按配置 identity 精确查找。
2. **无凭据配置**：健康文件和 Router 配置均不保存 API key。
3. **降级单向性**：strong verdict 仍表示不干预用户模型。
4. **lease 精确恢复**：fallback 不改变 lease return model；释放时恢复进入 lease 前的精确模型对象。
5. **失败隔离**：按 role/provider/id 冷却，不做 provider 级熔断。
6. **用户取消优先**：abort 不冷却、不继续 fallback。
7. **能力保守**：图片能力不明确时不向 weak 降级。
8. **时间有界**：classifier 与 sub-pi 均有整条 fallback 链总预算。
9. **持久状态脱敏**：只保存 identity、时间和固定 reason。
10. **全部耗尽不阻断普通 Pi**：Router suspended，但用户当前模型继续处理请求。

---

## 测试设计

### 配置解析

- 旧单对象格式成功解析并归一化；
- 数组格式保留顺序；
- 空数组失败；
- 同角色重复 identity 失败；
- 未知字段失败；
- `totalTimeoutMs` 默认值和范围校验；
- off 模式兼容无 models 配置。

### 持久冷却

- 技术失败写入 30 分钟冷却；
- 29:59 仍跳过，30:00 重新允许；
- classifier 与 weak role 隔离；
- 不同模型互不影响；
- 磁盘与内存按更晚 retryAfter 合并；
- 写入前合并其他进程记录；
- 到期与已删除配置记录被忽略/清理；
- 文件损坏和读写失败只告警一次，当前进程冷却仍有效；
- 健康文件不包含 prompt、响应或 auth 数据。

### Classifier fallback

- not found、auth missing、provider error、timeout、空响应、无效协议后尝试下一候选；
- 合法 strong、低置信度和 riskFlags 不继续 fallback；
- abort 不冷却且不继续；
- 单候选 timeout 生效；
- total timeout 生效；
- 未尝试候选不冷却；
- 实际 classifier identity 和 fallback 次数进入脱敏审计。

### Weak fallback

- resolution/auth/setModel 失败后立即尝试下一候选；
- 实际 targetModel 是成功切换的候选；
- 图片请求跳过不支持图片者且不冷却；
- 图片无适用 weak 时保留用户模型且不全局暂停；
- 生成阶段技术错误冷却当前 weak并恢复用户模型；
- abort 和质量信号不冷却；
- lease 恢复进入前的精确模型。

### Suspended 与恢复

- classifier 池耗尽进入 suspended；
- weak 池耗尽进入 suspended；
- 暂停期间 classifier、weak setModel 和 child runner 调用均为零；
- 到期前不恢复；
- 到期并重新解析成功后，下一请求自动恢复；
- shadow/active 意图保持；
- 到期重试仍失败会重新冷却；
- off 不清除冷却。

### Sub-pi

- child 模型技术失败后使用下一 weak 重跑；
- 任务、验收、scope 和用户 abort 失败不重跑；
- `subPi.timeoutMs` 为 fallback 链总预算；
- 实际 weak identity 写入 invocation；
- 池耗尽触发 suspended。

### 回归

- deterministic strong/reject 规则优先级不变；
- classifier 安全组合不变；
- strong verdict 不调用 `setModel()`；
- shadow 不切模型；
- session shutdown 和 `/routing off` 恢复模型行为不变；
- 日志脱敏、图片矩阵、tool observation 和 acceptance 逻辑不退化。

---

## 文件范围

### 代码

- 修改 `extensions/model-router.ts`
  - 配置数组归一化；
  - 有序候选解析与选择；
  - 持久冷却存储；
  - classifier/weak/sub-pi fallback；
  - suspended 状态；
  - status 和审计扩展。

### 测试

- 修改 `tests/model-router.test.mjs`
  - 增加上述配置、冷却、fallback、超时、恢复和 sub-pi 测试；
  - 保留并适配现有单模型测试。

### 长期文档与示例

- 修改 `docs/examples/model-router.config.json`
  - 使用数组配置；
  - 增加 `classification.totalTimeoutMs`。
- 修改 `docs/pi-model-routing-design.md`
  - 将单固定模型、无 fallback 的旧约束更新为固定有序候选池；
  - 记录冷却、suspended、fallback 与安全边界。

### 用户配置

- 修改 `~/.pi/agent/model-router.json`
  - classifier 与 weak 使用已确认候选顺序；
  - 增加 `classification.totalTimeoutMs: 30000`。

不修改或提交当前工作区内与本需求无关的未跟踪文件。

---

## 验收标准

1. 旧单对象配置无需迁移即可工作。
2. 新数组配置按顺序 fallback，且只使用显式配置模型。
3. 技术故障候选在所有 Pi session/process 中 30 分钟内不再尝试。
4. classifier fallback 总耗时不超过 `totalTimeoutMs`（允许调度级小误差）。
5. weak setModel 失败可在同一请求切换到下一候选。
6. weak 生成阶段失败后恢复用户模型，并在下一请求跳过故障候选。
7. sub-pi 仅对模型技术失败更换 weak，且总时长不因候选数倍增。
8. 任一必需角色耗尽后 Router suspended，普通 Pi 请求仍由用户当前模型处理。
9. 最早冷却到期后，下一请求可自动恢复 Router。
10. `/routing status` 能解释候选、冷却、暂停和实际选模状态。
11. 所有现有 Router 测试和新增测试通过。
12. 健康状态和审计中不存在 prompt、模型响应正文、凭据或环境变量。
