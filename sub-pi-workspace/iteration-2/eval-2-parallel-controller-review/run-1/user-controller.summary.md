# UserController 异常处理审查摘要

- 目标文件是否存在：存在
  - `/Users/wuke/code/AH/avia-base/application/src/main/java/io/rivendale/avia/controller/UserController.java`

- 检查文件：
  - `avia-base/application/src/main/java/io/rivendale/avia/controller/UserController.java`
  - `avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java`
  - `avia-base/application/src/main/java/io/rivendale/avia/service/UserService.java`
  - 额外用 `rg` 快速对比了 `controller` 包内其他 Controller 的局部 try/catch 分布

- 是否发现 UserController 内部重复异常处理：未发现
  - `UserController` 本身没有 `try/catch`、没有本地 `ResponseEntity` 错误映射、没有手工拼装错误消息。
  - 证据：`login`（约 43-48 行）、`logout`（约 58-59 行）、`getUsername`（约 69-70 行）、`getUserInfo`（约 80-81 行）都只是直接调用 `userService` 或直接返回结果。

- 与该 Controller 直接相关的异常处理路径：
  - `UserService.login()`（约 50-65 行）直接抛 `ResponseStatusException`。
  - `GlobalExceptionHandler.handleResponseStatusException()`（约 40-45 行）统一把异常转成 HTTP 响应。

- 发现的重复/可收敛点（不在 Controller 内，而在直接调用链上）：
  1. `UserService.login()` 中存在重复的 401 映射与重复错误消息：
     - `catch (Exception)` 后抛 `401 "User not existed."`（约 52-56 行）
     - `user == null/empty` 时再次抛 `401 "User not existed."`（约 58-59 行）
  2. `UserService` 直接抛 `ResponseStatusException`，把 HTTP 语义放进 service 层；而项目里已有 `GlobalExceptionHandler` + `ServiceException` 的集中处理模式。
  3. 错误消息风格不统一：
     - 有直接英文文本（如 `User not existed.`、`Password invalid, login failed.`）
     - 也有 message key（如 `error.security.user_is_not_active`）
     - 但 `handleResponseStatusException()` 不做 i18n 解析，可能把 key 直接返回给前端。

- 风险：
  - 现在 `UserController` 很干净，但认证错误的 HTTP 映射散落在 `UserService`，后续如果同类接口增多，容易继续在 service/controller 两侧复制状态码与错误文案。
  - 同一类认证失败目前既有重复 message，也有 message key / 纯文本混用，前端接收到的错误文案可能不一致。
  - 若未来有人在 `UserController` 再补本地 `try/catch`，会与现有 `GlobalExceptionHandler` 形成双轨处理，增加响应格式漂移风险。

- 建议（先不重构）：
  1. 保持 `UserController` 当前“无本地异常处理”的薄控制器写法，不要在该 Controller 再加局部 `try/catch`。
  2. 后续若触碰用户认证链路，优先把 `UserService` 中的认证失败统一为一种业务异常模型（如复用 `ServiceException` 或单独的认证异常），交给 `GlobalExceptionHandler` 集中映射。
  3. 顺手去重 `UserService.login()` 里重复的 `401 + "User not existed."` 分支，并统一错误消息策略（要么统一 i18n key，要么统一面向前端的明确文案）。

- 结论：
  - **UserController 本身不存在重复异常处理。**
  - **值得后续统一收敛的点，主要在 UserService → GlobalExceptionHandler 这一层，而不是 Controller 内部。**
