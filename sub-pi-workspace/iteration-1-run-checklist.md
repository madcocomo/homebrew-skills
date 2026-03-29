# iteration-1 运行检查清单

## 启动前
- [ ] `SKILL.md` 已通过基本校验
- [ ] `evals/evals.json` 已存在且包含 5 个核心 case
- [ ] 已准备 workspace 目录
- [ ] 已准备 `with_skill` 与 `without_skill` 两类运行
- [ ] 已确认使用 `python3` 而不是 `python`
- [ ] 已确认长任务通过 `tmux` 启动

## 执行步骤
- [ ] 运行 `prepare_iteration.py` 创建 iteration-1 目录、prompt、metadata、manifest
- [ ] 运行 `launch_iteration1.py` 启动 10 个 tmux session
- [ ] 观察 tmux session 直到全部完成
- [ ] 检查每个 run 是否生成 `final-response.md`
- [ ] 检查每个 run 是否生成 `timing.json`
- [ ] 检查是否有明显失败或空输出

## 完成后
- [ ] 汇总 with_skill 与 without_skill 输出差异
- [ ] 至少做一轮 expectation 对照检查
- [ ] 输出 iteration-1 结果摘要
