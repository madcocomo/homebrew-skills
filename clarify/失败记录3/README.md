# AI信息呈现清晰度模式研究系统

## 系统目标

本研究系统旨在系统性研究、扩展和完善"AI信息呈现清晰度模式集"——一套指导AI如何**呈现**信息，使人类更容易理解、更容易发现错误的模式语言。

### 核心目标

1. **模式分析**: 深入分析现有模式集的结构、关系和完整性
2. **问题诊断**: 识别之前生成结果的缺陷，理解什么是"信息呈现"而什么是"提示词优化"
3. **模式重构**: 基于问题诊断，重构真正聚焦于信息呈现的模式
4. **质量保证**: 确保模式的可操作性和实用性

### 关键区分（重要）

本系统要产生的模式与以下内容有本质区别：

| 本系统模式（信息呈现） | 避免的内容（提示词优化） |
|----------------------|----------------------|
| 指导AI如何组织输出的结构 | 指导用户如何写更好的提示词 |
| 指导AI如何标注不确定性 | 指导AI如何减少幻觉 |
| 指导AI如何呈现推理过程 | 指导用户如何用Chain-of-Thought |
| 指导AI如何提供可验证的来源 | 指导用户如何验证AI的输出 |

---

## 架构说明

本系统采用以下POMASA模式：

| 模式 | 应用说明 |
|------|----------|
| COR-01 | 所有Agent通过Blueprint定义 |
| COR-02 | 使用Claude Code作为智能运行时 |
| STR-01 | 参考材料外置到references/目录 |
| STR-06 | 方法论指导独立管理 |
| BHV-02 | Orchestrator严格遵循Blueprint调用子Agent |
| QUA-03 | 建立数据溯源机制，所有引用可验证 |

## 目录结构

```
clarify/
├── agents/                      # Agent Blueprints
│   ├── 00.orchestrator.md       # 主编排器
│   ├── 01.requirement_analyzer.md   # 需求分析器
│   ├── 02.pattern_diagnoser.md       # 模式诊断器
│   ├── 03.pattern_refactor.md        # 模式重构器
│   └── 04.quality_reviewer.md       # 质量审查员
├── references/                  # 参考资料
│   ├── domain/                  # 领域知识
│   │   ├── 目标场景问题.md     # 需求定义
│   │   ├── 失败记录分析.md     # 失败教训分析
│   │   └── 已有模式集.md       # 现有模式（需重构）
│   └── methodology/            # 方法论指导
│       ├── research_overview.md
│       ├── analysis_methods.md
│       └── output_template.md
├── workspace/                   # 运行时工作区
├── wip/                        # 进度记录
│   └── notes.md
└── README.md
```

## 使用方法

### 1. 执行研究

在Claude Code中运行：

```
请读取 agents/00.orchestrator.md 并执行其中的工作流程
```

### 2. 输出结果

最终模式集将输出到：
- `workspace/03.output/重构模式集.md` - 完整的重构版模式集

## Agent职责

1. **Orchestrator**: 协调整个研究流程，管理任务调度
2. **Requirement Analyzer**: 分析需求文档，提取关键定义
3. **Pattern Diagnoser**: 诊断已有模式的缺陷，识别问题类型
4. **Pattern Refactor**: 基于诊断结果，重构真正聚焦于信息呈现的模式
5. **Quality Reviewer**: 审查模式质量，提供改进建议

## 核心研究问题

1. 什么才是真正的"信息呈现"模式？
2. 之前的模式为什么偏离了目标？
3. 如何区分"信息呈现"和"提示词优化"？
4. 重构后的模式如何确保聚焦于呈现方式？
