# 并行批次任务模板

当你准备把多个彼此独立的子任务并行展开时，先为每个子任务生成一份任务文件。不要让多个子任务共享同一个任务文件。

推荐命名：
- 批次：`batch-a`
- 任务 1：`/tmp/pi-batch-a-task-1.md`
- 任务 2：`/tmp/pi-batch-a-task-2.md`

---

## 模板

```md
任务：<一句话描述当前子任务>

批次：<batch-id>
子任务：<task-id>

工作目录：<absolute-path>

本任务目标：
- <目标 1>
- <目标 2>

范围：
- 允许读取/修改：<file-or-dir-1>
- 允许读取/修改：<file-or-dir-2>

禁止修改：
- <shared-file-or-dir-1>
- <shared-file-or-dir-2>

并行约束：
- 本任务与以下任务互相独立：<task-2>, <task-3>
- 不要写入共享临时目录，除非目录已按任务隔离
- 不要修改其他并行任务负责的文件
- 如发现范围重叠或隐性依赖，停止落地修改并在摘要中上报

要求：
1. 先读目标范围，再决定方案
2. 在子进程内完成局部分析、修改、验证
3. 保持最小改动
4. 如果失败，先在当前边界内诊断并在合适时重试一次
5. 结果写入指定输出位置，便于主会话统一汇总

验证：
- <command 1>
- <command 2>

输出目录：<summary-root>/<batch-id>/<task-id>/

最终输出请包含：
- 状态文件：<summary-root>/<batch-id>/<task-id>/status.json
- 摘要文件：<summary-root>/<batch-id>/<task-id>/summary.md
- 详细日志：<summary-root>/<batch-id>/<task-id>/stderr.log
- 原始结果：<summary-root>/<batch-id>/<task-id>/result.json

摘要中请明确说明：
- 是否成功
- 修改了哪些文件
- 是否发现与其他并行任务的潜在冲突
- 验证结果
- 风险与建议
- 是否建议进入汇总阶段
```

---

## 最小可用示例

```md
任务：检查 avia-base 中 3 个 controller 的重复异常处理，并分别给出最小修改方案

批次：batch-controller-review
子任务：task-user-controller

工作目录：/Users/wuke/code/AH/avia-base

本任务目标：
- 阅读 UserController 相关代码
- 识别重复异常处理逻辑
- 给出最小修改建议；如已明确可安全修改，则直接落地

范围：
- 允许读取/修改：application/src/main/java/.../UserController.java
- 允许读取/修改：application/src/main/java/.../UserService.java

禁止修改：
- application/src/main/java/.../OrderController.java
- application/src/main/java/.../DocumentController.java
- /tmp/pi-batch-controller-review/

并行约束：
- 本任务与以下任务互相独立：task-order-controller, task-document-controller
- 不要修改其他并行任务负责的文件
- 如发现公共基类需要统一调整，先停止落地修改并在摘要中上报

要求：
1. 先读目标范围，再决定方案
2. 在子进程内完成局部分析、修改、验证
3. 保持最小改动
4. 如果失败，先在当前边界内诊断并在合适时重试一次
5. 结果写入指定输出位置，便于主会话统一汇总

验证：
- mvn -pl application -Dtest=UserControllerTest test

输出目录：/tmp/pi-batch-controller-review/batch-controller-review/task-user-controller/

最终输出请包含：
- 状态文件：/tmp/pi-batch-controller-review/batch-controller-review/task-user-controller/status.json
- 摘要文件：/tmp/pi-batch-controller-review/batch-controller-review/task-user-controller/summary.md
- 详细日志：/tmp/pi-batch-controller-review/batch-controller-review/task-user-controller/stderr.log
- 原始结果：/tmp/pi-batch-controller-review/batch-controller-review/task-user-controller/result.json
```
