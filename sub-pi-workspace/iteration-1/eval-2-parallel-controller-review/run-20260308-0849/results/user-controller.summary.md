# 任务
分析 `avia-base` 中 `UserController` 是否存在重复异常处理，并给出局部建议，不做代码修改。

# 结果
- 目标文件存在：是
- 结论：`UserController` 本身**没有**与 `GlobalExceptionHandler` 重复的异常处理逻辑，也没有发现控制器内分散的局部兜底。

# 目标文件
- `/Users/wuke/code/AH/avia-base/application/src/main/java/io/rivendale/avia/controller/UserController.java`
- `/Users/wuke/code/AH/avia-base/application/src/main/java/io/rivendale/avia/controller/GlobalExceptionHandler.java`
- （辅助确认）`/Users/wuke/code/AH/avia-base/application/src/main/java/io/rivendale/avia/service/UserService.java`

# 核心发现
1. `UserController` 只有 4 个接口：`login/logout/getUsername/getUserInfo`，实现均为**直接调用 `UserService` 并返回结果**。
2. `UserController` 中未发现以下任何局部异常处理形式：
   - `try/catch`
   - `@ExceptionHandler`
   - 手工构造错误 `ResponseEntity`
   - 控制器内错误日志 + fallback 返回
3. `GlobalExceptionHandler` 已集中处理：
   - `ServiceException`
   - `ResponseStatusException`
   - `IllegalArgumentException`
   - `IllegalStateException`
   - 通用 `Exception`
4. `UserService` 的 `login/getUsername/getUserInfo` 会抛出 `ResponseStatusException`，因此 `UserController` 实际采用的是**异常上抛 + 全局处理**模式。
5. 综上，当前 `UserController` 不存在“重复处理同类异常”或“控制器里再兜底一层”的问题。

# 建议
- 维持当前模式：继续让 `UserController` 保持薄控制器，只负责参数接收和服务调用。
- 若后续补充用户接口，避免在 `UserController` 中新增 `try/catch` 或手工错误响应，优先复用 `GlobalExceptionHandler`。
- 如果后续需要统一用户相关错误文案，可优先在 service / 全局异常映射层调整，而不是放到 controller 层。

# 风险
- 就“重复异常处理”这个检查点看，当前风险**低**。
- 唯一需要注意的是：用户接口现在主要依赖 `ResponseStatusException` 的全局处理；若以后在 `UserController` 单独加入局部异常转换，容易与现有全局处理产生风格分叉或重复。
