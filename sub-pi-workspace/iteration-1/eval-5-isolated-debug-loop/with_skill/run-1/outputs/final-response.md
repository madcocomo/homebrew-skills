可以，按你这个诉求，**就组织成一个单独的隔离子任务**，不要拆成多任务流。

## 推荐模式

### 1) 主线程只做编排
主线程只定义这几件事：
- 目标测试是什么
- 工作目录是什么
- 允许修改哪些文件
- 用什么命令验证
- 最终只读取：
  1. `status.json`
  2. `summary.md`
- **默认不看详细日志**，只有失败或摘要不够时才展开 `stderr.log` / 测试日志

### 2) 独立 pi 进程负责完整闭环
这个子进程内部自己完成：
- 局部阅读
- 失败诊断
- 必要修改
- 重试验证
- 失败时第一轮自查
- 输出精简摘要和下一步建议

---

## 建议的文件组织

假设工作目录是 `<workdir>`，任务名叫 `pi-test-debug`。

### 子任务输入文件
`/tmp/pi-test-debug.md`

```md
任务：排查并修复一个指定测试失败，只处理该测试相关的局部问题

工作目录：<workdir>

范围：
- 允许阅读和修改与该测试失败直接相关的代码和测试文件
- 允许运行定向测试命令
- 允许在局部边界内做一次必要修复并重试

禁止修改：
- 与该测试无关的模块
- 大范围重构
- 无关格式化
- 升级依赖或改构建体系，除非它就是该失败的直接原因且属于最小改动

要求：
1. 先读失败测试和相关实现，再决定修改
2. 先做第一轮失败归因，不要盲改
3. 保持最小修改
4. 在子进程内完成“修改后重试验证”
5. 如果第一次修复失败，在原边界内再诊断一次；若仍失败，输出阻塞原因与建议

测试信息：
- 失败测试：<test-name-or-class>
- 验证命令：<test-command>

最终输出必须写入以下文件：
- 状态文件：/tmp/pi-test-debug.status.json
- 摘要文件：/tmp/pi-test-debug.summary.md
- 测试日志：/tmp/pi-test-debug.test.log

状态文件至少包含：
- success: true/false
- modifiedFiles: [...]
- summaryFile: "/tmp/pi-test-debug.summary.md"
- verifications: [...]
- nextStepSuggestion: "..."

摘要文件请只保留：
- 修改文件
- 失败原因判断
- 核心改动
- 验证结果
- 当前风险
- 下一步建议
```

---

## 建议输出文件

### 1. 状态文件
`/tmp/pi-test-debug.status.json`

示例结构：

```json
{
  "success": true,
  "summaryFile": "/tmp/pi-test-debug.summary.md",
  "modifiedFiles": [
    "src/main/java/...",
    "src/test/java/..."
  ],
  "verifications": [
    {
      "command": "mvn -Dtest=SomeTest test",
      "success": true,
      "log": "/tmp/pi-test-debug.test.log"
    }
  ],
  "nextStepSuggestion": "可继续跑相邻回归测试"
}
```

### 2. 摘要文件
`/tmp/pi-test-debug.summary.md`

建议格式：

```md
# 子任务摘要
- 任务：定向排查测试失败
- 结果：成功 / 失败
- 修改文件：...
- 失败原因：...
- 核心改动：...
- 验证结果：...
- 风险：...
- 下一步建议：...
```

### 3. 详细文件
- `/tmp/pi-test-debug.stderr.log`
- `/tmp/pi-test-debug.full.json`
- `/tmp/pi-test-debug.test.log`

这些给主线程兜底，**默认不读**。

---

## 启动方式（单独一个 tmux 会话）

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
  -s pi-test-debug \
  "cd <workdir> && zsh -c 'source \"$HOME/.zshrc\" && pi --mode json -p @/tmp/pi-test-debug.md > /tmp/pi-test-debug.full.json 2> /tmp/pi-test-debug.stderr.log'"
```

---

## 主线程回收结果的规则

主线程只按这个顺序消费：

1. 读 `/tmp/pi-test-debug.status.json`
2. 再读 `/tmp/pi-test-debug.summary.md`
3. **只有失败或摘要不足时**，才看：
   - `/tmp/pi-test-debug.stderr.log`
   - `/tmp/pi-test-debug.test.log`
   - `/tmp/pi-test-debug.full.json`

也就是说，主线程默认只拿：
- 最终结果
- 修改范围
- 验证是否通过
- 下一步建议

---

## 你这个场景的一句话编排

> 只启动 **一个** 独立 pi 进程，把“阅读、诊断、修改、重试验证”全部下沉到子进程；主线程默认只读取 `status.json` 和 `summary.md`，不消费详细日志。

---

## 如果你要我直接替你落地
把下面 4 项给我，我可以直接帮你生成可执行版本：

- `workdir`
- `失败测试命令`
- `失败测试名/类名`
- `允许修改范围`

我可以下一条直接帮你产出：
1. 完整的 `/tmp/pi-test-debug.md`
2. 可直接运行的 `tmux` 启动命令
3. 主线程读取结果的最小操作步骤