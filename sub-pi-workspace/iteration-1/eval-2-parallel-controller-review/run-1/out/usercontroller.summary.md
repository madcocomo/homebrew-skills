]777;notify;oh-pi;Done after 8 turn(s). Ready for input.# Controller Review
- controller: UserController
- status: FOUND
- file: avia-base/application/src/main/java/io/rivendale/avia/controller/UserController.java

## Exception Handling Patterns
- `UserController` 本身没有任何 `try/catch`，4 个接口方法都只是直接委托给 `UserService`，控制器层没有本地异常转换逻辑。
- HTTP 状态码映射不在该控制器内完成；当前实际模式是由 `UserService` 抛出 `ResponseStatusException`，再由全局 `@RestControllerAdvice` 统一包装错误响应。
- 该控制器当前不存在控制器内重复的错误消息构造；错误消息主要出现在 `UserService`，错误响应体 `{ "error": ... }` 的构造已集中在 `GlobalExceptionHandler`。

## Potential Duplication
- `UserController` 文件内没有重复的 `try/catch`、异常到状态码映射、或错误消息拼装。
- 与该控制器直接相关的登录链路中，`UserService.login()` 对“用户不存在”场景有重复映射：`catch (Exception)` 和 `user == null` 两处都抛出 `401 UNAUTHORIZED + "User not existed."`，属于近似重复。
- 如果未来在 `UserController` 中加入手写 `ResponseEntity.status(...).body(...)` 或重复 `try/catch`，会和现有 `GlobalExceptionHandler` 的统一响应构造形成重复。

## Suggestions
- 保持 `UserController` 现在这种薄控制器模式，不要在该文件内补充逐方法 `try/catch`；若要增强一致性，应继续把异常上移到统一异常处理层，而不是回落到控制器内处理。
- 对登录相关错误，建议后续优先统一为更稳定的领域异常或单点异常转换，避免在服务层重复写 `ResponseStatusException(HttpStatus.UNAUTHORIZED, ...)`。
- 若后续需要统一国际化或标准错误码，`UserController` 不应自行拼错误消息，应继续复用 `GlobalExceptionHandler`，必要时让 `UserService` 抛出更明确的业务异常类型。

## Evidence
- `avia-base/application/src/main/java/io/rivendale/avia/controller/UserController.java:32` `UserController` 类定义；`43`/`58`/`69`/`80` 四个公开接口方法均为直接委托，无 `try/catch`。
- `avia-base/application/src/main/java/io/rivendale/avia/service/UserService.java:52-56` 登录时捕获异常并抛出 `ResponseStatusException(HttpStatus.UNAUTHORIZED, "User not existed.")`。
- `avia-base/application/src/main/java/io/rivendale/avia/service/UserService.java:59` 当 `user` 为空时再次抛出相同的 `401 + "User not existed."`。
- `avia-base/application/src/main/java/io/rivendale/avia/service/UserService.java:62`、`65`、`81`、`98` 继续在服务层完成 `401/404` 状态映射，说明异常翻译不在 `UserController`。
- `avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java:23` 存在全局 `@RestControllerAdvice`；`41-44` 统一处理 `ResponseStatusException`；`107-111` 统一构造错误响应体。
