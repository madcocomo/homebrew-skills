# DocumentController 异常处理审查摘要

- 目标文件是否存在：**不存在**。
- 检查范围：
  - `avia-base` 全量检索 `DocumentController.java` 与 `class DocumentController`
  - `avia-base/application/src/main/java/io/rivendale/avia/controller/` 控制器目录清单
  - `avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java`

## 结论
- 在 `avia-base` 中未找到 `DocumentController.java`，也未找到 `class DocumentController` 定义。
- 因目标 Controller 不存在，**无法确认其内部是否存在重复的 try/catch、重复的异常到 HTTP 响应映射、或重复的错误消息拼装**。
- 现有全局异常处理器 `GlobalExceptionHandler` 已集中处理多类异常映射：
  - `ServiceException`（约 29-37 行）
  - `ResponseStatusException`（约 40-44 行）
  - `IllegalArgumentException`（约 47-62 行）
  - `IllegalStateException`（约 65-75 行）
  - 通用 `Exception`（约 78-88 行）

## 证据
- 控制器目录中仅发现：`DmController`、`DoctypeController`、`FileController`、`FilePreviewController`、`FileVersionController`、`FolderController`、`JobController`、`PmController`、`RevisionProcessController`、`TocController`、`UserController`、`UserManageController`、`VaultFileController`、`XmlDiffController`、`XmlDiffPreviewController`、`XmlThreeWayDiffController`，**没有 `DocumentController`**。
- `GlobalExceptionHandler` 已提供统一的错误响应构造能力（约 107-113 行 `buildErrorResponse` / `buildErrorBody`）。

## 是否发现重复异常处理
- 对 `DocumentController`：**未发现，因为目标不存在**。
- 从架构角度看：如果后续新增 `DocumentController` 并在方法内再次手写 `try/catch + ResponseEntity`，将很容易与 `GlobalExceptionHandler` 中现有映射重复。

## 风险
- 当前风险主要是**命名/职责定位不清**：文档相关能力可能已分散在其他 Controller（如 `FileController` 一类）中，容易让后续审查或新增实现时重复造异常处理逻辑。
- `GlobalExceptionHandler` 已按 URI 做分支判断（如 `usesRecentControllerContract`、`isDmOrPmRequest`，约 91-105 行）；若未来新增新路由但不复用这套约定，可能出现相同异常在不同入口返回不一致的问题。

## 建议
- 先确认“文档”能力实际归属的 Controller（很可能不是 `DocumentController` 这个名字）。
- 若后续确实会新增或定位到文档类 Controller，优先复用 `GlobalExceptionHandler`，避免在 Controller 内重复写异常到 HTTP 响应映射。
- 若未来发现多个 Controller 都在拼装相同 `{ "error": ... }` 响应或相同 `try/catch`，再做统一收敛；本次先不建议无目标地重构。 
