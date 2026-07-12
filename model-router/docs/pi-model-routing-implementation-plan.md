# Pi 多模型自动分流实施计划

> **Execution model:** 本计划面向单个连续执行器；批准后使用 `/run-plan docs/pi-model-routing-implementation-plan.md` 启动。runner 为本仓库创建任务分支并在 `.pi/runs/...` 保存状态，只在本文明确的停止条件出现时提前退出。本任务要求不提交计划文件；执行实现时也不得修改 `extensions/plan-runner.ts`。

**Goal:** 在一个可独立关闭和删除的 Pi Extension 中实现设计文档的阶段 1～3：保守 shadow 路由、同 session active 路由，以及固定弱模型的 tmux child 块级委派。

**Architecture:** 生产逻辑集中在 `extensions/model-router.ts`，内部以短小纯函数和可注入 adapter 分隔配置、固定模型解析、capsule、准入、分类、状态机、效果评估、日志、命令及 child runner。测试集中在 `tests/model-router.test.mjs`，通过 extension harness 和 fake dependencies 驱动真实事件顺序，不调用真实模型、API 或真实 child；运行时默认 `off`，active 只临时切到 fixed weak，其他情况保留或恢复用户模型，不存在 fixed strong/fallback。

**Tech Stack:** TypeScript Pi Extension、Node.js 24、`node:test`、`assert/strict`、jiti、`@earendil-works/pi-coding-agent` 0.80.6、`@earendil-works/pi-ai/compat`、TypeBox、JSONL、tmux。

**Repo Scope:** 单仓库：`/Users/wuke/code/homebrew-skills`。

---

## 0. 计划边界与执行规则

### 只允许触碰的路径

- Create: `extensions/model-router.ts`
- Create: `tests/model-router.test.mjs`
- Create when the schema is stable: `docs/examples/model-router.config.json`
- Existing design reference, read-only: `docs/pi-model-routing-design.md`
- This plan, read-only during implementation: `docs/pi-model-routing-implementation-plan.md`

### 明确禁止

- 不修改 `extensions/plan-runner.ts` 或 `tests/plan-runner.test.mjs`。
- 不修改或删除已有无关未跟踪内容：
  - `extensions/superpowers-bootstrap.ts`
  - `tests/superpowers-bootstrap.test.mjs`
  - `using-superpowers/`
- 不实现阶段 4：不修改 Pi core/SDK，不添加 request-scoped 临时 model API，不创建自定义 SDK launcher。
- 不引入候选池、动态模型选择、health probe、熔断器、第三模型 fallback 或工具黑名单。
- 不在单元测试中联网，不调用真实 classifier/weak，不启动真实 child pi。
- 不把 prompt、工具完整输出、图片数据、环境变量、Authorization 或凭据写入日志/session state。

### 连续执行约定

- 每个 gate 均按 Red → Green → Verify 推进；目标测试第一次意外通过时，先证明测试确实覆盖新行为，再继续。
- 每个 gate 只实现通过当前测试所需的最小行为，不提前完成后续 gate。
- 每个 gate 的定向命令通过后，继续执行全量离线命令：
  - `node --test tests/model-router.test.mjs`
- 预期通过标准：退出码 `0`、`fail 0`、无未处理 rejection、无真实网络/tmux/模型调用。
- 一次有界诊断定义为：读取首个根因堆栈，修正一个直接相关原因，再重跑同一命令；仍失败则按该 gate 的停止条件报告。
- 不提交；实现执行器可以保留 runner 自身要求的任务分支，但不得执行 `git commit`。

## 1. File Structure / Responsibility Map

### Production

- Create: `extensions/model-router.ts`
  - 导出可测试的 config parser、model resolver、capsule builder/validator、admission、classifier parser/decision combiner、tool observer/evaluator、route reducer、logger formatter、child command builder。
  - 导出 `createModelRouterExtension(dependencies)` 供 fake 注入。
  - 默认导出生产 factory，绑定真实 fs、clock/id、`complete()`、`pi.exec()` 和 tmux child runner。
  - 所有 handler 只负责编排；复杂逻辑放入原则上少于 50 行的纯函数。

### Tests

- Create: `tests/model-router.test.mjs`
  - 兼容 asdf 全局安装布局的 jiti loader。
  - 提供 fake registry、fake auth、fake setModel、fake classifier、fake fs/logger、fake tool results、fake child runner、fake clock/id。
  - 提供 extension harness，捕获 handlers、commands、tools、entries、messages、status、notifications、abort 和调用顺序。
  - 测试不依赖真实 `~/.pi/agent/model-router.json`。

### Documentation/config example

- Create: `docs/examples/model-router.config.json`
  - 严格 schema 的可复制示例，`mode` 必须为 `off`。
  - 仅包含设计文档中的固定示例 identity，不包含 URL、token、key 或环境特定绝对路径。

## 2. 测试基础设施约定

测试 loader 必须按以下顺序定位包根目录：

1. `PI_CODING_AGENT_PACKAGE_ROOT`（若设置）。
2. `npm root -g` 下的 `@earendil-works/pi-coding-agent`。
3. 从 `process.execPath` 推导 asdf installs 根，再检查兄弟稳定目录 `.npm/lib/node_modules/@earendil-works/pi-coding-agent`。
4. 仅为兼容旧环境，最后尝试 `@mariozechner/pi-coding-agent`。

loader 在临时 `node_modules` 中创建以下 symlink 后复制 `extensions/model-router.ts` 并用 jiti 加载：

- 首选 `@earendil-works/pi-coding-agent`；旧包只作 fallback。
- 对应安装树里的 `@earendil-works/pi-ai`。
- 对应安装树里的 `typebox`。
- jiti 优先使用 package root 下 `node_modules/jiti/lib/jiti.mjs`；若旧布局使用 scoped nested jiti，再尝试该路径。

fake harness 的公共观测至少包括：

- `handlers: Map<string, Function[]>`，允许同事件多个 handler。
- `commands`、`tools`，支持直接调用 `/routing` handler 和 `route_task_block.execute`。
- `setModelCalls` 及全局递增 `sequence`，用于证明切换发生在 provider request 标记前。
- `classifierCalls`、`registryFindCalls`、`authCalls`、`childCalls`。
- `appendedEntries`、`sentMessages`、`statuses`、`notifications`、`abortCalls`。
- 可变的 `ctx.model`、`ctx.modelRegistry`、session branch、session id、cwd、idle 状态和 UI 能力。
- `emit(eventName,event)` 串行 await handlers；`markProviderRequest()` 只记录时序，不调用 provider。

---

## Gate 1：建立 loader、harness 与安全的缺省 off
**Goal:** 测试能在当前 asdf 布局加载新 Extension；没有配置文件时 Extension 只注册 `/routing`，不产生路由副作用。
**Files:**
- Create: `tests/model-router.test.mjs`
- Create: `extensions/model-router.ts`
**先写失败测试:**
- loader 优先找到 `@earendil-works/pi-coding-agent` 0.80.6；当前 `npm root -g` 不含包时，能命中 asdf sibling `.npm` 布局。
- factory 缺少配置文件时，`/routing` 已注册，`before_agent_start`、`turn_end`、`tool_call`、`tool_result` 不执行有效工作。
- `setModelCalls`、`classifierCalls`、日志写入、status 更新均为 `0`。
- `/routing status` 报告 config path、`configured=off`、`effective=off`，非 TUI 时不抛错。
**最小实现:**
- 定义依赖注入接口和默认 config path：`join(getAgentDir(), "model-router.json")`。
- 仅实现“文件缺失 → off”以及 `/routing status`。
- factory 始终注册命令；off 启动时不注册路由副作用 handler，或已注册 handler 立即 no-op。
**Verification:**
- Run: `node --test --test-name-pattern='loader|missing config|status off' tests/model-router.test.mjs`
- Pass: 目标测试全部 PASS；无网络、tmux、`setModel` 调用。
**Continue when:** loader 在当前机器和显式 package-root fixture 两种路径都稳定通过。
**Stop and report when:** 无法从已安装 0.80.6 获得 jiti/pi-ai/typebox，或必须增加仓库 `package.json`/`node_modules` 才能加载。
---
## Gate 2：严格配置解析、默认值与固定 identity
**Goal:** 只接受设计文档 version 1 schema；任何部分错误都使有效状态成为 `off/error`。
**Files:**
- Modify: `extensions/model-router.ts`
- Modify: `tests/model-router.test.mjs`
- Create after tests pass: `docs/examples/model-router.config.json`
**先写失败测试:**
- 接受完整 `off|shadow|active` 配置，并应用仅限设计文档表格中的可选默认值。
- 文件缺失仍为普通 `off`；JSON 语法错误为 `off/error` 且含明确但不泄密的错误。
- 根对象、models、三个 role、classification、limits、logging、subPi 任一级未知字段都拒绝。
- `version !== 1`、非法 mode、空 provider/id、缺 role、URL/token/apiKey 字段、非布尔 `supportsImages` 都拒绝。
- confidence 非有限数或不在 `[0,1]`，timeout/turn/count 非正整数或越界，空 logging directory 均拒绝。
- `shadow`/`active` 不因缺字段使用部分配置；identity 永远没有默认值。
- `~` 日志路径只展开受支持的 leading `~/`；默认日志目录来自 `agentDir`。
**最小实现:**
- 手写 exact-key validator 或等价严格 parser；不要引入新的运行时依赖。
- 返回判别联合：`missing | valid | invalid`，invalid 不携带部分可执行 config。
- 为数字定义显式实现范围，并在错误中输出字段路径，不输出原始 JSON。
- 新增 `docs/examples/model-router.config.json`，内容对应设计示例且 `mode: "off"`。
**Verification:**
- Run: `node --test --test-name-pattern='config|defaults|unknown field|identity' tests/model-router.test.mjs`
- Run: `node -e "JSON.parse(require('node:fs').readFileSync('docs/examples/model-router.config.json','utf8')); console.log('ok')"`
- Pass: parser matrix 全绿；example 输出 `ok` 且不含 secret-like 字段。
**Continue when:** invalid config 下 classifier、logger、setModel 均保持零调用。
**Stop and report when:** 设计 schema 存在两种同样合理但行为不同的解释，或需要增加设计外字段。
---
## Gate 3：固定模型解析、auth 与图片声明交叉检查
**Goal:** 只解析配置指定的 classifier/weak，绝不搜索替代模型。
**Files:**
- Modify: `extensions/model-router.ts`
- Modify: `tests/model-router.test.mjs`
**先写失败测试:**
- fake registry 只收到两个精确 `find(provider,id)`；没有 `getAll()`、候选遍历或模糊匹配。
- registry model `input` 含 `image` 且声明 true 时通过；声明 false 时仍保守视为不支持。
- 声明 true 而 registry 缺 `image` 为配置错误。
- active 要求 classifier/weak 均可解析且 auth `ok`；任一缺失或无凭据时拒绝 active。
- shadow 仍解析固定模型并记录 readiness，但不调用 `pi.setModel()`。
**最小实现:**
- 实现 `resolveConfiguredModels(config, registry, mode)` 和 `resolveAuth`。
- 使用 `ctx.modelRegistry.find()`、`getApiKeyAndHeaders()`；不把 auth 放进状态、日志或 error details。
- readiness 只保存 role identity、能力布尔和 reason code。
**Verification:**
- Run: `node --test --test-name-pattern='model resolver|auth|image capability|degraded' tests/model-router.test.mjs`
- Pass: 所有 registry 调用与配置 identity 完全相等，候选发现调用为零。
**Continue when:** classifier/weak 的不可用路径始终阻止 active，且 resolver 不存在 strong role。
**Stop and report when:** 0.80.6 的 registry/auth 返回契约与测试假设不同；先读取本机 `.d.ts` 并报告，不以 `any` 静默绕过。
---
## Gate 4：Task capsule 构造、严格校验与路径约束
**Goal:** 只从可信 cwd 和用户显式约束构造 capsule；缺字段或路径逃逸时不能进入 weak。
**Files:**
- Modify: `extensions/model-router.ts`
- Modify: `tests/model-router.test.mjs`
**先写失败测试:**
- 完整显式任务产生 version 1 capsule：objective、绝对 cwd/repositoryRoot、allowedRead/Write、forbidden、steps、artifacts、verification。
- cwd/repositoryRoot 来自 ctx，不接受 prompt 覆盖；模型名也不从 prompt 读取。
- 缺 objective、空 allowedWrite、缺 steps/artifact/verification、冲突约束均判 incomplete。
- `..`、绝对外部路径、空前缀和 symlink escape 判 `invalid_capsule_scope`。
- objective/steps 可压缩，但不能扩大 allowed scope 或新增验收命令。
- 普通自然语言无法可靠提取 scope 时保守返回 `scope_ambiguous`，不让 classifier 补全。
- capsule session message/日志视图不包含文件内容或完整 prompt。
**最小实现:**
- 将“提取显式事实”和“验证 capsule”分成两个纯函数。
- 仅识别明确路径、编号步骤、明确产物及 shell command/postcondition；不确定文本不猜测。
- 使用 `resolve` 加可注入 `realpath` 检查 repositoryRoot 包含关系和 symlink。
- 生成 opaque task/request id；不包含原始 prompt hash 以外的可逆内容。
**Verification:**
- Run: `node --test --test-name-pattern='capsule|path escape|explicit facts' tests/model-router.test.mjs`
- Pass: 所有越界样例 reject，所有不完整样例 strong，完整样例字段与显式输入一致。
**Continue when:** capsule builder 的任何不确定性只会收紧权限或走 strong。
**Stop and report when:** 必须依赖 LLM 才能补齐 cwd/scope/acceptance，或真实路径检查需要越过 repo root。
---
## Gate 5：确定性准入与图片决策矩阵
**Goal:** classifier 之前先完成设计文档的 hard reject/strong/eligible 判定。
**Files:**
- Modify: `extensions/model-router.ts`
- Modify: `tests/model-router.test.mjs`
**先写失败测试:**
- 表驱动覆盖全部 reason code：图片、输入超限、scope/acceptance 缺失、broad design、cross boundary、long horizon、intent ambiguity、sensitive/irreversible、invalid scope。
- 优先级固定为 `reject > strong > eligible`；多个规则同时命中时 reasonCodes 稳定排序且不被 classifier 改写。
- `edit`、`write`、Git、进程重启本身不触发 strong。
- 单 repo、局部明确、完整 capsule、图片兼容时返回 `eligible + capsule_complete`。
- 五个危险回归类别至少覆盖：开放式根因分析、跨模块架构、共享状态长链、敏感/不可逆、冲突意图；fake classifier 即使返回高置信 weak 也不得放行。
- 图片矩阵与设计一致；weak 不支持图片时 strong verdict 表示不干预，classifier 调用为零。
**最小实现:**
- 实现纯函数 `evaluateAdmission(input)`，每个规则输出固定枚举 code。
- 把图片判断置于 classifier 前；weak 不支持图片时 active 不切模型，shadow 仅记录。
- 将设计中的五类危险回归样例内联为 tests fixture；若后续取得原 40 点 corpus，再无损替换为原始样本。
**Verification:**
- Run: `node --test --test-name-pattern='admission|dangerous regression|image matrix' tests/model-router.test.mjs`
- Pass: dangerous false-weak 为 `0`；hard rule 下 classifier 调用严格为 `0`。
**Continue when:** 所有规则只允许从 eligible 向 strong/reject 收紧。
**Stop and report when:** 原实验五条具体输入可取得但与当前代理类别不一致；保存失败样例并升级设计评审，不修改规则来追求 coverage。
---
## Gate 6：严格 classifier JSON 协议与安全组合
**Goal:** 仅对 eligible capsule 调用一次 fixed classifier，并严格解析唯一 JSON object。
**Files:**
- Modify: `extensions/model-router.ts`
- Modify: `tests/model-router.test.mjs`
**先写失败测试:**
- classifier input 只有 protocolVersion/requestId、bounded excerpt、cwd、图片 metadata、显式 paths/steps/artifacts/verification、deterministic reason codes。
- input 不含图片二进制、环境变量、auth、历史、工具输出；超过 maxInputChars 直接 strong。
- 只接受无 fence/无前后缀/无额外字段的单一 JSON object。
- route 枚举、finite confidence、riskFlags 固定枚举、reasonCode 固定枚举、protocolVersion 全部严格校验。
- `weak + confidence >= threshold + no flags` 才 weak；strong、低置信、任一 risk 均 strong。
- malformed、timeout、abort、model/auth 缺失、provider error、空文本均为 `classifier_failure → strong verdict/no intervention`。
- 每次 initial eligible 决策最多一次 classifier call，不调用第二 classifier。
**最小实现:**
- 导出 `parseClassifierResponse(text)`、`combineRouteDecision(admission,classification,threshold)`。
- production adapter 用 `@earendil-works/pi-ai/compat` 的 `complete()`，先从 registry 获取 fixed classifier auth，并传 timeout/AbortSignal。
- 响应只提取 text blocks；错误只保留枚举和裁剪消息，不保留原文。
**Verification:**
- Run: `node --test --test-name-pattern='classifier protocol|classification input|classifier failure' tests/model-router.test.mjs`
- Pass: malformed matrix 全部 strong；fake classifier 是唯一模型调用点。
**Continue when:** 任意无法证明安全的 classifier 响应都得到 strong verdict，且不会调用 `setModel()`。
**Stop and report when:** 需要放宽 JSON 语法、枚举或额外字段才能兼容某 provider；这属于协议变更。
---
## Gate 7：阶段 1 Shadow 编排与 JSONL 审计
**Goal:** 完成首轮 shadow 决策、工具观察和 continuation 记录，同时保证 `setModel` 永远不被调用。
**Files:**
- Modify: `extensions/model-router.ts`
- Modify: `tests/model-router.test.mjs`
**先写失败测试:**
- `before_agent_start` 重置 request state，生成 requestId，执行 admission/classifier，记录 initial 决策。
- shadow 的 target 可为 weak/strong/reject，但 actual 来自当前/Assistant model，`setModelCalls === 0`，不注入 capsule message。
- `tool_call` 仅记录 normalized fingerprint/path，不 block、不改写 input。
- `tool_result` 仅记录 error、已裁剪统计和必要 exit signal，不改写 result。
- `turn_end` continuation 与 initial 使用同 requestId，包含 actual provider/model、usage、tool summary、acceptance；不重复 classifier。
- JSONL schemaVersion 1 字段与设计最小记录一致；不出现 prompt、tool stdout/stderr、图片 data、auth/header/key。
- 日志目录按日期写 JSONL，目录/文件 mode 尽量为 `0700/0600`。
- mkdir/append/disk-full 失败只限频 warning 一次，决策和普通 Pi 继续。
**最小实现:**
- 实现 audit record formatter 与 injectable best-effort logger。
- 使用不可逆 operation hash、计数、字节数、相对路径类别；reason 裁剪到 maxReasonChars。
- 在 handler 内 catch 仅包围 logger，并调用 rate-limited warning；其他错误显式处理。
**Verification:**
- Run: `node --test --test-name-pattern='shadow|audit|redaction|log failure' tests/model-router.test.mjs`
- Pass: 所有 shadow 流程 `setModelCalls === 0`；日志泄漏关键字扫描为空；日志失败测试仍 PASS。
**Continue when:** phase 1 离线功能全绿且主路由不依赖 sub-pi。
**Stop and report when:** 为写日志必须记录完整 prompt/tool output，或日志失败传播到事件 handler。
---
## Gate 8：效果信号、进展与升级判定纯函数
**Goal:** 将工具 batch 归一化为设计中的进展、验收和升级信号，为 active continuation 做准备。
**Files:**
- Modify: `extensions/model-router.ts`
- Modify: `tests/model-router.test.mjs`
**先写失败测试:**
- `isError=true` → `tool_error`；bash 非零（0.80.6 由 error result/`Command exited with code N` 表达）→ `nonzero_exit`，验证命令则 `verification_failed`。
- 显式 path 超 allowed scope → `scope_drift`；bash/git 无法可靠推断 cwd/path → `scope_observation_uncertain`。
- 同一 normalized operation 超 limit → `repeated_operation`；不同参数不误计。
- 新 artifact、新修改目标、步骤信号、首次成功 verification、首次明确阻塞分别计 progress。
- 重复读、重复失败命令、同参 edit/write、无新状态不计 progress；连续到 limit → `no_progress_limit`。
- artifact 缺失、verification 未执行/失败、postcondition 不满足、weak turn cap、actual mismatch、weak model failure、capsule invalidation 均产生对应 signal。
- 无工具 batch时返回“run ends/no continuation”，不提前切换。
**最小实现:**
- 实现 `fingerprintOperation`、`observeScope`、`evaluateToolBatch`、`checkExpectedArtifacts`。
- 只检查 capsule 显式 artifact/postcondition；fs 检查失败形成信号而非假装成功。
- signal 使用 Set 保持去重和稳定顺序；observer 不执行工具拦截。
**Verification:**
- Run: `node --test --test-name-pattern='effect evaluator|progress|scope drift|weak turn' tests/model-router.test.mjs`
- Pass: 设计第 14 节的每个升级 code 至少一个正例，关键 code 至少一个反例。
**Continue when:** evaluator 完全是确定性逻辑，且 continuation 不调用 classifier。
**Stop and report when:** 0.80.6 无法观测某信号且不能从 `tool_call`、`tool_result`、`turn_end` 组合可靠推导；记录能力缺口，不解析任意自由文本冒充可靠信号。
---
## Gate 9：阶段 2 Active 首轮切换与 weak lease 生命周期
**Goal:** 在同一 session 内只临时切换到配置 weak，并在 lease 结束时恢复进入 lease 前的用户模型。
**Files:**
- Modify: `extensions/model-router.ts`
- Modify: `tests/model-router.test.mjs`
**先写失败测试:**
- active initial weak：先捕获 `ctx.model` 的精确对象，再 await `setModel(fixed weak)`；harness 才允许 `markProviderRequest()`。
- active initial strong/hard rule/classifier failure：不调用 `setModel()`，保留用户当前模型。
- weak setModel false/throw：保持原模型、不创建 lease、不试其他模型。
- weak initial 返回隐藏 `model-router-capsule` custom message；shadow/off 不返回。
- weak healthy tool batch 保持 lease，不重复 setModel/classifier。
- 任一 effect signal/cap 在 `turn_end` 返回前恢复该 lease 捕获的 return model。
- weak response `error`/`aborted` 即使无工具 batch 也恢复；正常 `agent_end` 总是恢复。
- 用户在任务之间手工换模后，下一 lease 捕获新模型；恢复失败 warning、结束 lease且不 fallback。
**最小实现:**
- route state 仅为 `undecided | weak-lease`；request 内保存进程内 `leaseReturnModel`。
- 唯一 downgrade actuator 只接受 resolved configured weak；release actuator 只接受当前 lease 捕获的精确模型对象。
- `before_agent_start` 返回 capsule message；`turn_end` 无工具且正常结束时由 `agent_end` 恢复。
**Verification:**
- Run: `node --test --test-name-pattern='active initial|weak lease|agent_end restores|no-tool weak model error|provider order' tests/model-router.test.mjs`
- Pass: harness sequence 证明 weak switch 和 signal restore 均早于对应 provider request；每个 lease 恢复自己的 return model。
**Continue when:** active 不存在 fixed strong/fallback 路径，shadow `setModel` 始终为零。
**Stop and report when:** 实际 Pi 生命周期无法保证 awaited handler 先于 provider request；不得改用阶段 4 API。
---
## Gate 10：activation snapshot、`/routing` 命令、状态栏与恢复
**Goal:** 支持 `off|shadow|active|status` 运行时切换，关闭后恢复启用前模型并清理状态。
**Files:**
- Modify: `extensions/model-router.ts`
- Modify: `tests/model-router.test.mjs`
**先写失败测试:**
- 首次 off→shadow/active 捕获当前 provider/id，后续模式切换不覆盖 snapshot。
- `/routing active` 严格验证 classifier/weak；任一不可用则拒绝 active。
- `/routing shadow` 从 active 进入时先 `waitForIdle()`、恢复 activation model，再进入 log-only。
- `/routing off` 等待 idle、恢复 activation model、清 lease/fingerprints/capsule/signals/status，并 append 最小 state。
- 恢复模型缺失/无 auth/setModel false 时 routing 仍关闭，但显示 `restore-error`，不尝试其他模型。
- 非法参数给 usage；`status` 展示 config path、configured/effective mode、fixed roles、snapshot、lease、last reason/signal、log dir、subPi enabled，不展示 auth。
- status bar 文本覆盖 shadow target/actual、active weak turn、lease released/error；`off` 清空。
- 首次启用仅注册一次 handler；反复 off/on 不重复处理事件。
**最小实现:**
- 实现 command parser、one-time handler guard、activation snapshot 和 UI formatter。
- command context 中调用 `await ctx.waitForIdle()`；事件 handler 内不调用该命令专属 API。
- 非 UI 模式让 notify/status 成为 no-op，但保留状态/日志语义。
**Verification:**
- Run: `node --test --test-name-pattern='/routing|activation|restore|status bar|one-time' tests/model-router.test.mjs`
- Pass: 模式转换矩阵全绿；off 后所有路由 side effect 为零。
**Continue when:** 运行时 off 可完全停止分类、日志和状态栏副作用。
**Stop and report when:** 关闭需要恢复一个未配置候选模型，或必须修改配置文件才能完成命令覆盖。
---
## Gate 11：session state 最小持久化与恢复
**Goal:** reload/resume 后恢复必要路由状态，隔离 session，并清理过期 request 的瞬态数据。
**Files:**
- Modify: `extensions/model-router.ts`
- Modify: `tests/model-router.test.mjs`
**先写失败测试:**
- `pi.appendEntry("model-router-state", ...)` 只含 runtime mode、activation identity、request id、route state、最近升级 reason；不含 prompt/tool/capsule/auth/log payload。
- `session_start` 只从当前 branch 最后一个合法同 schema entry 恢复；malformed/旧 schema 忽略并 warning。
- resume 恢复 mode/snapshot，但清 weak lease return object、noProgress、operationCounts、tool observations、旧 capsule 和过期 request evaluator。
- 新 session id 不继承另一个 session 的内存状态。
- restored off/restore-error 不启动分类；restored shadow 永不 setModel。
- 用户手动 `model_select` 更新 actual observation，但不覆盖 activation snapshot；下一路由按 mode 决策。
**最小实现:**
- 定义 versioned `PersistedRouterState` strict parser。
- 在模式变化和关键 route transition append 最小 entry；不在每个 tool result 写 entry。
- `session_start` 先 reset in-memory state，再读取 `ctx.sessionManager.getBranch()`。
**Verification:**
- Run: `node --test --test-name-pattern='state persistence|resume|session isolation|manual model' tests/model-router.test.mjs`
- Pass: serialization allowlist 精确相等；跨 session fixture 无污染。
**Continue when:** session 文件中的 custom entry 不参与 LLM context，capsule 仅通过 active custom message注入。
**Stop and report when:** 恢复正确性要求持久化完整 prompt、工具输出或凭据。
---
## Gate 12：阶段 1/2 集成矩阵与 rollout hold
**Goal:** 用 fake harness 证明 shadow/active 的完整生命周期，并把设计中的 phase 1→2 生产启用指标设为明确发布门。
**Files:**
- Modify: `tests/model-router.test.mjs`
- No production change unless a failing integration test exposes a bounded defect.
**先写失败测试:**
- 一次完整 shadow run：initial eligible→weak target、两个工具 continuation、acceptance，classifier 一次、setModel 零次、关联 id 一致。
- 一次 active success run：initial weak、healthy continuation、结束；actual/usage/model change 观测可对账。
- 参数化注入 nonzero、tool error、scope drift、uncertain bash、repeat、artifact missing、verification failed、no progress、turn cap，均在下一 request 前恢复 lease return model。
- weak switch failure、lease restore failure、off restore failure、logging failure均不产生隐式 fallback。
- config mode 默认为 off；example 复制后若不改 mode 不会切模型。
**最小实现:**
- 只补齐 harness integration helpers和缺失断言；禁止借此重构无关代码。
- 在测试说明中区分“代码具备 active”与“生产允许 active”。
**Verification:**
- Run: `node --test tests/model-router.test.mjs`
- Pass: 全部离线测试 PASS；shadow `setModel=0`；每个注入的 lease 释放率 `100%`。
**Continue when:** 可以继续实现阶段 3，但生产配置仍保持 `off` 或 `shadow`。
**Production rollout hold:**
- 在任何真实环境把 mode 改成 active 前，必须另行收集不少于 100 个 shadow 决策并人工标注。
- dangerous/strong false-weak 必须为 0，weak precision ≥95%，协议有效率 ≥99%，classifier p95 增量 ≤15 秒，并报告 p50/p95、coverage 和日志隐私抽检。
- 未达到任一指标时停止 active rollout；这不应被报告为离线单元测试失败。
**Stop and report when:** 离线矩阵有任何 false-weak，或必须放宽 hard rules 才能提高 weak coverage。
---
## Gate 13：阶段 3 工具注册与严格 child capsule 准入
**Goal:** `subPi.enabled=true` 时提供独立 `route_task_block`，只接受完整 capsule；关闭时不影响主路由。
**Files:**
- Modify: `extensions/model-router.ts`
- Modify: `tests/model-router.test.mjs`
**先写失败测试:**
- `subPi.enabled=false` 时工具未注册或立即明确 unavailable；阶段 1/2 全套测试仍通过。
- enabled 时工具 schema 严格要求完整 TaskCapsule，不接受开放式 `task: string` 或额外字段。
- 缺 cwd/scope/steps/artifact/verification 任一字段、跨 repo、scope escape、broad design、长期一致性、冲突意图均拒绝且 childCalls 为零。
- parent cwd 与 capsule cwd/repositoryRoot 必须一致；allowedWrite 非空。
- 首版图片 child 委派保守拒绝并留给 parent strong，不发送图片内容。
- `maxConcurrent=1`：已有 child 时第二个任务明确失败，不并行写冲突。
**最小实现:**
- 使用 TypeBox 精确声明工具参数，字符串枚举使用 `StringEnum`。
- execute 内复用同一个 capsule validator/admission，不创建较宽松的 child 专用规则。
- 通过注入 `ChildRunner` 解耦生产 tmux 与测试 fake。
**Verification:**
- Run: `node --test --test-name-pattern='route_task_block|subPi disabled|child admission|concurrency' tests/model-router.test.mjs`
- Pass: 所有拒绝路径 childCalls 为零；subPi disabled 时主路由结果与 Gate 12 相同。
**Continue when:** 删除/禁用 child adapter 不改变 before_agent_start/turn_end handler。
**Stop and report when:** 工具 schema 需要接收完整父历史、文件内容或动态模型 identity。
---
## Gate 14：固定弱模型 tmux child runner 与私密工作文件
**Goal:** production child runner 通过项目前缀 tmux 启动固定 weak、等待状态并回收紧凑结果。
**Files:**
- Modify: `extensions/model-router.ts`
- Modify: `tests/model-router.test.mjs`
**先写失败测试:**
- fake child runner 收到的 model 精确为 configured weak provider/id；无 candidate list、health probe 或 strong child fallback。
- 生成项目 slug + task id 的 tmux session 名，字符白名单且长度有界。
- capsule/prompt/run script/status/result/summary 位于专用临时目录；目录 `0700`、敏感文件 `0600`。
- run script 使用 zsh、`source "$HOME/.zshrc"`，固定 cwd，并执行：`pi --model <provider/id> --mode json --no-session -p @<capsule.md>`。
- tmux `new-session -d`，显式透传大小写 proxy/no_proxy 变量；参数通过 argv/shellQuote，恶意 task id/path 不可注入。
- child 自行读取允许文件；capsule.md 不内联父 session、文件内容、完整历史或 auth。
- timeout、abort 和 session 消失可终止轮询；清理动作只针对记录的 session/temp dir。
**最小实现:**
- 实现 `buildChildInvocation`、`writeChildFiles`、`runTmuxChild`，轮询有界且使用 injected clock/sleep。
- 用 `pi.exec("tmux", argv)` 启动和检查；长运行进程只存在于 tmux，不使用裸后台 `&`。
- 子输出只读取 compact summary/status；完整 JSON event stream不注入父上下文。
**Verification:**
- Run: `node --test --test-name-pattern='child invocation|tmux|0600|proxy|shell injection' tests/model-router.test.mjs`
- Pass: snapshot argv/script 只包含 fixed weak；权限断言通过；测试未调用真实 tmux/pi。
**Continue when:** child runner 在无网络测试中完全由 fake fs/exec/clock 驱动。
**Stop and report when:** 必须使用 `--session`/parentSession、修改 export/session tree，或直接执行长运行 `pi` 而非 tmux。
---
## Gate 15：child 结果验收、父 weak lease 释放与独立剥离
**Goal:** child 的任何执行/验收失败都成为工具错误，并在父 continuation 释放 weak lease；成功只返回紧凑摘要。
**Files:**
- Modify: `extensions/model-router.ts`
- Modify: `tests/model-router.test.mjs`
**先写失败测试:**
- fake child success + artifacts + verification 通过：工具返回 compact content/details，不包含完整 event stream。
- nonzero、timeout、abort、scope drift、artifact missing、verification missing/fail 分别明确失败。
- 因 Pi 0.80.6 工具返回值不能直接设置 `isError`，失败路径必须 throw；harness 转换为 `tool_result.isError=true`。
- parent weak lease 收到 child tool error 后，`turn_end` 在下一 provider request 前恢复其 lease return model。
- child 失败不启动另一个 child model，也不把任务改派任何 fixed strong/fallback。
- timeout/结束后释放 concurrency slot；清理失败只 warning，不覆盖主要 child failure。
- `subPi.enabled=false`、删除工具注册分支或删除整个 Extension 的剥离检查均不要求修改 `plan-runner.ts`/Pi core。
**最小实现:**
- 实现 child result validator，复用 artifact/verification/scope evaluator。
- execute 成功返回受限 summary；失败抛出只含 task id/reason code 的 Error。
- tool observer 把 `route_task_block` 的 isError 纳入 `tool_error/weak_model_failure` lease-release 路径。
**Verification:**
- Run: `node --test --test-name-pattern='child result|child failure|parent weak lease|subPi cleanup' tests/model-router.test.mjs`
- Pass: 所有 child 失败案例 parent weak lease 释放率 `100%`；child model 调用 identity 集合只有 fixed weak。
**Continue when:** 阶段 3 可通过单个配置开关关闭，主路由无 child 依赖。
**Stop and report when:** child 失败后无法让 Pi 产生 `isError=true`，或父 continuation 不能观测该结果。
---
## Gate 16：离线全量、类型/加载兼容、隐私与 Git hygiene
**Goal:** 在不联网的情况下完成最终工程验证，并证明只修改批准路径。
**Files:**
- Verify only; bounded fixes limited to:
  - `extensions/model-router.ts`
  - `tests/model-router.test.mjs`
  - `docs/examples/model-router.config.json`
**先写失败测试:**
- loader 明确断言首选包名为 `@earendil-works/pi-coding-agent`，legacy 仅 fallback。
- 默认 export 能通过 jiti 加载；生产依赖注入点不会在 import 时读配置、联网或启动进程。
- exported pure functions 和 factory 在 0.80.6 类型/API 形状下可加载。
- secret scan fixture 覆盖 `apiKey`、Bearer、OAuth token、env、prompt、stdout/stderr、image base64。
- source scan 确认没有候选遍历/health probe/request-scoped API/plan-runner import。
**最小实现:**
- 只修复验证暴露的直接问题；不重构无关模块。
- 若没有独立 TypeScript project，不新增仓库级 config；以 jiti import + Node tests 作为加载/type surface 验证。
**Verification:**
- Run: `node --test tests/model-router.test.mjs`
- Run: `node --test tests/plan-runner.test.mjs`
- Run: `rg -n 'apiKey|Authorization|Bearer|token|image.*data|promptExcerpt|stdout|stderr' extensions/model-router.ts docs/examples/model-router.config.json`
- Run: `rg -n 'plan-runner|request-scoped|health.?probe|getAll\(' extensions/model-router.ts`
- Run: `git diff --check`
- Pass:
  - 两个测试文件分别退出 `0`；model-router 测试无真实网络/tmux。
  - secret/source scan 的命中均可解释为 validator 禁止项、类型字段或测试安全检查，不存在 secret value/候选逻辑。
  - `git diff --check` 无输出。
**Continue when:** 所有离线验证有新鲜输出证据。
**Stop and report when:** 现有 plan-runner 测试因本任务改动失败，或修复需要修改允许列表以外文件。
---
## Gate 17：最终独立联网 smoke（不与单元测试混报）
**Goal:** 仅在用户显式提供安全测试配置和授权后，验证真实 fixed classifier/weak 基本连通及用户模型恢复；该 gate 独立于离线验收。
**Files:**
- 不修改仓库文件。
- 使用用户目录的临时配置副本和临时日志目录；结束后恢复原配置/模型。
**先写失败测试:**
- 在仓库外临时目录创建 smoke assertion script：要求 eligible/hard-strong 两条关联日志、shadow `model_change=0`、模型 identity 仅来自配置、日志敏感字段扫描为空。
- 先对空结果目录运行并确认非零退出，证明 checker 会拒绝缺失证据；不得把真实联网调用加入 `node:test`。
**Preconditions:**
- Gate 16 全绿。
- 用户明确允许联网和 provider 成本。
- 配置严格指定 classifier/weak，`mode` 初始为 `shadow`；不得把 key 写入配置。
- 先记录 activation model，并准备 `/routing off` 恢复步骤。
**最小实现:**
- 不改生产代码；只在临时目录创建 capsule、smoke task、assertion script 和结果目录，使用现有 Extension 完成一次最小观察。
**Smoke steps:**
- 用 tmux 启动一次隔离 Pi smoke session，不直接在前台运行长任务。
- 发送一个明确 eligible 的无图片 capsule 和一个 hard-strong fixture。
- 验证 shadow：产生两条可关联 JSONL、classifier 只在 eligible case 调用、`setModel` 不发生。
- 只有 production rollout hold 已满足且用户再次允许时，短暂 active：验证首轮 fixed role 和 `/routing off` 恢复。
- 若 `subPi.enabled` 被显式允许，再执行一个只读/临时产物 child capsule，确认命令使用 fixed weak 和 `--no-session`。
- 结束时 `/routing off`，检查状态栏清理，关闭本次记录的 tmux session，恢复原用户配置。
**Verification:**
- Run in project-prefixed tmux: `pi -e ./extensions/model-router.ts --mode json -p @<smoke-task-file>`
- Pass: 只出现配置中的 classifier/weak identity 及用户当前模型；shadow 不切模型；active（若获批）可恢复每个 lease 的 return model；日志不含敏感正文。
**Failure classification:**
- 网络、DNS、rate limit、provider 5xx、模型不可用、凭据缺失属于 `SMOKE BLOCKED/FAILED`，不得改写为单元测试失败。
- classifier 协议错误应记录 `classifier_failure → no intervention`；不得尝试第二模型。
- weak 不可用时 active smoke 保持用户模型；不得尝试 fallback。
**Stop and report when:** 未获联网/成本授权、需要健康探针/候选 fallback、需要把 secret 写入文件，或清理/恢复失败。
---

## 3. 最终 Git 边界检查

在任何完成声明前执行并保存输出：

```bash
git status --short
git diff -- extensions/model-router.ts tests/model-router.test.mjs docs/examples/model-router.config.json
git diff -- extensions/plan-runner.ts tests/plan-runner.test.mjs
git diff --check
```

通过标准：

- 本实现只新增/修改：
  - `extensions/model-router.ts`
  - `tests/model-router.test.mjs`
  - `docs/examples/model-router.config.json`（若按 Gate 2 创建）
- `extensions/plan-runner.ts` 和 `tests/plan-runner.test.mjs` diff 为空。
- 任务开始前已有未跟踪项原样存在且内容未变：
  - `docs/pi-model-routing-design.md`
  - `extensions/superpowers-bootstrap.ts`
  - `tests/superpowers-bootstrap.test.mjs`
  - `using-superpowers/`
- 不提交，不清理、不 add、不 stash 上述无关文件。

若 status 出现允许列表以外的新变化：立即停止，先用只读 diff 确认来源；不得自动 reset、checkout、clean 或覆盖用户工作。

## 4. 完成定义

只有以下条件全部满足才能报告阶段 1～3“实现完成”：

- Gate 1～16 的离线验证全部有新鲜 PASS 输出。
- 默认/缺配置为 off；shadow `setModel` 次数严格为 0。
- active 只在 `before_agent_start` 切 fixed weak，并在 `turn_end`/`agent_end` 恢复 lease return model。
- deterministic + classifier + capsule + image + lease-release 五重安全门均有回归测试。
- 所有指定执行失败信号都会释放 weak lease；恢复失败明确 warning 且不 fallback。
- session state、JSONL 和 child summary 均通过隐私 allowlist。
- `/routing off` 恢复 activation model并清状态；恢复失败明确显示且不 fallback。
- sub-pi 只使用 fixed weak tmux child，失败触发父 weak lease 释放，可独立关闭/删除。
- 阶段 4、Pi core/SDK、`extensions/plan-runner.ts` 完全未触碰。
- 最终 Git hygiene 符合第 3 节。
- Gate 17 若未授权或因网络/provider 失败，应单独报告为“未运行/blocked”，不影响离线完成结论；但不得声称真实 provider smoke 已通过。
