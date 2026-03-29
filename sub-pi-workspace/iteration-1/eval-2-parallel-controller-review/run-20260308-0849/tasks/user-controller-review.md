任务：分析 avia-base 中 UserController 是否存在重复异常处理，并给出局部建议，不做代码修改。

工作目录：/Users/wuke/code/AH

范围：
- 允许读取：avia-base/application/src/main/java/io/rivendale/avia/controller/UserController.java
- 允许读取：avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java
- 允许读取：如有必要，可读取 avia-base/application/src/main/java/io/rivendale/avia/service 下与 UserController 直接相关的少量服务类
- 不要修改任何文件

禁止修改：
- 整个仓库所有文件都禁止修改
- 不要做统一重构
- 不要改动异常处理实现

要求：
1. 先确认目标文件存在，再阅读目标控制器与全局异常处理。
2. 只分析 UserController 本身是否包含与 GlobalExceptionHandler 重复、分散或局部兜底的异常处理逻辑。
3. 如果没有重复异常处理，也要明确说明依据。
4. 如发现问题，只给建议，不落地修改。
5. 结果尽量简洁，重点写结论和证据。

重点输出：
- 目标文件是否存在
- UserController 当前异常处理方式概述
- 是否与 GlobalExceptionHandler 重复，重复点在哪里
- 风险判断
- 建议的后续动作（仅建议，不修改）

最终请额外写出两个文件：
1. 状态文件：/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-1/eval-2-parallel-controller-review/run-20260308-0849/results/user-controller.status.json
2. 摘要文件：/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-1/eval-2-parallel-controller-review/run-20260308-0849/results/user-controller.summary.md

状态文件 JSON 结构：
{
  "success": true,
  "target": "UserController",
  "fileExists": true,
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
