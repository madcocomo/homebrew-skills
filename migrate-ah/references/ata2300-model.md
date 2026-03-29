# ATA2300 数据模型

新架构基于 ATA2300 规范的文件夹层次结构和原型驱动属性继承。

## 文件夹层级结构

```
/A320 (csdb)                              # 第一层：飞机型号
├── /EN (language)                        # 语言文件夹
│   ├── /DM (data module)                 # 数据模块
│   ├── /ICN (icons)                      # 图示
│   └── /PM (procedural module)           # 程序模块
├── /FR (language)                        # 法语
└── /ZH (language)                        # 中文

/A330 (csdb)                              # 第二架飞机
```

## 原型（Archetype）规则

| 层级 | 原型值 | 说明 |
|------|--------|------|
| 第一层 | `csdb` | 飞机型号文件夹，仅此处设置 |
| 第二层 | 无（继承） | 继承父级的 csdb 原型 |
| 第三层 | 无（继承） | 继承父级所有属性 |

## 属性存储模型

**新模式（当前使用）**：
```json
{
  "path": "/A320",
  "attributeMap": {
    "archetype": "csdb",
    "csdbType": "ATA2300",
    "language": "EN"
  }
}
```

**遗留模式（已废弃）**：
```json
{
  "path": "/A320/Manual01/Profile01",
  "attributeMap": {
    "archetype": "profile",
    "csdbName": "A320",        // 自动派生
    "manualName": "Manual01",  // 自动派生
    "profileName": "Profile01" // 自动派生
  }
}
```

## 关键变化

| 方面 | 遗留模式 | 新模式 |
|------|----------|--------|
| 属性存储 | `attributeMap` 子节点 | 直接存储在节点上 |
| 原型层级 | csdb → manual → profile | 仅 csdb（第一层） |
| 自动派生 | csdbName/manualName/profileName | 无自动派生 |
| 继承时机 | 运行时计算 | 创建时预计算 |
| 层级结构 | csdb → manual → profile | csdb → language → content-type |
