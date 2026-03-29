可以，按这个需求应走**规划模式**：先把“独立 pi 调试闭环”组织好，**不直接启动**。

## 推荐组织方式

### 1. 主线程只负责 5 件事
1. 定义失败测试
2. 定义允许修改范围
3. 定义验证命令
4. 启动一个独立 pi 进程
5. 最后只读取：
   - `status.json`
   - `summary.md`

### 2. 子进程负责完整闭环
让独立 pi 进程在自己的上下文里完成：

- 局部阅读相关代码/测试
- 复现失败
- 第一轮失败诊断
- 必要时做最小修改
- 重试验证
- 输出摘要和下一步建议

---

## 建议的目录/文件约定

假设本次任务代号叫 `isolated-test-debug`：

- session：`pi-isolated-test-debug`
- task file：`/tmp/pi-isolated-test-debug.md`
- 结果流：`/tmp/pi-isolated-test-debug.full.json`
- stderr：`/tmp/pi-isolated-test-debug.stderr.log`
- 状态：`/tmp/pi-isolated-test-debug.status.json`
- 摘要：`/tmp/pi-isolated-test-debug.summary.md`
- 测试日志：`/tmp/pi-isolated-test-debug.test.log`

---

## 任务文件模板

你可以把下面内容作为 `/tmp/pi-isolated-test-debug.md`：

```md
任务：排查并尽量修复一个失败测试，把局部阅读、失败诊断、必要修改、重试验证都放在本子任务内完成。主线程只需要最终摘要和下一步建议。

工作目录：<absolute-workdir>

范围：
- 允许读取：<related dirs/files>
- 允许修改：<allowed dirs/files>

禁止修改：
- <forbidden files/dirs>
- 不做无关重构
- 不扩大到不相关模块

要求：
1. 先阅读与失败测试直接相关的测试代码、实现代码、最近相关配置。
2. 先复现失败，再判断失败原因。
3. 在当前边界内完成第一轮诊断，不要把大量原始日志抛回主线程。
4. 如能在允许范围内用最小改动修复，则直接修改并重试。
5. 如果第一次修复失败，可在原边界内再诊断并重试一次。
6. 记录每次验证命令及结果。
7. 最终必须产出 status.json 和 summary.md，供主线程读取。
8. 修改后遵循现有代码风格，显式处理错误，不做无关改动。

失败测试信息：
- 测试模块：<module>
- 测试类/文件：<test class or file>
- 测试方法：<test method>
- 已知现象：<failure message / symptom>

建议阅读起点：
- <file 1>
- <file 2>
- <file 3>

验证：
- <reproduce command> | tee /tmp/pi-isolated-test-debug.test.log
- <targeted rerun command>
- <extra verification command if needed>

输出要求：

1. 写入状态文件：
`/tmp/pi-isolated-test-debug.status.json`

建议格式：
```json
{
  "success": true,
  "summaryFile": "/tmp/pi-isolated-test-debug.summary.md",
  "modifiedFiles": [],
  "verifications": [
    {
      "command": "",
      "success": true,
      "log": "/tmp/pi-isolated-test-debug.test.log"
    }
  ],
  "nextAction": "none"
}
```

2. 写入摘要文件：
`/tmp/pi-isolated-test-debug.summary.md`

摘要必须包含：
- 结果：成功 / 失败 / 部分成功
- 根因判断
- 修改文件
- 核心改动
- 验证结果
- 未解决阻塞
- 下一步建议

如果最终未修复，也要给出：
- 最可能原因
- 已尝试内容
- 建议下一步排查方向
```

---

## 启动模板

等你确认后，再用这个模板实际启动：

```bash
tmux new-session -d \
  -e http_proxy="$http_proxy" \
  -e https_proxy="$https_proxy" \
  -e HTTP_PROXY="$HTTP_PROXY" \
  -e HTTPS_PROXY="$HTTPS_PROXY" \
  -e all_proxy="$all_proxy" \
  -e ALL_PROXY="$ALL_PROXY" \
  -e no_proxy="$no_proxy" \
  -e NO_PROXY="$NO_PROXY" \
  -s pi-isolated-test-debug \
  "cd <workdir> && zsh -c 'source \"$HOME/.zshrc\" && pi --mode json -p @/tmp/pi-isolated-test-debug.md > /tmp/pi-isolated-test-debug.full.json 2> /tmp/pi-isolated-test-debug.stderr.log'"
```

---

## 主线程的回收规则

主线程只按这个顺序消费结果：

1. 读 `/tmp/pi-isolated-test-debug.status.json`
2. 读 `/tmp/pi-isolated-test-debug.summary.md`
3. 只有失败或摘要不足时，才看：
   - `/tmp/pi-isolated-test-debug.stderr.log`
   - `/tmp/pi-isolated-test-debug.test.log`
   - `/tmp/pi-isolated-test-debug.full.json`

这样主线程不会被局部调试细节污染。

---

## 验收门槛

这个独立子任务完成后，只需要回答主线程 4 个问题：

- 测试是否已稳定通过？
- 根因是什么？
- 改了哪些文件？
- 下一步建议是什么？

---

## 最小化主线程输出模板

子进程最终摘要建议长这样：

```md
# 子任务摘要
- 任务：isolated-test-debug
- 结果：成功 / 失败 / 部分成功
- 根因：...
- 修改文件：...
- 核心改动：...
- 验证结果：...
- 风险：...
- 下一步建议：...
```

---

## 你现在只需要补给我的信息

如果你要我下一步帮你**生成可直接运行的 task file 和 tmux 启动命令**，给我这几项即可：

1. 工作目录
2. 失败测试的精确标识
   - 模块
   - 测试类/文件
   - 测试方法
3. 允许修改范围
4. 验证命令
5. 是否现在就启动

如果你愿意，我下一条可以直接帮你产出一份**可落地的 `/tmp/pi-isolated-test-debug.md`** 和对应启动命令。