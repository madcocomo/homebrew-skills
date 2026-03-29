# Benchmark Results: information-presentation

## Summary

| Configuration | Pass Rate | Time (s) | Tokens |
|--------------|-----------|-----------|--------|
| with_skill   | 1.00      | 41.4      | 13,282 |
| without_skill | 0.33     | 44.3      | 13,481 |

**Delta**: +0.67 pass rate, -2.9s time, -199 tokens

## Eval: explain-order-system-code

### with_skill
- Pass Rate: 1.00 (3/3)
- Time: 41.4s
- Tokens: 13,282

**Assertions**:
- ✅ 使用了状态机模式或流程图展示订单状态流转
- ✅ 使用了表格展示折扣规则
- ✅ 展示了完整的工作流程

### without_skill
- Pass Rate: 0.33 (1/3)
- Time: 44.3s
- Tokens: 13,481

**Assertions**:
- ❌ 使用了状态机模式或流程图展示订单状态流转
- ❌ 使用了表格展示折扣规则
- ✅ 展示了完整的工作流程

## Observations

1. 带skill版本正确使用了可视化模式（流程图、状态机）来呈现订单状态流转
2. 带skill版本在时间和token消耗上略有优势
3. 不带skill版本只使用纯文字描述，缺少可视化表示
