# BDD 测试规范

## Feature 文件位置

```
avia-base/application/src/test/resources/features/{功能名}.feature
```

## Feature 文件结构

```gherkin
@API-endpoint-name
Feature: 功能描述

  Scenario: 场景描述
    Given <前置条件>
    When <操作>
    Then <断言>
```

## HTTP 请求步骤

```gherkin
# GET 请求
When GET "/api/folders/A320"

# POST 请求（带请求体）
When POST "/api/folders/A320":
"""
{
  "attributeMap": {
    "archetype": "csdb",
    "csdbType": "ATA2300"
  }
}
"""

# PUT 请求
When PUT "/api/folders/A320/EN":
"""
{
  "attributeMap": {
    "language": "EN"
  }
}
"""

# DELETE 请求
When DELETE "/api/folders/A320?force=true"
```

## 响应断言

```gherkin
# 仅检查状态码
Then response should be:
"""
: { code=201 }
"""

# 检查响应体（部分匹配）
Then response should be:
"""
: {
  body.json: {
    name: "A320"
    path: "/A320"
    type: "dir"
  }
}
"""

# 检查嵌套对象
Then response should be:
"""
: {
  body.json: {
    attributeMap: {
      archetype: "csdb"
      csdbType: "ATA2300"
    }
  }
}
"""

# 验证另一个端点的响应
And "/api/folders/A320" should response:
"""
: {
  body.json: {
    name: "A320"
  }
}
"""
```

## JFactory 测试数据

### 单个数据
```gherkin
Given Exists data "Folder":
"""
{
  path: "/A330"
  attributeMap= {
    archetype: "csdb"
    csdbType: "ATA2300"
    languages: ["EN", "FR"]
  }
}
"""
```

### 层级数据（数组格式）
```gherkin
Given Exists data "Folder":
"""
[{
  path: "/A320"
  attributeMap= { archetype: "csdb", csdbType: "ATA2300" }
}, {
  path: "/A320/EN"
  attributeMap= { language: "EN" }
}, {
  path: "/A320/EN/DM"
  attributeMap= { tag: "data-module" }
}]
"""
```

## 运行测试

```bash
# 运行所有测试
cd avia-base && mvn test

# 运行特定场景
mvn test -Dcucumber.filter.name=".*create CSDB folder.*"

# 运行特定标签
mvn test -Dcucumber.filter.tags="@API-folder"
```

## 详细测试指南

**参考**：`docs/reference/testing-patterns.md`

该文档包含：
- 更多 Gherkin 示例
- Step Definition 模式
- 测试数据准备方法
