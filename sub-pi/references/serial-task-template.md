# 串行子任务模板

当任务存在明确前后依赖、必须按门槛逐步推进时，使用这个模板为每一步单独生成任务文件。

推荐命名：
- 步骤 1：`/tmp/pi-serial-step-1.md`
- 步骤 2：`/tmp/pi-serial-step-2.md`
- 步骤 3：`/tmp/pi-serial-step-3.md`

每一步都应该有：
- 明确目标
- 明确范围
- 明确通过门槛
- 明确“通过后能否自动进入下一步”

---

## 模板

```md
任务：<一句话描述当前步骤>

流程：<workflow-name>
步骤：<step-id>
前置步骤：<none 或 step-x>
下一步骤：<step-y 或 none>

工作目录：<absolute-path>

本步骤目标：
- <目标 1>
- <目标 2>

范围：
- 允许读取/修改：<file-or-dir-1>
- 允许读取/修改：<file-or-dir-2>

禁止修改：
- <file-or-dir-1>
- <file-or-dir-2>

串行门槛：
- 本步骤必须满足的条件：<gate-1>
- 通过后是否允许主会话自动进入下一步：<yes/no>
- 如果不满足门槛，需要主会话如何处理：<rule>

要求：
1. 先读目标范围，再决定方案
2. 在子进程内完成局部分析、修改、验证
3. 保持最小改动
4. 若失败，先在当前边界内诊断并在合适时重试一次
5. 不要提前处理下一步骤的内容

验证：
- <command 1>
- <command 2>

最终输出请包含：
- 状态文件：<status-file>
- 摘要文件：<summary-file>
- 详细日志：<stderr-log>
- 原始结果：<result-json>

摘要中请明确说明：
- 本步骤是否成功
- 是否满足串行门槛
- 修改了哪些文件
- 验证结果
- 风险与建议
- 是否建议自动进入下一步
```

---

## 最小可用示例

```md
任务：修改 acorn 中 Folder 查询逻辑，并完成本地安装

流程：acorn-to-avia-base-upgrade
步骤：step-1-acorn
前置步骤：none
下一步骤：step-2-avia-base

工作目录：/Users/wuke/code/AH/acorn

本步骤目标：
- 调整 Folder 查询逻辑
- 确保改动后 `mvn install` 成功

范围：
- 允许读取/修改：src/main/java/...
- 允许读取/修改：src/test/java/...

禁止修改：
- /Users/wuke/code/AH/avia-base
- /Users/wuke/code/AH/ProdTool

串行门槛：
- 本步骤必须满足的条件：`mvn install` 成功
- 通过后是否允许主会话自动进入下一步：yes
- 如果不满足门槛，需要主会话如何处理：停止推进，并返回失败摘要

要求：
1. 先读目标范围，再决定方案
2. 在子进程内完成局部分析、修改、验证
3. 保持最小改动
4. 若失败，先在当前边界内诊断并在合适时重试一次
5. 不要提前处理下一步骤的内容

验证：
- mvn install

最终输出请包含：
- 状态文件：/tmp/pi-serial-step-1.status.json
- 摘要文件：/tmp/pi-serial-step-1.summary.md
- 详细日志：/tmp/pi-serial-step-1.stderr.log
- 原始结果：/tmp/pi-serial-step-1.result.json
```
