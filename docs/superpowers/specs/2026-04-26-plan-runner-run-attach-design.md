# plan-runner 绑定已有 run 命令设计

## 背景

`plan-runner` 当前已经支持：

- `/run-plan`
- `/run-status`
- `/run-summary`
- `/run-merge`
- `/run-promote-docs`
- `/run-stop`

但当前 session 的 run 绑定依赖 session 自身保存的 `activeRun`。当用户切到一个没有绑定任何 run 的 session 时，即使当前工程下已经存在 `.pi/runs/...` 历史 run，也无法把当前 session 重新绑定到这些 run，再继续执行 `run-status`、`run-summary`、`run-stop`、`run-merge` 等命令。

用户需要一个显式命令来把当前 session 绑定到**当前工程下已有的 run 实例**，并且：

1. 允许绑定运行中的 run
2. 绑定对象是 run 实例，而不是 plan 抽象
3. 不允许跨工程绑定其它工程的 run
4. 能在没有参数时列出可绑定 run，也能直接输入名称或标识进行绑定

---

## 目标

新增一个命令：

- `/run-attach`

满足以下行为：

1. **只在当前工程作用**
   - 只扫描当前 project root 下的 `.pi/runs/`
   - 不读取其它工程的 `.pi/runs`
   - 不做跨工程绑定

2. **绑定对象是 run 实例**
   - 无参数时列出当前工程可绑定的 run 实例
   - 每个候选项展示 `runId / 状态 / 时间 / plan / branch`

3. **允许绑定运行中的 run**
   - 运行中 run 也允许 attach
   - attach 后当前 session 可以继续使用 `run-status`、`run-summary`、`run-stop`

4. **支持直接输入名称**
   - 支持用 `runId`
   - 支持用 plan 文件名或相对路径匹配
   - 若匹配多个 run，则让用户选择具体 run

5. **为后续 attach 提供持久元数据**
   - 新创建 run 时额外写入一个 run 元数据文件，便于未来 attach 精确恢复
   - 对旧 run 仍提供兼容读取与降级恢复

---

## 非目标

本次设计不包含：

- 改造 `/run-plan` 的执行模型
- 改造 `.pi/runs` 的目录结构
- 给一个 session 同时绑定多个 run
- 跨工程浏览或切换 run
- 自动恢复一个已经退出的 child 进程本身（这里只是恢复 session 绑定）

---

## 方案对比

### 方案 1：新增 `/run-resume`

做法：

- 用 `/run-resume` 作为主命令
- 行为本质上仍是“找到当前工程已有 run 并绑定到当前 session”

优点：

- 对部分用户来说和“恢复流程”直觉接近

缺点：

- `resume` 容易让人误解为“恢复子进程执行”
- 本需求真正要解决的是“session 重新绑定已有 run”，不是恢复一个暂停任务

结论：不采用主命名。

### 方案 2：新增 `/run-attach`

做法：

- 无参数时列出当前工程的 run 实例
- 有参数时按 `runId / plan 名 / 相对路径` 匹配 run
- 选中后把 `activeRun` 切换到该 run，并持久化到当前 session

优点：

- 语义最准确，明确表达“把当前 session 绑定到已有 run”
- 和 run 是否仍在执行解耦
- 容易做工程级边界限制

缺点：

- 需要补一套 run 发现和元数据恢复逻辑

结论：**采用本方案**。

### 方案 3：修改现有 `/run-status` 或 `/run-summary`

做法：

- 当当前 session 无绑定时，自动提示并在命令内部发起 attach 流程

优点：

- 表面上少一个命令

缺点：

- 读操作命令带副作用，语义不清楚
- 行为不可预测，测试也更绕
- 不利于用户明确控制当前 session 绑定状态

结论：不采用。

---

## 设计总览

新增命令：

- `/run-attach`

核心设计：

1. 先确定当前 project root
2. 只扫描该工程下 `.pi/runs/*`
3. 把每个 run 目录解析为可 attach 的 `RunState`
4. 优先读取新的持久化元数据文件；旧 run 用现有 `status.json` / `summary.md` / `README.txt` 降级恢复
5. 无参数时列出 run 实例并选择
6. 有参数时按 run 标识匹配，唯一匹配直接绑定，多匹配再选
7. 绑定后复用现有 `activeRun + persistState + refreshStatus + poller` 机制

---

## 工程边界规则

### 当前工程定义

沿用现有 `findProjectRoot(ctx.cwd)` 逻辑：

- 自当前目录向上寻找含 `.pi` 的目录
- 找到后视为当前 project root

### run 扫描边界

只扫描：

- `<projectRoot>/.pi/runs/*`

明确不做：

- 读取其它工程目录
- 全局搜索 `~/.pi`
- 递归扫描其它仓库的 `.pi/runs`

因此即使别的工程存在同名 plan 或同名 runId，也不会出现在 attach 候选中。

---

## run 持久化与兼容恢复

### 新 run 的持久化

从本次实现开始，`/run-plan` 创建 run 时额外写入一个元数据文件，例如：

- `.pi/runs/<runId>/run.json`

其内容至少包含完整 `RunState` 所需字段：

- `runId`
- `planFile`
- `extraInstructions`
- `workdir`
- `runDir`
- 各工件路径
- `tmuxSession`
- `branchName`
- `repos`
- `startedAt`
- 模型信息

这样未来 attach 可以无损恢复该 run。

### 旧 run 的兼容恢复

历史 run 可能没有 `run.json`。对这些 run，attach 采用降级恢复：

1. 先读 `status.json`
   - 取 `planFile`
   - 取 `tmuxSession`
   - 取 `branchName`
   - 取模型信息
2. 再读 `summary.md` / `README.txt`
   - 补全 `planFile`、`branchName`、`tmuxSession`
3. 对缺失字段使用基于 run 目录约定的默认路径
4. 若 `repos` 无法恢复，则置为 `[]`

这样旧 run 仍然可以支持：

- `run-status`
- `run-summary`
- `run-stop`
- 部分情况下的 `run-merge`

对于 `run-merge`：

- 若 `repos` 缺失，现有逻辑会回退到基于工作区推断的 merge scope
- 不会因为旧 run 无完整元数据而完全不可用

---

## 命令行为

### `/run-attach` 无参数

#### 有 UI

- 扫描当前工程 attachable runs
- 按时间倒序展示候选列表
- 用户选择一个 run 后立即绑定

#### 无 UI

- 输出当前工程可绑定 run 列表
- 提示用户使用：
  - `/run-attach <runId>`
  - `/run-attach <plan-name>`

### `/run-attach <query>`

支持以下匹配输入：

- `runId`
- plan 相对路径
- plan 文件名
- plan 文件名去扩展名
- 相对路径后缀

匹配规则：

1. 先按 `runId` 精确匹配
2. 再按 plan 相对路径精确或后缀匹配
3. 再按文件名匹配
4. 若唯一匹配，直接绑定
5. 若匹配多个，进入选择
6. 若无匹配，报告“当前工程无匹配 run”

### 已有 active run 时

为保持最小变更和明确语义，本次仍允许 `/run-attach` 覆盖当前 session 的 `activeRun`。

原因：

- 该命令本质就是切换绑定对象
- 对运行中的 run 和已结束 run 都适用
- 不需要额外新增“detach”命令

为了降低误操作：

- 若 attach 到的就是当前已绑定 run，则仅提示“已绑定该 run”
- 若切换到不同 run，则提示已重新绑定

---

## attach 候选展示

每个 run 候选项应展示：

- `runId`
- `state`
- `startedAt`
- `plan`（相对当前工程）
- `branchName`

示例：

```text
20260426-103015-plan-runner-run-attach · running · 2026-04-26T10:30:15Z · docs/superpowers/plans/2026-04-26-plan-runner-run-attach.md · pi/20260426-plan-runner-run-attach
```

排序规则：

- 优先按 `startedAt` 倒序
- 若缺失，则回退按 `runId` 倒序

---

## 绑定后的行为

绑定成功后：

1. `activeRun = selectedRun`
2. 调用 `persistState()` 把绑定写入当前 session
3. 调用 `refreshStatus(ctx, true)` 立刻刷新 UI 状态
4. `startPoller()` 确保运行中的 run 会继续被轮询

这样后续命令无需修改使用方式：

- `/run-status`
- `/run-summary`
- `/run-stop`
- `/run-merge`
- `/run-promote-docs`

都继续读取当前 `activeRun`。

---

## 错误处理

以下情况直接停止并报告：

- 当前工程没有 `.pi/runs`
- 当前工程下没有任何可解析 run
- 查询字符串在当前工程无匹配 run
- 多匹配但无 UI，无法选择
- 元数据文件损坏且降级恢复也失败

同时要求：

- 单个 run 目录解析失败时，不应阻断其它 run 被列出
- 只有当所有候选都不可解析时，才整体报错“无可绑定 run”

---

## 对现有逻辑的影响

### `run-plan`

需要增加一个最小改动：

- 创建 run 后写入 `run.json`

其余行为保持不变。

### `restoreState`

现有 `restoreState` 仍只从当前 session 读取 `activeRun`。这点不变。

`/run-attach` 只是提供一个显式入口，把某个已有 run 写进当前 session 的 `activeRun`。

### `run-merge`

不需要专门为 attach 做逻辑分支。

因为 attach 恢复出来的 `RunState` 与原有 `activeRun` 类型一致：

- 新 run 可完整恢复 `repos`
- 旧 run 缺 `repos` 时，现有 merge scope 推断会自动回退

---

## 测试策略

### 纯逻辑测试

新增 helper 级别测试，覆盖：

- 当前工程 `.pi/runs` 扫描只返回本工程 run
- `run.json` 优先于旧工件解析
- 无 `run.json` 时可由 `status.json` / `summary.md` / `README.txt` 降级恢复
- attach query 的匹配优先级和歧义处理
- 候选显示顺序按开始时间倒序

### 命令级测试

扩展 `tests/plan-runner.test.mjs`，覆盖：

1. 注册了 `/run-attach`
2. 无参数时能列出候选
3. 有唯一匹配时能绑定并写入 session state
4. 多匹配时在有 UI 情况下通过 `ui.select` 选择
5. 当前 session 已绑定其它 run 时可以重新绑定
6. attach 后 `run-status` / `run-summary` 读取新绑定 run
7. attach 不会读到其它工程 run

---

## 验证策略

继续使用当前仓库已有方式：

```bash
node --test tests/plan-runner.test.mjs
```

重点验证：

- 老测试全部保持通过
- 新增 attach 逻辑通过
- 兼容旧 run 工件

---

## 最终结论

采用“**新增 `/run-attach` + 只扫描当前工程 `.pi/runs` + 新 run 写 `run.json` + 旧 run 降级恢复**”的方案。

该方案满足：

- 当前 session 无绑定时可以重新绑定已有 run
- 能列出可绑定 run，也能直接输入名称
- 允许绑定运行中的 run
- 不会绑定其它工程中的 run
- 对现有 `plan-runner` 命令面改动最小，且与现有 `activeRun` 机制自然兼容
