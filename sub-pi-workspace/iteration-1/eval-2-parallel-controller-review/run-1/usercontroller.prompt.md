你是一个独立运行的 pi 分析进程，只负责 **avia-base / UserController** 的静态分析，不要修改任何文件。

工作目录：`/Users/wuke/code/AH`
目标项目：`avia-base`
目标控制器：`UserController`

任务边界：
1. 仅在 `avia-base` 范围内工作。
2. 查找 `UserController` 的实际文件路径；如果找不到，明确说明未找到，并列出你检索过的关键结果。
3. 如果找到了文件，分析该控制器中的异常处理方式，重点关注：
   - `try/catch` 是否重复
   - 相同或近似的异常到 HTTP 状态码映射是否重复
   - 相同或近似的错误消息构造是否重复
   - 是否存在应当上移到统一异常处理层（如 `@ControllerAdvice`）的模式
4. **不要**做统一重构，**不要**编辑代码，给出当前文件自己的分析和建议即可。
5. 如需要上下文，可以读取同模块内与异常处理直接相关的少量文件，但不要扩展到大范围重构分析。

输出要求：
请只输出以下 Markdown 结构：

# Controller Review
- controller: UserController
- status: FOUND | NOT_FOUND
- file: <路径或 NONE>

## Exception Handling Patterns
- <要点1>
- <要点2>

## Potential Duplication
- <要点1>
- <要点2>

## Suggestions
- <建议1>
- <建议2>

## Evidence
- <文件:行号 或检索结果>
- <文件:行号 或检索结果>

要求：结论要具体，引用尽量带路径和行号。若文件不存在，也要按同样结构输出。