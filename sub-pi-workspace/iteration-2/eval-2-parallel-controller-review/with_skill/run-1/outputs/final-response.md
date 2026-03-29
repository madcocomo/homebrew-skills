已按你的要求用 3 个独立 pi 进程并行执行，并由主线程汇总结果。

并行 session：
- `pi-ctrl-review-user`
- `pi-ctrl-review-order`
- `pi-ctrl-review-document`

产物目录：
- `.claude/skills/sub-pi-workspace/iteration-2/eval-2-parallel-controller-review/run-1/`

关键结果：
- `user-controller.summary.md`
- `order-controller.summary.md`
- `document-controller.summary.md`

结论汇总：

1. `UserController`
- 文件存在：`avia-base/application/src/main/java/io/rivendale/avia/controller/UserController.java`
- 结论：**Controller 本身没有重复异常处理**
- 观察到：
  - 没有本地 `try/catch`
  - 没有本地 `ResponseEntity` 错误映射
  - 异常主要通过 `UserService` + `GlobalExceptionHandler` 处理
- 真正更像“可收敛点”的地方不在 Controller，而在：
  - `avia-base/application/src/main/java/io/rivendale/avia/service/UserService.java`
  - `login()` 里有重复的 `401 + "User not existed."` 映射
- 建议：
  - 保持 `UserController` 继续做薄控制器
  - 后续若要收敛，优先收敛 `UserService` 的异常模型，再交给 `GlobalExceptionHandler`

2. `OrderController`
- 结论：**在 avia-base 中不存在**
- 无法判断其内部是否有重复异常处理
- 现阶段建议：
  - 如果后续新增该 Controller，不要在 Controller 内手写重复的异常到 HTTP 响应映射
  - 优先复用 `GlobalExceptionHandler`

3. `DocumentController`
- 结论：**在 avia-base 中不存在**
- 无法判断其内部是否有重复异常处理
- 现阶段建议：
  - 先确认“文档相关接口”实际落在哪个现有 Controller
  - 若后续新增文档类 Controller，仍应优先走全局异常处理

主线程综合判断：
- 你指定的三个目标里，**只有 `UserController` 实际存在**
- 因此当前**不能得出“三个 Controller 存在共同重复异常处理”的结论**
- 当前最值得关注的不是 Controller 层重复，而是：
  - `UserService` 把 HTTP 语义带进 service 层
  - `GlobalExceptionHandler` 已存在，但异常收敛并不彻底
  - `GlobalExceptionHandler` 还带 URI 分支判断，未来新增接口时有响应契约漂移风险

建议下一步：
- 先不要做统一重构
- 先确认你想看的另外两个目标是否写错名字
  - 例如是否其实想看某些现有 controller：`FileController`、`DoctypeController`、`DmController` 等
- 如果你愿意，我下一步可以继续用同样的并行方式，改为审查：
  - `UserController`
  - 一个真实存在的“订单相关”Controller
  - 一个真实存在的“文档相关”Controller

如果你要，我可以直接继续帮你筛一版“最像 Order/Document 语义”的现有 Controller，再开第二轮并行审查。