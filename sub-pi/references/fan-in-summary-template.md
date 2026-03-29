# 主会话 fan-in 汇总模板

当多个子任务完成后，主会话不应直接倾倒全部日志，而应先基于各任务的 `status.json` 和 `summary.md` 做一次收敛汇总。

适用场景：
- 并行批次结束后的统一汇总
- 串并行混合流程中分析阶段结束后的收敛
- 多个局部建议需要统一决策时

---

## 模板

```md
# 主会话汇总

- 目标：<overall-goal>
- 汇总范围：<batch-id 或 workflow-name>
- 总体结论：成功 / 部分成功 / 失败

## 子任务状态
| 子任务 | 结果 | 是否阻塞 | 关键产物 |
|---|---|---|---|
| <task-1> | 成功 | 否 | <summary-path> |
| <task-2> | 失败 | 是 | <summary-path> |

## 关键发现
- <来自 task-1 的关键发现>
- <来自 task-2 的关键发现>
- <需要统一处理的冲突或共性>

## 修改与影响范围
- task-1 修改：...
- task-2 修改：...
- 是否存在重叠修改：是 / 否
- 是否发现共享风险：...

## 验证结果
- task-1：<verification-result>
- task-2：<verification-result>
- 总体是否满足当前阶段门槛：是 / 否

## 风险与阻塞
- <风险 1>
- <阻塞 1>

## 建议下一步
- <进入下一串行步骤>
- <重新拆分失败任务>
- <先人工确认，再继续>
```

---

## 最小可用示例

```md
# 主会话汇总

- 目标：评估 3 个 controller 是否存在重复异常处理，并决定是否进入统一重构
- 汇总范围：batch-controller-review
- 总体结论：部分成功

## 子任务状态
| 子任务 | 结果 | 是否阻塞 | 关键产物 |
|---|---|---|---|
| task-user-controller | 成功 | 否 | /tmp/.../task-user-controller/summary.md |
| task-order-controller | 成功 | 否 | /tmp/.../task-order-controller/summary.md |
| task-document-controller | 失败 | 否 | /tmp/.../task-document-controller/summary.md |

## 关键发现
- UserController 和 OrderController 都存在重复 try/catch
- 两处都建议抽到统一异常处理层
- DocumentController 的分析因测试环境问题未完全完成

## 修改与影响范围
- 当前批次仅 user/order 两个任务有局部修改
- 未发现文件重叠修改
- 发现若要继续深化，后续可能需要改公共异常处理层

## 验证结果
- task-user-controller：指定测试通过
- task-order-controller：静态检查通过
- task-document-controller：测试环境失败
- 总体是否满足当前阶段门槛：是（可进入统一方案设计）

## 风险与阻塞
- 若直接并行落地公共层改造，可能产生冲突
- document 分支的结论不完整

## 建议下一步
- 启动一个新的串行收敛任务，统一设计公共异常处理方案
- document 分支问题单独拆为环境诊断任务
```

---

## 使用原则

主会话在 fan-in 时应优先：
1. 看每个子任务是否成功
2. 看是否阻塞下一步
3. 看是否出现范围重叠或共享风险
4. 再决定继续串行推进、重新拆分，还是回到用户确认

只有在这些信息不足时，才去读更详细的日志文件。
