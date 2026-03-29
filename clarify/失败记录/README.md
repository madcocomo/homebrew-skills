# clarify - AI呈现清晰度模式研究系统

## 项目概述

本系统旨在研究并创建一套模式语言，用于指导AI如何呈现信息，使其更容易被人类理解，更容易发现错误。

## 采纳的模式

### 必需模式 (Required)
- **COR-01**: Prompt-Defined Agent - 使用自然语言Blueprint定义Agent行为
- **COR-02**: Intelligent Runtime - 依赖智能运行时环境执行
- **STR-01**: Reference Data Configuration - 将领域知识与方法论分离
- **STR-06**: Methodological Guidance - 外部化的方法论指导
- **BHV-02**: Faithful Agent Instantiation - 遵循标准Agent调用规范
- **QUA-03**: Verifiable Data Lineage - 数据溯源与可验证性

### 推荐模式 (Recommended)
- **QUA-01**: Embedded Quality Standards - 内嵌质量标准
- **QUA-02**: Layered Quality Assurance - 分层质量保障
- **STR-02**: Filesystem Data Bus - 基于文件系统数据总线
- **STR-03**: Workspace Isolation - 工作空间隔离

## 系统架构

```
clarify/
├── agents/                      # Agent Blueprints
│   ├── 00.orchestrator.md      # 研究协调器
│   ├── 01.initial_scanner.md    # 初始扫描器
│   ├── 02.pattern_analyst.md   # 模式分析师
│   └── 03.pattern_synthesizer.md # 模式合成器
├── references/                  # 参考数据
│   ├── domain/                  # 领域知识
│   │   └── research_topics.md  # 研究主题清单
│   └── methodology/            # 方法论指导
│       ├── research_overview.md # 研究概述
│       ├── data_sources.md     # 数据源指南
│       ├── analysis_methods.md # 分析方法
│       └── output_template.md  # 输出模板
├── workspace/                   # 运行时工作空间
│   └── ...
├── wip/                        # 进展记录
│   └── notes.md
└── README.md                   # 本文件
```

## 启动方式

1. 使用支持POMASA的智能运行时环境（如Claude Code）
2. 启动Orchestrator Agent: `agents/00.orchestrator.md`
3. Orchestrator将协调整个研究流程

## 研究流程

1. **Initial Scanner**: 广泛搜集关于AI可解释性、人机交互、错误检测、提示工程等相关领域的文献和资源
2. **Pattern Analyst**: 分析收集的材料，识别出关于AI呈现清晰度的关键模式
3. **Pattern Synthesizer**: 整合分析结果，创建结构化的模式语言文档
4. **最终输出**: 一份完整的"AI呈现清晰度模式集"文档

## 模式集预期内容

产出的模式集将包含两大类模式：

1. **可理解性增强模式** - 指导AI如何使输出更容易被人类理解：
   - 结构化呈现模式
   - 层次化信息组织
   - 上下文感知提示
   - 不确定性表达

2. **错误发现模式** - 指导AI如何使输出中的错误更容易被发现：
   - 可验证性标注
   - 置信度透明化
   - 推理过程外显
   - 异常标记规范
