# Model Router — 归档说明

> **状态：已放弃 | 归档时间：2026-07-12**

## 背景

Model Router 是一个 Pi Extension，目标是**在用户向 LLM 发送请求时，根据任务复杂度自动选择模型**：简单任务用便宜的小模型，复杂任务用用户原本选择的高能力模型。其核心机制是在每个 provider request 边界（`before_agent_start` 和 `turn_end`）调用一个独立的 classifier 模型，后者根据手头证据判断下一轮请求是否可以降级。

项目经历了多个阶段：
- 初始设计（含"strong"降级到"strong"和"weak"两个角色）
- Strong 模型角色删除（语义变为：`user` = 不干预，`weak` = 降级）
- Continuation routing（在每个 tool batch 完成后独立分类）
- 测试、shadow review、数据分析

最终在 2026-07-12 的讨论中确认：**当前机制无法可靠实现预期效果**，决定归档。

## 为什么放弃

核心问题出在 `turn_end` 分类的**时间点**上。

### 想要的机制

用户希望在**助理即将发出 tool call 或分析请求时**，根据助理的**实际意图**判断该步骤是否适合弱模型。例如：

1. 用户输入"修复一个 Bug"
2. 助理读取源代码 → **需要强模型（全局分析）**
3. 助理发现需要复现 → **需要强模型（决策）**
4. 助理执行 `docker-compose up -d` → **可用弱模型（机械操作）**
5. 助理检查 `curl localhost:8080/health` → **可用弱模型（简单检查）**
6. 助理分析返回结果 → **需要强模型（分析归因）**

在这个序列中，理想的做法是**等助理说出它下一步要做什么，再根据那个意图选模型**。

### 实际实现的机制

实际实现中，模型的切换必须在**下一个 LLM 请求发送前**完成。可用的判断点只有：

- `before_agent_start`：有用户原始输入，可以初始判断
- `turn_end`：有**已完成回合**的工具调用和结果，**但不知道助理下一轮要做什么**

所以 `turn_end` 的分类器实际上在做的是——**根据"助理这轮做了什么"来预测"助理下一轮会做什么"**。Spec 中明确写道：

> "The classifier **predicts** the reasoning required by the next provider request."

这种预测在以下场景中可能有效（助理明确说出了下一步意图），但更多时候不可靠——因为助理的下一步取决于它本轮发现的结果，而分类器看不到那个结果。

| 场景 | 分类器可靠性 |
|---|---|
| 助理明确说出下一步意图 | 中高 |
| 助理不说话只调工具 | 低 |
| 工具执行正常、逐步推进 | 中 |
| 工具报错 | 高（确定性规则直接切回，不靠分类器） |

**根本矛盾**：能判断复杂度的最好时间点（助理说出意图后、发出请求前）在 Pi 当前架构中不可用。退而求其次的 `turn_end` 实质是预测而非分类。

### 为什么不继续改进

要真正实现需求，需要：

1. **修改 Pi 核心**：在 provider request 的流式响应中增加"意图识别"事件点，或支持 request-scoped model API
2. **或者使用 proxy**：在用户 ↔ LLM 之间插入透明代理，拦截请求并根据实际内容分流

两者都和当前 Pi Extension 的架构差异巨大，且涉及大量测试和稳定性开销。对于当前"只有我一个人使用"的场景，投入产出比不匹配。因此决定归档，待有明确需求或更优方案时再重新考虑。

## 归档内容

| 路径 | 说明 |
|---|---|
| `src/model-router.ts` | Extension 主源码（约 3600 行） |
| `tests/model-router.test.mjs` | 测试套件（约 4000 行，154 个测试用例） |
| `docs/` | 设计文档和实施计划 |
| `config/` | 运行时配置、示例配置、classifier 基准语料 |
| `review/` | Shadow review 导出的分类记录和分析 |
| `README.md` | 本文件 |

### 相关文档（保留在原位置）

- `docs/superpowers/specs/2026-07-12-continuation-model-routing-design.md`
- `docs/superpowers/specs/2026-07-11-model-router-model-pool-failover-design.md`
- `docs/superpowers/plans/2026-07-12-continuation-model-routing.md`
- `docs/superpowers/plans/2026-07-11-model-router-model-pool-failover.md`
- `docs/pi-model-routing-design.md`（设计文档，已附加放弃说明）

### 已清理的运行时文件

以下 `~/.pi/agent/` 中的文件已移除或迁移：

- `extensions/model-router.ts` → 移除 symlink
- `model-router.json` → 移至 `model-router/config/`
- `model-router-health.json` → 删除（运行时状态）
- `model-router-logs/` → 删除（日志文件）
