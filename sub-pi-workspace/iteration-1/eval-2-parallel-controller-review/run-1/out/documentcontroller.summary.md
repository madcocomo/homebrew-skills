]777;notify;oh-pi;Done after 12 turn(s). Ready for input.# Controller Review
- controller: DocumentController
- status: NOT_FOUND
- file: NONE

## Exception Handling Patterns
- 未找到 `DocumentController` 实际文件，因此无法对该控制器内部的 `try/catch`、异常到 HTTP 状态码映射、错误消息构造方式做静态分析。
- `avia-base` 已存在统一异常处理层 `GlobalExceptionHandler`，集中处理 `ServiceException`、`ResponseStatusException`、`IllegalArgumentException`、`IllegalStateException` 和兜底 `Exception`；从项目结构看，异常处理基础设施已经具备上移到统一层的能力。

## Potential Duplication
- 由于目标控制器不存在，无法确认其内部是否存在重复 `try/catch`、重复状态码映射或重复错误消息构造。
- 从当前控制器命名看，原本可能被称为 “Document” 的职责更像是拆分在 `DmController`、`PmController` 以及多个 `File*Controller` 中；如果后续要评审异常处理重复，应该改为针对这些实际存在的控制器逐个分析。

## Suggestions
- 先确认 `DocumentController` 是否已被删除、重命名，或其职责已迁移到 `DmController` / `PmController` / `FileController` 等实际文件；确认后再基于真实文件进行异常处理评审。
- 如果历史上确实存在一个文档类控制器并已拆分，建议继续复用 `GlobalExceptionHandler`，避免在控制器中重复编写 `try/catch`、`ResponseEntity.status(...)` 和统一的 `{ "error": ... }` 响应体构造。

## Evidence
- 检索结果：`rg --files avia-base | rg 'DocumentController\\.java$|DocumentController\\.(kt|groovy)$'` → 无匹配
- 检索结果：`rg -n 'DocumentController' avia-base --glob '!**/.git/**'` → 无匹配
- `avia-base/application/src/main/java/io/rivendale/avia/controller/DmController.java:19`
- `avia-base/application/src/main/java/io/rivendale/avia/controller/PmController.java:19`
- `avia-base/application/src/main/java/io/rivendale/avia/controller/FileController.java:23`
- `avia-base/application/src/main/java/io/rivendale/avia/controller/FileVersionController.java:30`
- `avia-base/application/src/main/java/io/rivendale/avia/controller/FileContentController.java:36`
- `avia-base/application/src/main/java/io/rivendale/avia/controller/FilePreviewController.java:29`
- `avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java:23`
- `avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java:30`
- `avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java:41`
- `avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java:48`
- `avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java:66`
- `avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java:79`
