# AI信息呈现模式研究系统

## 系统目标

产生一套模式集合，用于指导AI在展示信息时：
1. 更容易让人理解
2. 更容易让人发现错误

## 核心聚焦

**本系统聚焦于"信息展示方式"，而非：**
- 如何改进提示词让AI产生更好结果
- 如何减少AI产生错误

**关键原则**：帮助人类更好地理解和验证AI输出的信息，而非帮助AI本身改进。

## 目录结构

```
clarify/
├── agents/                      # Agent Blueprints
│   ├── 00.orchestrator.md      # 研究协调器
│   ├── 01.requirement_analyzer.md  # 需求分析器
│   ├── 02.pattern_generator.md     # 模式生成器
│   └── 03.quality_reviewer.md     # 质量审查器
├── references/                  # 参考数据
│   ├── domain/                  # 领域知识
│   │   ├── 目标场景问题.md
│   │   └── 失败记录分析.md
│   └── methodology/            # 方法论指导
│       ├── research_overview.md
│       ├── output_template.md
│       └── quality_criteria.md
├── workspace/                   # 运行时工作空间
│   ├── 01.materials/
│   ├── 02.analysis/
│   └── 03.output/
├── wip/
│   └── notes.md
└── README.md
```

## 执行流程

### 阶段一：需求分析
- 理解目标：信息展示方式使人更容易理解和发现错误
- 分析问题根源：人的认知限制、AI输出特性
- 聚焦于"展示"而非"生成"

### 阶段二：模式生成
- 基于用户建议的模式思路生成具体模式
- 聚焦于可视化表示、实例化、验证机制等
- 避免"如何改进提示词"的内容

### 阶段三：质量审查
- 审查模式是否符合聚焦目标
- 排除反例模式
- 确保模式实用性

## 采纳的POMASA模式

- COR-01: Prompt-Defined Agent
- COR-02: Intelligent Runtime
- STR-01: Reference Data Configuration
- STR-06: Methodological Guidance
- BHV-02: Faithful Agent Instantiation
- QUA-03: Verifiable Data Lineage
