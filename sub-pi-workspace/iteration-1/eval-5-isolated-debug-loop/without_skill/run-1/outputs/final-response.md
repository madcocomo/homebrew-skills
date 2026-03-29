可以，建议你按 **“单个独立 pi 子进程负责完整闭环，主线程只消费摘要”** 这个模式组织。

## 组织方式

### 1) 只开一个子任务
不要拆成多任务，也不要主线程参与局部分析。  
这个子进程一次性完成：

- 局部阅读相关代码/测试
- 复现失败
- 失败诊断
- 必要的最小修改
- 重试验证
- 输出最终摘要和下一步建议

主线程默认只看：

- `status.json`
- `summary.md`

除非失败或摘要不够，再去看详细日志。

---

## 子任务边界

建议把子任务范围写死，避免扩散：

- 目标：排查 **某一个明确失败的测试**
- 允许：阅读相关模块、修改直接相关文件、重跑相关测试
- 禁止：无关重构、顺手清理、扩大改动面

---

## 子进程必须产出的文件

建议固定 2 个主文件：

### `status.json`
给主线程快速判断状态。

示例：
```json
{
  "task": "isolated-test-debug",
  "target_test": "<failing-test>",
  "status": "success",
  "phase": "done",
  "reproduced": true,
  "fixed": true,
  "validated": true,
  "changed_files": [
    "src/...",
    "test/..."
  ],
  "validation_commands": [
    "<test-command-1>",
    "<test-command-2>"
  ]
}
```

### `summary.md`
给主线程看的最终摘要，默认只读这个。

建议结构：
```md
# 测试失败排查摘要

## 目标
- 失败测试：...

## 结论
- 是否复现：是/否
- 是否定位根因：是/否
- 是否修改代码：是/否
- 是否验证通过：是/否

## 根因
- ...

## 修改
- 文件：...
- 改动：...

## 验证
- 命令：...
- 结果：...

## 风险与边界
- ...

## 下一步建议
- ...
```

---

## 给子进程的任务提示词模板

你可以把下面内容写成一个 task file，然后让独立 pi 去执行：

```md
你是一个独立 pi 进程，负责对单个失败测试做封闭式排查。

## 任务目标
排查并处理这个失败测试：<FAILING_TEST>

## 工作边界
- 只关注与该失败测试直接相关的代码、测试、配置
- 允许做最小必要修改
- 不要做无关重构
- 不要扩大范围到其他模块，除非与根因直接相关

## 必须执行的步骤
1. 局部阅读与该测试直接相关的测试文件、实现代码、必要配置
2. 运行测试以复现失败，并记录实际报错
3. 诊断根因
4. 若根因明确且可安全修复，则做最小修改
5. 重跑该测试；如有必要，补跑最邻近受影响测试
6. 产出结构化结果文件

## 输出要求
你必须写出以下文件：

### 1. <STATUS_FILE>
写入 JSON，包含：
- task
- target_test
- status: success | failed | blocked
- phase
- reproduced
- fixed
- validated
- changed_files
- validation_commands

### 2. <SUMMARY_FILE>
写入 Markdown，包含：
- 目标
- 结论
- 根因
- 修改
- 验证
- 风险与边界
- 下一步建议

## 主线程消费约定
- 主线程默认只读取 status.json 和 summary.md
- 不要要求主线程先看完整日志
- 若失败，也要在 summary.md 中明确写出阻塞点和建议下一步

## 验收标准
满足以下其一即可结束：
- 已修复并通过验证
- 无法安全修复，但已清楚定位根因并给出下一步建议
```

---

## 启动方式（tmux）

按你的工作区规范，建议直接用 `tmux` 启动独立 pi：

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
  -s test-debug-loop \
  "cd <workdir> && zsh -c 'source \"$HOME/.zshrc\" && pi --mode json -p @<task-file> > <result-json> 2> <stderr-log>'"
```

---

## 主线程的消费方式

主线程后续只做这几件事：

1. 等子进程结束
2. 读取 `status.json`
3. 读取 `summary.md`
4. 基于摘要决定是否继续

默认 **不要先读**：

- 完整 event stream
- `result.jsonl`
- `stderr.log`

只有在以下情况再下钻：

- `status = failed / blocked`
- `summary.md` 信息不足
- 需要核对具体验证细节

---

## 最简主线程策略

你可以把主线程策略固定成一句话：

> 启动一个独立 pi 子进程处理单个失败测试；子进程自行完成局部阅读、复现、诊断、必要修改和重试验证；主线程默认只读取 `status.json` 和 `summary.md`，仅在失败或摘要不足时再查看详细日志。

如果你愿意，我可以下一步直接帮你生成一份 **可落地的 task prompt + tmux 启动命令模板**，你只要替换测试名和工作目录即可。