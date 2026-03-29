可以，按你这个诉求，**最合适的是单个独立 pi 子进程闭环处理**，主线程只做编排，不下沉到代码细节。

## 推荐组织方式

### 1）主线程只负责这几件事
- 定义边界：
  - 失败测试名 / 测试命令
  - 允许修改的目录
  - 验收标准
- 启动 **一个** 独立 pi 进程
- 默认只读取：
  - `summary.md`
  - `status.json`
- **不要默认读详细日志**
  - 只有子进程失败、阻塞、或摘要不足时，再看 `stderr.log`

---

### 2）子进程内部负责完整闭环
这个子进程在自己的上下文里完成：

1. 局部阅读相关测试和实现
2. 复现失败
3. 诊断根因
4. 做最小必要修改
5. 重试目标测试
6. 如有必要，补跑有限相关验证
7. 输出最终摘要和下一步建议

也就是说，**阅读、诊断、修改、验证都下沉到子进程**，主线程不参与这些细节。

---

## 建议的产物结构

```text
.pi/
  tasks/
    isolated-test-debug.md
  runs/
    isolated-test-debug/
      status.json
      summary.md
      stderr.log
```

### `status.json`
建议包含：

```json
{
  "task": "isolated-test-debug",
  "state": "running",
  "test_target": "xxx",
  "scope": ["acorn/..."],
  "reproduced": false,
  "root_cause_found": false,
  "files_changed": [],
  "validation": {
    "target_test": "pending",
    "related_checks": []
  },
  "next_action": "reproduce failure"
}
```

状态可用：
- `running`
- `passed`
- `failed`
- `blocked`

---

### `summary.md`
建议最终只看这个，内容包含：

```md
# Isolated Test Debug Summary

## Result
- passed / failed / blocked

## Failing Test
- <test name / command>

## What I Read
- 只列局部阅读范围

## Diagnosis
- 根因
- 关键证据

## Changes Made
- 修改文件
- 修改目的

## Validation
- 目标测试结果
- 相关补充验证结果

## Risks / Notes
- 剩余风险或未覆盖点

## Next Step Suggestion
- 给主线程的下一步建议
```

---

## 子任务 prompt 模板

你可以把下面内容放进 `.pi/tasks/isolated-test-debug.md`：

```md
你是一个独立 pi 调试进程。目标是排查并处理一个测试失败，但只允许在明确边界内工作。

## Goal
排查指定失败测试，并在你的上下文内完成：
1. 局部阅读
2. 失败复现
3. 根因诊断
4. 最小必要修改
5. 重试验证
6. 输出最终摘要和下一步建议

## Scope
- 失败测试：<填写测试名或命令>
- 允许修改目录：
  - <path-1>
  - <path-2>
- 禁止扩展到无关模块
- 不做无关重构

## Acceptance Criteria
- 能明确复现失败，或明确说明为何当前无法复现
- 给出根因判断和证据
- 如能修复，则做最小修改
- 至少重跑目标测试
- 如有必要，补充有限相关验证
- 输出 `status.json` 和 `summary.md`

## Required Outputs
请持续更新：
- `.pi/runs/isolated-test-debug/status.json`

任务结束时输出：
- `.pi/runs/isolated-test-debug/summary.md`

## Execution Rules
- 先局部阅读，再执行修改
- 只做最小必要变更
- 如果问题超出 scope、需要大范围改动、或验证条件不足，停止并标记 `blocked`
- 主线程默认只会看 summary，不会看详细过程日志，因此 summary 必须自包含

## Final Summary Must Include
- 读取了哪些局部文件
- 如何复现
- 根因是什么
- 改了哪些文件
- 测试重试结果
- 下一步建议
```

---

## 启动方式（tmux）

按当前工作区规范，建议这样启动：

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
  -s isolated-test-debug \
  "cd /Users/wuke/code/AH && zsh -c 'source \"$HOME/.zshrc\" && pi --mode json -p @.pi/tasks/isolated-test-debug.md > .pi/runs/isolated-test-debug/result.json 2> .pi/runs/isolated-test-debug/stderr.log'"
```

---

## 主线程的消费方式

主线程默认只做：

1. 看 `status.json`
2. 完成后读 `summary.md`
3. 根据 `summary.md` 决定下一步

**不要默认读取**
- 全量日志
- 全量事件流
- 子进程中的局部分析细节

只有在以下情况才深入：
- `state = failed`
- `state = blocked`
- `summary.md` 信息不足

---

## 一句话总结这个模式

> **单个独立 pi 子进程闭环处理测试失败；主线程只定义边界、启动任务、读取摘要和下一步建议。**

如果你愿意，我下一步可以直接帮你把这个整理成一版可落地的：
- `isolated-test-debug.md`
- `status.json` 模板
- `summary.md` 模板