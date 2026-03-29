# 独立 pi 进程工作流改进草案

> 目的：为后续修改 `~/.pi/agent/AGENTS.md` 或新增 Skill 提供草案文本。
> 当前阶段：**仅整理方案，不直接修改全局配置**。

---

## 背景

本次对话验证了：

1. 使用独立 pi 进程可以完成串行子任务，具备类似 subAgent 的效果。
2. 仅把“执行命令”放到独立 pi 进程中，并不能显著节省主对话上下文。
3. 真正耗费上下文的是：
   - 局部代码阅读
   - 局部分析与决策
   - 局部测试结果分析
   - 失败诊断
4. 要更接近 subAgent，应该把这些工作也尽量放到独立 pi 进程中，由主进程只保留：
   - 主线目标
   - 子任务边界
   - 验收标准
   - 最终摘要

---

## 总体方案

推荐采用：

- **全局 AGENTS.md 保持极简**：只保留何时使用独立 pi 进程、主/子职责分工、关键约束。
- **详细流程放入 Skill**：按需加载，避免长期占用所有会话上下文。
- **代理环境通过 `tmux new-session -e ...` 传递**：避免在命令中内联 `export` 带来的审批摩擦。

---

## 一、建议写入 `~/.pi/agent/AGENTS.md` 的精简文本

以下内容应尽量保持简短，作为全局路由规则，而不是完整操作手册。

### 建议文本（精简版）

```md
## Independent Process for Isolated Tasks

For isolated tasks with clear scope and independent acceptance criteria, prefer launching an independent pi process early instead of doing detailed analysis in the main session.

Use this mode especially for:
- localized refactors
- targeted debugging
- running focused tests or regressions
- reviewing a specific module or recent commits
- serial sub-tasks that only need summary handoff back to the main thread

When using an independent pi process:
1. The main session should define only the task boundary and acceptance criteria.
2. The independent pi process should do the local reading, analysis, edits, validation, and summary.
3. The main session should read only the child task summary by default, not full logs or event streams, unless the task fails or the summary is insufficient.
4. If multiple independent tasks have explicit sequential gates (for example: build passes, tests pass), continue automatically without repeated confirmation unless failure, ambiguity, or expanded scope requires it.
5. When starting an independent pi process in tmux, pass required environment variables explicitly via `tmux new-session -e ...`, especially network proxy variables such as `http_proxy`, `https_proxy`, `HTTP_PROXY`, `HTTPS_PROXY`, and related vars when applicable.
```

---

## 二、建议放入 Skill 的详细工作流

Skill 的定位：
- 这是“独立 pi 进程模拟 subAgent”的完整操作手册。
- 只有在需要时加载。
- 比 AGENTS.md 更详细，允许包含模板、步骤、产物规范。

建议 Skill 名称可选：
- `sub-pi`
- `subtask-isolation`
- `pi-subprocess-workflow`

---

## 三、Skill 建议结构

### 1. 适用场景

当满足以下条件时使用：
- 任务范围清晰
- 能独立验收
- 不需要主进程持续参与细节分析
- 完成后只需要把摘要带回主线

适用示例：
- 重构某一个 service / controller / repository
- 调查某一组测试失败
- 分析某个模块最近一段时间提交
- 在多个仓库之间按顺序做子任务

---

### 2. 主进程职责

主进程只负责：
- 定义任务边界
- 定义验收标准
- 定义串行依赖顺序
- 读取最终摘要
- 决定是否进入下一个子任务

主进程默认不做：
- 大量局部代码阅读
- 大量局部日志阅读
- 子任务内部失败排查

除非：
- 子进程失败
- 子进程摘要不足
- 用户要求主进程深入分析

---

### 3. 子进程职责

独立 pi 进程应尽量完成整个局部闭环：
- 阅读目标范围内代码
- 分析并确定改动方案
- 修改代码
- 运行验证命令
- 进行第一轮失败诊断
- 输出面向主进程的压缩摘要

目标是把：
- 局部分析
- 局部验证
- 局部排障

都隔离在子进程上下文中。

---

### 4. 启动规则

必须使用：
- `tmux` 承载独立进程
- `zsh -c 'source "$HOME/.zshrc" && ...'`

对于需要代理的环境，优先使用：

```bash
tmux new-session -d \
  -e http_proxy="$http_proxy" \
  -e https_proxy="$https_proxy" \
  -e HTTP_PROXY="$HTTP_PROXY" \
  -e HTTPS_PROXY="$HTTPS_PROXY" \
  -e all_proxy="$all_proxy" \
  -e ALL_PROXY="$ALL_PROXY" \
  -e no_proxy="$no_proxy" \
  -e NO_PROXY="$NO_PROXY" \
  -s <session-name> \
  "zsh -c 'source \"$HOME/.zshrc\" && pi ...'"
```

说明：
- 优先使用 `tmux new-session -e ...`，不要在命令中内联大量 `export ...`。
- 这样更适合受限环境，也更容易减少审批摩擦。

---

### 5. 子任务输入规范

建议主进程为每个子任务生成一个任务文件，例如：

`/tmp/pi-task-1.md`

建议结构：
- 任务目标
- 工作目录
- 修改范围
- 不可修改范围
- 验证命令
- 最终输出要求

示例：

```md
任务：重构 avia-base controller 层重复异常处理

工作目录：/path/to/repo

范围：
- a.java
- b.java

要求：
1. 保持 API 行为不变
2. 最小改动
3. 先读代码再改
4. 修改后运行指定测试

最终输出请包含：
- 修改文件
- 核心改动
- 测试结果
- 后续建议
```

---

### 6. 子任务输出规范

为减少主进程上下文消耗，建议每个子任务至少产出三类文件。

#### A. 状态文件
例如：`/tmp/pi-task-1.status.json`

建议内容：

```json
{
  "success": true,
  "summaryFile": "/tmp/pi-task-1.summary.md",
  "modifiedFiles": [
    "src/main/java/..."
  ],
  "verifications": [
    {
      "command": "mvn test ...",
      "success": true,
      "log": "/tmp/pi-task-1.test.log"
    }
  ]
}
```

#### B. 摘要文件
例如：`/tmp/pi-task-1.summary.md`

建议只包含：
- 修改文件
- 核心改动
- 验证结果
- 风险/后续建议

建议控制篇幅，不要包含详细中间推理或完整日志。

#### C. 详细日志 / 原始输出
例如：
- `/tmp/pi-task-1.stderr.log`
- `/tmp/pi-task-1.full.json`
- `/tmp/pi-task-1.test.log`

主进程默认不读取这些文件，除非任务失败或摘要不足。

---

### 7. 输出模式建议

不建议主进程直接消费完整事件流。

建议规则：
- 如果只需要最终摘要，优先让子进程额外写出 `summary.md`。
- 如果需要机器可解析结果，可以使用 `--mode json`，但仍应产出精简的 `status.json` 和 `summary.md`。
- 主进程默认读取 `status.json` + `summary.md`，不要直接读取完整 `result.json`。

---

### 8. 串行任务推进规则

如果用户已明确给出一组串行独立任务，且下一步是否继续有明确门槛，则主进程可自动推进，不必重复确认。

例如：
- 任务 1 测试通过 → 自动进入任务 2
- 任务 2 构建通过 → 自动进入任务 3

只有在以下情况才需要再次确认：
- 前一步失败
- 结果与预期不符
- 下一步会扩大范围
- 风险明显增加
- 用户明确要求逐步确认

---

### 9. 失败处理规则

子进程失败时，应先在自身上下文中完成第一轮诊断：
- 查看本任务日志
- 判断失败属于：
  - 环境问题
  - 构建失败
  - 测试失败
  - 代码错误
  - 网络/代理问题
- 若可在任务边界内修复，则优先修复并重试一次
- 若仍失败，再向主进程输出：
  - 失败原因
  - 已尝试的修复
  - 建议下一步

---

## 四、建议的标准启动模板

### 单个子任务模板

```bash
tmux new-session -d \
  -e http_proxy="$http_proxy" \
  -e https_proxy="$https_proxy" \
  -e HTTP_PROXY="$HTTP_PROXY" \
  -e HTTPS_PROXY="$HTTPS_PROXY" \
  -e all_proxy="$all_proxy" \
  -e ALL_PROXY="$ALL_PROXY" \
  -e no_proxy="$no_proxy" \
  -e NO_PROXY="$NO_PROXY" \
  -s pi-task-1 \
  "cd /path/to/repo && zsh -c 'source \"$HOME/.zshrc\" && pi --mode json -p @/tmp/pi-task-1.md > /tmp/pi-task-1.full.json 2> /tmp/pi-task-1.stderr.log'"
```

---

## 五、推荐落地顺序

### 第一阶段
- 只改全局 AGENTS.md 的极简部分
- 先不直接写复杂规则到 AGENTS
- 详细流程先保存在独立 Skill 草案中

### 第二阶段
- 新增 Skill
- 在需要时加载 Skill
- 用 2~3 次真实任务继续验证流程

### 第三阶段
- 如果流程稳定，再补充：
  - 统一的状态文件模板
  - 统一的摘要文件模板
  - 失败自动诊断模板

---

## 六、当前结论

当前最推荐的方向是：

1. `AGENTS.md` 只保留极简路由规则
2. 详细子进程工作流放到 Skill
3. 代理环境通过 `tmux new-session -e ...` 传递
4. 主进程默认只读取摘要，不读取完整事件流
5. 真正把“局部分析 + 局部验证 + 局部失败诊断”一起下沉到独立 pi 进程

这样最接近使用独立 pi 进程模拟 subAgent 的目标，同时能把全局上下文开销控制在较低水平。
