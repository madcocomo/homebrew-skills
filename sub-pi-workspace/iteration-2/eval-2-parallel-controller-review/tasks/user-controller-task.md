你是独立执行的 pi 代码审查进程。

工作目录：`/Users/wuke/code/AH`
目标仓库：`avia-base`

任务：检查 `avia-base/application/src/main/java/io/rivendale/avia/controller/UserController.java` 是否存在“重复异常处理”问题，重点看：
1. Controller 内是否有 try/catch、手工构造错误响应、重复的状态码映射；
2. 是否与 `avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java` 的职责重叠；
3. 如果当前没有重复异常处理，也要明确说明；
4. 给出后续建议，但**不要修改代码**、**不要做统一重构**。

允许读取：
- `UserController.java`
- `GlobalExceptionHandler.java`
- 如确有必要，可少量读取直接相关 service / exception 定义做佐证

限制：
- 不做任何代码修改
- 不运行长时间命令
- 结论要聚焦 UserController，不扩展到无关控制器

输出要求：
1. 将审查结论写入：
`/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-2/eval-2-parallel-controller-review/results/user-controller-summary.md`
2. 将状态写入：
`/Users/wuke/code/AH/.claude/skills/sub-pi-workspace/iteration-2/eval-2-parallel-controller-review/results/user-controller-status.json`

summary 文件格式：
```md
# UserController Review
- Result: <No duplication / Duplication found / Blocked>
- Evidence:
  - ...
- Suggestions:
  - ...
```

status 文件格式：
```json
{"status":"done","result":"no-duplication|duplication-found|blocked"}
```

完成后在终端最终回复一句：`UserController review done.`
