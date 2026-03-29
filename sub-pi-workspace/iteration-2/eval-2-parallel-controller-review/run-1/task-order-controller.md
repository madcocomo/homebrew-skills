任务：并行审查 avia-base 中 OrderController 的异常处理，判断是否存在重复异常处理，并给出建议。

工作目录：/Users/wuke/code/AH

范围：
- 允许读取：/Users/wuke/code/AH/avia-base
- 先在 avia-base 内检索 OrderController.java 或 class OrderController
- 如找到目标文件，重点分析目标 Controller；如有必要，可读取与异常处理直接相关的全局处理器或调用点（例如 controller 包内的 GlobalExceptionHandler），但不要扩展到无关模块

禁止修改：
- 不要修改任何源码、配置、文档
- 不要做统一重构
- 不要运行耗时构建

要求：
1. 先确认目标文件是否存在。
2. 只做分析，不做代码修改。
3. 重点判断：
   - 该 Controller 内部是否有重复的 try/catch、重复的异常到 HTTP 响应映射、重复的错误消息拼装。
   - 是否存在本可下沉到 GlobalExceptionHandler 或公共方法的异常处理模式。
   - 当前写法的风险是什么，是否值得后续统一收敛。
4. 如果目标文件不存在，也要完成检索并说明结论，不要报错退出。
5. 最终必须写出以下两个文件：
   - 摘要：/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-2/eval-2-parallel-controller-review/run-1/order-controller.summary.md
   - 状态：/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-2/eval-2-parallel-controller-review/run-1/order-controller.status.json

状态文件格式：
{
  "success": true,
  "target": "OrderController",
  "targetExists": false,
  "summaryFile": "<absolute-path>",
  "findings": ["..."],
  "risks": ["..."],
  "suggestions": ["..."]
}

摘要请尽量简洁，包含：
- 目标文件是否存在
- 检查了哪些文件
- 是否发现重复异常处理
- 证据（方法名/模式/行段说明即可）
- 建议（先不重构，只给建议）
