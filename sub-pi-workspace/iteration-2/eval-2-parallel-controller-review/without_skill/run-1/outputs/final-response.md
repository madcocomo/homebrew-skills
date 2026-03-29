我已按“3 个独立 pi 进程并行审查”的方式汇总结论，子任务摘要在：

- `/.claude/skills/sub-pi-workspace/iteration-2/eval-2-parallel-controller-review/run-1/user-controller.summary.md`
- `/.claude/skills/sub-pi-workspace/iteration-2/eval-2-parallel-controller-review/run-1/order-controller.summary.md`
- `/.claude/skills/sub-pi-workspace/iteration-2/eval-2-parallel-controller-review/run-1/document-controller.summary.md`

### 汇总结论

#### 1) `UserController`
**结论：Controller 本身没有重复异常处理。**

- `UserController.java` 里没有 `try/catch`
- 没有手工 `ResponseEntity` 错误映射
- 没有重复拼装错误响应体
- 当前是“薄控制器”写法，异常主要下沉到：
  - `UserService`
  - `GlobalExceptionHandler`

**但有一个值得关注的点不在 Controller，而在直接调用链：**

`UserService.login()` 里有重复的 401 映射：

- `catch (Exception)` 后抛 `401 "User not existed."`
- `user == null` 时又抛一次 `401 "User not existed."`

另外，`UserService` 直接抛 `ResponseStatusException`，说明 HTTP 语义还停留在 service 层，和项目里已有的 `GlobalExceptionHandler + ServiceException` 集中处理思路不完全一致。

**建议：**
- 保持 `UserController` 继续不要加本地异常处理
- 后续若要收敛，优先看 `UserService.login()`，不是先动 Controller
- 统一认证失败的异常模型和错误消息策略

---

#### 2) `OrderController`
**结论：`avia-base` 中不存在这个 Controller，无法做控制器级重复异常处理分析。**

已确认：

- 没有 `OrderController.java`
- 全仓没有 `class OrderController` 命中

**建议：**
- 如果你预期它应该存在，先确认是否是别的名字
- 如果后续新增 `/api/orders` 相关 Controller，建议直接复用 `GlobalExceptionHandler`
- 由于 `GlobalExceptionHandler` 里有基于 URI 的分支逻辑，新增 `/api/orders` 时要顺便评估是否需要扩展对应判断

---

#### 3) `DocumentController`
**结论：`avia-base` 中也不存在这个 Controller，无法做控制器级重复异常处理分析。**

已确认：

- 没有 `DocumentController.java`
- 全仓没有 `class DocumentController` 命中

从当前 controller 目录看，文档相关能力更可能散在这些类里：

- `FileController`
- `FilePreviewController`
- `FileVersionController`
- `VaultFileController`
- `DoctypeController`

**建议：**
- 先确认你说的“Document”实际对应哪个 Controller
- 如果要继续查“文档接口是否有重复异常处理”，下一轮应改查真实承载文档能力的 Controller

---

### 主线程总判断

对你点名的 3 个目标来说：

- **真正存在的只有 `UserController`**
- **`UserController` 本身没有重复异常处理**
- **`OrderController` / `DocumentController` 当前在 `avia-base` 里不存在**

所以，**目前不能得出“这 3 个 Controller 都有重复异常处理”的结论**。  
更准确地说：

- Controller 层目前没有明显重复
- 真正值得后续关注的是 **`UserService -> GlobalExceptionHandler` 之间的异常策略不统一**

### 我建议的下一步
如果你要继续，我建议开第二轮并行审查，目标改成真正可能相关的 3 个文件，例如：

- `FileController`
- `FileVersionController`
- `VaultFileController`

这样更有机会找到你说的“Document”领域里是否存在重复异常处理。