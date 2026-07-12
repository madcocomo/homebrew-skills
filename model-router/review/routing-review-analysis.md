# Routing Review 诊断分析

生成时间: 2026-07-11

## 摘要

模型路由审计日志（2026-07-10 ~ 2026-07-11）共 800 条记录，44 个唯一请求（按 requestId），全部 admission verdict 为 **strong**，无一降级到 weak 模型。classifier 始终为 **skipped**（从未调用）。

## 根因分析

所有请求无法降级的根因是 **单一因素**：

### `scope_ambiguous` — 占 100% 的初始请求

降级链路如下：

```
用户 prompt
    ↓
extractExplicitFacts(prompt)          ← 要求 prompt 包含显式标签格式
    ↓
hasExplicitStructure = false          ← 自然语言对话没有这些标签
    ↓
buildTaskCapsule → { status: "ambiguous" }
    ↓
evaluateAdmission:
  capsule.status === "ambiguous" → strong.add("scope_ambiguous")
    ↓
verdict = "strong"
    ↓
classification.status = "skipped"     ← classifier 永不调用
    ↓
targetModel = null                    ← 不降级到 weak
```

### 触发条件

`extractExplicitFacts()` 函数只识别以下显式标签（大小写不敏感）：

| 标签 | 示例 |
|------|------|
| `Objective:` | `Objective: Fix the date parsing bug in src/utils/date.ts` |
| `Allowed write:` | `Allowed write: src/utils/date.ts, tests/date.test.mjs` |
| `Allowed read:` | `Allowed read: src/utils/*.ts` |
| `Forbidden:` | `Forbidden: src/legacy/` |
| `Steps:` | `Steps: 1. edit src/utils/date.ts to fix the regex` |
| `Artifacts:` | `Artifacts: src/utils/date.ts` |
| `Verification:` | `Verification: \`node --test tests/date.test.mjs\`` |

**如果 prompt 中不包含上述任何一个标签**，`hasExplicitStructure` 即为 false，capsule 立即返回 `ambiguous`，admission 输出 `scope_ambiguous` → strong。

### 附加因素

22 条记录（含 continuation）同时触发 `broad_analysis_or_design`，匹配了以下 regex 模式：

```
BROAD_ANALYSIS_PATTERN = /root cause|architecture|re-?design|re-?architect|
    open-ended|investigate why|investigate the|audit the entire|
    根因|架构|开放式|全面(分析|排查)|排查.*(原因|问题)/i
```

## 统计数据

### 按 reason code 分布（所有 800 条记录）

| Reason Code | 出现次数 |
|---|---|
| `scope_ambiguous` | 800 |
| `broad_analysis_or_design` | 22 |

### 按 verdict 分布

| Verdict | 次数 |
|---|---|
| `strong` | 800 |
| `eligible` | 0 |
| `reject` | 0 |

### 按 classification status

| Status | 次数 |
|---|---|
| `skipped` | 800 |
| `ok` | 0 |
| `failed` | 0 |

### 使用的模型（actualModel）

| 模型 | 初始请求数 |
|---|---|
| `openai-codex/gpt-5.6-sol` | 27 |
| `opencode/deepseek-v4-flash-free` | 8 |
| `openai-codex/gpt-5.6-terra` | 2 |
| `nvidia-free/z-ai/glm-5.2` | 2 |
| `nvidia-free/minimaxai/minimax-m3` | 2 |
| `opencode/claude-opus-4-8` | 1 |
| `nvidia-free/deepseek-ai/deepseek-v4-pro` | 1 |
| `deepseek/deepseek-v4-flash` | 1 |

## 导出文件

- `routing-review-all-entries.tsv` — 800 条完整审计记录（TSV 格式，可用 Excel/Numbers 打开）
- `routing-review-analysis.md` — 本诊断文件

## 调整建议

要让降级生效，需要在用户 prompt 中包含显式标签结构。以下是示例格式：

```
Objective: Fix the date parsing bug in src/utils/date.ts
Allowed write: src/utils/date.ts, tests/date.test.mjs
Allowed read: src/utils/*.ts
Forbidden: src/legacy/
Steps:
1. Read src/utils/date.ts to understand the current parsing logic
2. Edit src/utils/date.ts to fix the ISO 8601 regex
3. Write the corrected test expectation in tests/date.test.mjs
Artifacts: src/utils/date.ts, tests/date.test.mjs
Verification: `node --test tests/date.test.mjs`
```

如果不希望用户手动写标签，可以考虑：
1. 降低 `extractExplicitFacts` 的严格程度（允许从自然语言推断）
2. 让 capsule builder 在 ambiguous 时尝试调用 classifier 补全
3. 修改 admission 规则，ambiguous 时不强制 strong

**注意：** 方案 1 和 2 会引入不确定性，违背设计文档的安全原则（"不猜测"）。方案 3 会改变安全不变量（"规则优先，不能被 classifier 覆盖"）。建议与设计评审讨论。