#!/usr/bin/env zsh
# ============================================================================
# model-router shadow 决策收集与分析工具
# ============================================================================
# 用法:
#   1. 将 ~/.pi/agent/model-router.json 的 mode 设为 "shadow"
#   2. 正常使用 Pi（shadow 模式下 extension 不会改模型）
#   3. 运行此脚本分析日志:
#      zsh docs/examples/shadow-eval.sh ~/.pi/agent/model-router-logs
# ============================================================================

set -u
LOG_DIR="${1:-$HOME/.pi/agent/model-router-logs}"
OUTPUT="${2:-/tmp/model-router-shadow-eval.md}"

if [[ ! -d "$LOG_DIR" ]]; then
  echo "错误: 日志目录不存在: $LOG_DIR"
  echo "用法: $0 [日志目录] [输出文件]"
  exit 1
fi

: > "$OUTPUT"

{
  echo "# model-router shadow 决策评估报告"
  echo
  echo "**生成时间**: $(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "**日志目录**: $LOG_DIR"
  echo
} > "$OUTPUT"

# 合并所有 JSONL 到一个临时文件
ALL_JSONL=$(mktemp)
for f in "$LOG_DIR"/*.jsonl; do
  [[ -f "$f" ]] && cat "$f" >> "$ALL_JSONL"
done

python3 - "$ALL_JSONL" "$OUTPUT" << 'PYEOF'
import json, sys, os
from collections import Counter, defaultdict

jsonl_path = sys.argv[1]
output_path = sys.argv[2]

records = []
with open(jsonl_path) as f:
    for line in f:
        line = line.strip()
        if line:
            records.append(json.loads(line))

os.unlink(jsonl_path)

initials = [r for r in records if r.get('decisionKind') == 'initial']
completions = [r for r in records if r.get('decisionKind') == 'completion']
continuations = [r for r in records if r.get('decisionKind') == 'continuation']
sessions = set(r.get('sessionId') for r in records if r.get('sessionId'))

with open(output_path, 'a') as f:
    def w(s):
        f.write(s + '\n')

    w(f"\n## 摘要\n")
    w("| 指标 | 值 |")
    w("|------|----|")
    w(f"| JSONL 条目 | {len(records)} |")
    w(f"| 独立 session | {len(sessions)} |")
    w(f"| 初始决策 (initial) | {len(initials)} |")
    w(f"| 延续 (continuation) | {len(continuations)} |")
    w(f"| 完成 (completion) | {len(completions)} |")

    if not initials:
        w("\n**⚠️ 没有初始决策记录。确认已在 shadow 模式下运行。**")
        sys.exit(0)

    # 1. 分流分布
    verdicts = Counter(r['admission']['verdict'] for r in initials)
    eligible = [r for r in initials if r['admission']['verdict'] == 'eligible']
    strong = [r for r in initials if r['admission']['verdict'] == 'strong']
    rejected = [r for r in initials if r['admission']['verdict'] == 'reject']

    w("\n## 1. 分流分布\n")
    w("| verdict | 数量 | 占比 |")
    w("|---------|------|------|")
    w(f"| eligible (→weak) | {len(eligible)} | {len(eligible)/len(initials)*100:.1f}% |")
    w(f"| strong | {len(strong)} | {len(strong)/len(initials)*100:.1f}% |")
    w(f"| reject | {len(rejected)} | {len(rejected)/len(initials)*100:.1f}% |")

    w("\n**classifier 调用**:")
    for status, count in Counter(r['classification']['status'] for r in initials).most_common():
        w(f"- {status}: {count} ({count/len(initials)*100:.1f}%)")

    w("\n**目标模型**:")
    for model, count in Counter(r.get('targetModel') for r in initials if r.get('targetModel')).most_common():
        w(f"- {model}: {count}")

    w("\n**实际模型** (shadow 下即默认):")
    for model, count in Counter(r.get('actualModel') for r in initials if r.get('actualModel')).most_common():
        w(f"- {model}: {count}")

    # 2. Eligible 任务内的分类器决策
    if eligible:
        w("\n## 2. Eligible 任务的分类器决策\n")
        cls_routes = Counter()
        for r in eligible:
            dec = r.get('classification', {}).get('route', 'unknown')
            cls_routes[dec] += 1
        w("| 决策 | 数量 | 占比 |")
        w("|------|------|------|")
        for route, count in cls_routes.most_common():
            w(f"| {route} | {count} | {count/len(eligible)*100:.1f}% |")

        weak_decisions = [r for r in eligible if r.get('classification', {}).get('route') == 'weak']
        if weak_decisions:
            confs = [r['classification'].get('confidence', 0) for r in weak_decisions
                     if r['classification'].get('confidence') is not None]
            if confs:
                w(f"\n**weak 决策置信度**: min={min(confs):.2f} max={max(confs):.2f} mean={sum(confs)/len(confs):.2f}")
                below90 = sum(1 for c in confs if c < 0.9)
                w(f"  低于阈值 0.9: {below90}/{len(confs)}")

    # 3. Strong reason codes
    if strong:
        w("\n## 3. Strong 理由分布\n")
        rc_counts = Counter()
        for r in strong:
            for rc in r['admission']['reasonCodes']:
                rc_counts[rc] += 1
        w("| reason code | 次数 |")
        w("|-------------|------|")
        for rc, count in rc_counts.most_common():
            w(f"| {rc} | {count} |")

    # 4. 工具调用统计
    w("\n## 4. 工具调用统计\n")
    all_tc = [r.get('toolSummary', {}).get('count', 0) for r in records]
    all_err = [r.get('toolSummary', {}).get('errors', 0) for r in records]
    nonzero = [r.get('toolSummary', {}).get('nonzeroExits', 0) for r in records]
    w("| 指标 | 总计 |")
    w("|------|------|")
    w(f"| 工具调用 | {sum(all_tc)} |")
    w(f"| 工具错误 | {sum(all_err)} |")
    w(f"| 非零退出 | {sum(nonzero)} |")

    # 5. 成本估算
    w("\n## 5. 成本估算\n")
    eligible_cost = 0.0
    strong_cost = 0.0
    for r in completions + continuations:
        cost = (r.get('actualUsage') or {}).get('cost', {})
        total = cost.get('total', 0) or 0
        rid = r.get('requestId')
        init = next((i for i in initials if i.get('requestId') == rid), None)
        if init and init['admission']['verdict'] == 'eligible':
            eligible_cost += total
        else:
            strong_cost += total
    w(f"| 类别 | 总成本 |")
    w(f"|------|--------|")
    w(f"| eligible (shadow) | ${eligible_cost:.6f} |")
    w(f"| strong (shadow) | ${strong_cost:.6f} |")
    w(f"| **总计** | **${eligible_cost+strong_cost:.6f}** |")

    # 6. 升级信号
    w("\n## 6. 升级信号\n")
    sig_counter = Counter()
    for r in records:
        for s in r.get('upgradeSignals', []):
            sig_counter[s] += 1
    if sig_counter:
        w("| 信号 | 次数 |")
        w("|------|------|")
        for s, count in sig_counter.most_common():
            w(f"| {s} | {count} |")
    else:
        w("(无升级信号)")

    w("\n---")
    w("*报告由 shadow-eval.sh 自动生成*")
PYEOF

echo ""
echo "=== 报告已写入: $OUTPUT ==="
cat "$OUTPUT"
