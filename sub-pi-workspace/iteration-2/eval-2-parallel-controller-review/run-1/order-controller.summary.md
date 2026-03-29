# OrderController 异常处理审查摘要

- **目标文件是否存在**：不存在。已在 `avia-base` 范围内检索 `OrderController.java` 与 `class OrderController`，均无结果。
- **检查了哪些文件/范围**：
  - `avia-base/AGENTS.md`
  - `avia-base/application/src/main/java/io/rivendale/avia/controller/`（控制器目录清单）
  - `avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java`
  - `avia-base` 全仓范围内 `OrderController` / `class OrderController` 检索
- **是否发现重复异常处理**：无法在 `OrderController` 上确认，因为目标 Controller 不存在。
- **证据**：
  - `avia-base` 内对 `OrderController` / `class OrderController` 的全文检索无命中。
  - 控制器目录中不存在 `OrderController.java`。
  - `GlobalExceptionHandler.java` 已集中处理常见异常：`ServiceException`（30-37）、`ResponseStatusException`（41-44）、`IllegalArgumentException`（48-62）、`IllegalStateException`（66-75）、通用 `Exception`（79-88）。
  - 该全局处理器还带有按 URI 分支的契约判断：`usesRecentControllerContract`（91-97）与 `isDmOrPmRequest`（99-104）。
- **建议**：
  1. 若后续新增 `OrderController`，优先复用 `GlobalExceptionHandler`，避免在 Controller 内重复写 `try/catch`、HTTP 状态映射和 `{"error": ...}` 响应拼装。
  2. 若 `OrderController` 将暴露新前缀（如 `/api/orders`），应先评估是否需要扩展 `GlobalExceptionHandler` 中基于 URI 的分支判断，避免新接口落回不一致的错误响应契约。
  3. 若订单域存在稳定的业务异常类型，建议直接定义/复用领域异常并在全局处理器中集中映射，而不是在单个 Controller 内局部兜底。
