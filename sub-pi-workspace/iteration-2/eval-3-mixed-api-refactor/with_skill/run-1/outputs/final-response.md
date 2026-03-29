可以，先按**“串行定义边界 → 并行审查三块 → 串行收敛方案”**来设计，主线程只做编排和收敛，不下沉到实现细节。

## 总体模式

这次建议用 **混合编排**，不是纯串行也不是纯并行：

1. **串行阶段 1：定义边界与验收标准**
2. **并行阶段 2：分别审查 controller / service / BDD tests**
3. **串行阶段 3：汇总冲突、统一决策、形成落地方案**

> 并行阶段默认做**分析与建议**，**不并发改同一套实现文件**，避免 controller/service/tests 同时改同一条 API 代码导致冲突。

---

## 阶段 1：先定义边界与验收标准

这一阶段由主线程完成，只产出“任务边界文档”，不给任何子任务自由扩 scope。

### 1) 边界定义

建议先把目标 API 改造限定为下面四类内容：

- **允许分析/修改**
  - 目标 API 对应的 controller
  - 目标 API 对应的 service / facade / app service
  - 目标 API 对应的 BDD feature、step definitions、test fixtures
  - 直接相关的 DTO / request / response model
- **允许阅读但默认不修改**
  - 相关 repository / client / mapper
  - 相邻 API 的实现，用作对照
- **禁止修改**
  - 不相关 endpoint
  - 全局异常处理、认证鉴权、公共框架层
  - 跨模块共享 contract，除非在收敛阶段明确批准
  - 大范围重构、命名清洗、风格整理

### 2) 并行阶段的工作原则

并行阶段三块任务都遵守：

- **先读后评估**
- **默认只输出建议，不直接落代码**
- **不修改共享实现文件**
- **每个子任务只产出摘要，不回传长日志**
- **如发现 scope 扩大，只上报，不自行扩展**

### 3) 验收标准

建议把验收标准写成统一 gate，供后续 fan-in 使用：

#### 功能一致性
- 目标 API 的业务语义清晰且唯一
- 新旧 contract 差异被明确列出
- breaking change / non-breaking change 被区分

#### 接口一致性
- controller 层的 path、method、status code、request/response shape 有明确方案
- service 层的输入输出、事务边界、错误语义有明确方案
- BDD tests 能覆盖新 contract 的主路径和关键异常路径

#### 回归安全
- 不影响未纳入本次改造范围的其他 API
- 迁移路径明确：一次切换 or 兼容期双轨
- 风险点有列表，缺口有补测建议

#### 落地可执行性
- 最终方案能拆成明确实施顺序
- 每一步修改范围清楚
- 有对应验证命令或验证动作

---

## 阶段 2：并行审查三块

这里建议开一个并行批次，例如 `batch-api-review-a`。  
三个子任务**只做分析**，不要并发改代码。

---

### 任务 A：controller 审查

**目标**：只审 controller 层 contract 与适配成本。

**关注点**
- endpoint path / method / params 是否变化
- request validation 是否需要调整
- response schema 是否变化
- HTTP status code / error mapping 是否变化
- 是否需要兼容旧字段、旧路径、旧参数

**输出**
- 受影响 controller 文件列表
- contract 差异清单
- controller 层最小改造建议
- 对 service 的依赖约束
- 风险：哪些变化会影响前端/调用方/测试

**建议 session 名**
- `pi-api-review-controller`

---

### 任务 B：service 审查

**目标**：只审 service 层的业务语义、方法签名、调用链和兼容策略。

**关注点**
- 现有 service 方法是否还能承载新 API 语义
- 是否需要新增 service method 而不是直接改旧方法
- DTO/domain mapping 是否变化
- 错误语义、事务边界、幂等性是否受影响
- 是否存在对 controller 的反向耦合

**输出**
- 受影响 service 文件列表
- service contract 差异清单
- 推荐方案：改旧接口 / 包一层适配 / 新增方法并迁移
- 对 controller 和 tests 的约束
- 风险：隐藏耦合、回归面、迁移难点

**建议 session 名**
- `pi-api-review-service`

---

### 任务 C：BDD tests 审查

**目标**：只审 BDD coverage 是否能表达改造后的 API 行为。

**关注点**
- feature 文件中的行为描述是否仍成立
- step definitions 是否绑定旧字段/旧响应结构
- fixture / test data 是否依赖旧 contract
- 是否缺少异常路径、兼容路径、回归路径
- 哪些现有用例应该保留，哪些应该迁移

**输出**
- 受影响 BDD 文件列表
- 现有覆盖缺口
- 需要新增/修改/废弃的场景清单
- 对 controller/service 方案的测试约束
- 风险：测试名义通过但语义失真

**建议 session 名**
- `pi-api-review-bdd`

---

## 并行阶段的产物规范

每个子任务只交三类产物：

1. `status.json`
2. `summary.md`
3. `stderr.log` / `full.json`（仅失败时再看）

### 推荐命名

- `/tmp/pi-api-review-controller.status.json`
- `/tmp/pi-api-review-controller.summary.md`

- `/tmp/pi-api-review-service.status.json`
- `/tmp/pi-api-review-service.summary.md`

- `/tmp/pi-api-review-bdd.status.json`
- `/tmp/pi-api-review-bdd.summary.md`

### 每份 summary 最少包含

- 任务结果：成功 / 失败
- 分析文件范围
- 关键发现
- 建议改造点
- 风险与阻塞
- 是否建议进入统一收敛阶段

---

## 阶段 3：串行收敛成统一落地方案

主线程只读三个摘要，不看细节日志，做一次 fan-in。

### 收敛时要回答的 5 个问题

1. **最终 API contract 是什么？**
2. **controller 与 service 谁跟谁适配？**
3. **是否需要兼容期？兼容多久？**
4. **BDD tests 应如何重写才能表达新 contract？**
5. **实施顺序怎么排，风险最小？**

### 统一方案建议输出格式

#### 1. 最终决策
- 保留旧接口并加适配层 / 直接替换 / 双轨过渡
- controller 是否兼容旧字段
- service 是否新增新方法承接新语义

#### 2. 统一修改顺序
建议采用串行落地：

1. 先改 service contract / 适配层设计
2. 再改 controller 暴露方式
3. 最后改 BDD tests 与 fixtures
4. 跑回归验证

#### 3. 风险矩阵
- 高风险：breaking response schema
- 中风险：service 行为语义变化
- 低风险：BDD 文案和 step 调整

#### 4. 验证清单
- 目标 BDD 场景通过
- 旧兼容场景（如保留）通过
- 关键 error path 通过
- 非目标 API 无回归

---

## 为什么这样拆

这样拆的好处是：

- **主线程只管边界、gate、汇总**
- **controller / service / BDD 各自独立审查**
- **并行阶段不改共享实现，避免冲突**
- **最后统一决策，防止三边各自给出互相矛盾的改法**

---

## 如果你要真正开跑

下一步我可以直接帮你生成一套：

- 3 个并行子任务 prompt
- 对应的 tmux session 名
- status/summary/log 文件路径
- 最终 fan-in 汇总模板

如果你说一句 **“按这个方案开跑”**，我就进入执行模式。