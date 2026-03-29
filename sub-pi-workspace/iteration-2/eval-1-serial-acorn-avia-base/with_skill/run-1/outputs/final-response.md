可以，按你的偏好，这个我会用**串行独立 pi 进程**来做，主线程只负责编排和看摘要，不先在主线程里铺开读代码。

## 我会怎么编排

### Step 1：acorn 子进程
- **session**：`pi-acorn-folder-query`
- **工作目录**：`/Users/wuke/code/AH/acorn`
- **职责**：
  - 只在 acorn 内局部阅读 `Folder` 查询相关实现
  - 完成修改
  - 运行验收：**`mvn clean install`**（这是 acorn 的硬门槛）
  - 失败时先在子进程内做第一轮诊断
- **输出**：
  - `status.json`
  - `summary.md`
  - 构建日志 / stderr

### Gate：只有 acorn 过门槛才继续
继续条件我会设成：
- 代码修改完成
- `mvn clean install` 成功
- 子进程摘要明确建议可进入下一步

主线程默认只读：
1. `status.json`
2. `summary.md`

不够再看日志。

### Step 2：avia-base 子进程
- **session**：`pi-avia-folder-query-caller`
- **工作目录**：`/Users/wuke/code/AH/avia-base`
- **前置输入**：
  - acorn 第一步的摘要
  - 受影响 API / 调用约定变化
- **职责**：
  - 只在 avia-base 内局部阅读调用方
  - 完成适配修改
  - 运行定向验证（默认先让子进程自己判定最小有效验证；必要时跑 `mvn test` 或更窄范围）
- **输出**：
  - `status.json`
  - `summary.md`
  - 测试日志 / stderr

### 最后主线程做的事
只做汇总：
- 改了哪些文件
- acorn 构建是否通过
- avia-base 调用方是否适配完成
- 风险和后续建议

---

## 建议的产物路径

我会统一放到类似目录，方便回收：

- `/tmp/ah-folder-query/acorn.task.md`
- `/tmp/ah-folder-query/acorn.status.json`
- `/tmp/ah-folder-query/acorn.summary.md`
- `/tmp/ah-folder-query/acorn.full.json`
- `/tmp/ah-folder-query/acorn.stderr.log`

- `/tmp/ah-folder-query/avia.task.md`
- `/tmp/ah-folder-query/avia.status.json`
- `/tmp/ah-folder-query/avia.summary.md`
- `/tmp/ah-folder-query/avia.full.json`
- `/tmp/ah-folder-query/avia.stderr.log`

---

## 这条链路的关键门槛

结合 AH 工作区规则，我会严格按这个顺序推进：

1. **先改 acorn**
2. **必须跑 `mvn clean install`**
3. **通过后再改 avia-base**
4. **主线程不做大段代码分析，只消费子进程摘要**
5. **前一步成功就自动推进下一步**

---

## 我现在还缺的最少信息

如果你要我直接开跑，我还需要你给我这次链路的最小目标，至少一项即可启动第一个子进程：

- 具体是哪个 **Folder 查询行为** 要改
- 相关接口 / 路径 / 参数
- 预期新行为
- 或一条失败现象 / 示例请求

比如你只要告诉我：
- “某个 Folder 查询现在没带上 xxx”
- “childDirs/childFiles 的行为要变”
- “某个 path 查询返回不对”

我就可以把细节分析下沉到第一个独立 pi 进程里。

---

## 如果你要我现在执行
你直接回复一句：

**“开跑，先做 acorn”**

我就会：
- 创建 task file
- 用 `tmux` 拉起 `pi-acorn-folder-query`
- 等它产出摘要
- 过 gate 后自动启动 avia-base 子进程