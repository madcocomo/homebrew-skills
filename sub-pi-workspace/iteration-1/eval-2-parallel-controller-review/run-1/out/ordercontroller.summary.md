]777;notify;oh-pi;Done after 5 turn(s). Ready for input.# Controller Review
- controller: OrderController
- status: NOT_FOUND
- file: NONE

## Exception Handling Patterns
- 在 `avia-base` 范围内未找到 `OrderController` 类或同名文件，因此无法对该控制器自身的 `try/catch`、异常到 HTTP 状态码映射、错误消息构造方式做静态分析。
- 现有控制器目录中未出现任何包含 `Order` 的控制器或 Java 文件名，说明该控制器当前大概率不存在于本仓库，或名称已变更。

## Potential Duplication
- 由于目标控制器不存在，无法确认其内部是否存在重复的 `try/catch`、重复的异常映射或重复的错误消息构造。
- 如果用户原本指的是其他订单相关接口，则当前命名下没有可直接复核的控制器实现，重复模式分析需要基于正确文件名重新执行。

## Suggestions
- 先确认控制器的准确类名或接口名称；如果是“订单”相关功能，可能已落在其他命名的控制器中，需要提供 endpoint、service 名或关键方法名再继续定位。
- 若 `OrderController` 应当存在但当前未检出，建议检查当前分支、模块路径或是否尚未迁移到 `avia-base`。

## Evidence
- 检索结果：`rg --line-number "class\\s+OrderController|OrderController" avia-base` → 无匹配
- 检索结果：`find avia-base -type f | grep -i 'ordercontroller\\|/order[^/]*\\.java\\|order'` → 无匹配；`avia-base/application/src/main/java/io/rivendale/avia/controller/` 下可见控制器包括 `FileController.java`、`FolderController.java`、`JobController.java`、`UserController.java`、`DmController.java`、`PmController.java` 等，但无 `OrderController`
