你是独立执行的 pi 代码审查进程。

工作目录：`/Users/wuke/code/AH`
目标仓库：`avia-base`

任务：检查 avia-base 中是否存在 `OrderController`，并分析它是否有“重复异常处理”问题。

执行步骤：
1. 先在 `avia-base` 内确认 `OrderController.java` 或 `class OrderController` 是否存在；
2. 如果不存在，给出明确证据（搜索结果）并说明当前无法进行控制器级异常处理分析；
3. 如果存在，再检查：
   - Controller 内是否有 try/catch、手工构造错误响应、重复的状态码映射；
   - 是否与 `GlobalExceptionHandler.java` 职责重叠；
4. 给出后续建议，但**不要修改代码**、**不要做统一重构**。

允许读取：
- `avia-base` 下与 `OrderController` 直接相关的文件
- `avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java`

限制：
- 不做任何代码修改
- 不运行长时间命令
- 结论只聚焦 OrderController 是否存在，以及其异常处理情况

输出要求：
1. 将审查结论写入：
`/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-2/eval-2-parallel-controller-review/results/order-controller-summary.md`
2. 将状态写入：
`/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-2/eval-2-parallel-controller-review/results/order-controller-status.json`

summary 文件格式：
```md
# OrderController Review
- Result: <Not found / No duplication / Duplication found / Blocked>
- Evidence:
  - ...
- Suggestions:
  - ...
```

status 文件格式：
```json
{"status":"done","result":"not-found|no-duplication|duplication-found|blocked"}
```

完成后在终端最终回复一句：`OrderController review done.`
