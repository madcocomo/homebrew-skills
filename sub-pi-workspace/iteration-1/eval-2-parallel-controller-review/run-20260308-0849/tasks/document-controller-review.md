任务：分析 avia-base 中 DocumentController 是否存在重复异常处理，并给出局部建议，不做代码修改。

工作目录：/Users/wuke/code/AH

范围：
- 优先检查：avia-base/application/src/main/java/io/rivendale/avia/controller/DocumentController.java
- 允许读取：avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java
- 如果 DocumentController 不存在，可在 avia-base/application/src/main/java/io/rivendale/avia/controller 内做一次最小范围检索，确认是否存在等价或近似命名控制器
- 不要修改任何文件

禁止修改：
- 整个仓库所有文件都禁止修改
- 不要做统一重构
- 不要改动异常处理实现

要求：
1. 先确认 DocumentController 是否存在。
2. 若不存在，明确记录“无法分析该文件”，并补充是否发现可能对应的相近控制器名称。
3. 若存在，再分析其异常处理是否与 GlobalExceptionHandler 重复。
4. 只给建议，不修改代码。
5. 结果尽量简洁，重点写结论和证据。

重点输出：
- 目标文件是否存在
- 如不存在，是否发现相近候选控制器
- 如存在，其异常处理方式概述
- 是否与 GlobalExceptionHandler 重复
- 建议的后续动作（仅建议，不修改）

最终请额外写出两个文件：
1. 状态文件：/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-1/eval-2-parallel-controller-review/run-20260308-0849/results/document-controller.status.json
2. 摘要文件：/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-1/eval-2-parallel-controller-review/run-20260308-0849/results/document-controller.summary.md

状态文件 JSON 结构：
{
  "success": true,
  "target": "DocumentController",
  "fileExists": false,
  "modifiedFiles": [],
  "summaryFile": "<摘要文件绝对路径>"
}

摘要文件使用 Markdown，包含：
- 任务
- 结果
- 目标文件
- 核心发现
- 建议
- 风险
