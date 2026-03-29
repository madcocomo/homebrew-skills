# BDD 测试规范

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

### 层级数据
```gherkin
Given Exists data "Folder":
"""
[{
  path: "/A320"
  attributeMap= { archetype: "csdb", csdbType: "ATA2300" }
}, {
  path: "/A320/EN"
  attributeMap= { language: "EN" }
}]
"""
```

## 运行测试

```bash
# 运行所有测试
cd avia-base && mvn test

# 运行特定场景
mvn test -Dcucumber.filter.name=".*场景名.*"

# 运行特定标签
mvn test -Dcucumber.filter.tags="@API-folder"
```

## 最佳实践

1. **一个场景测试一个功能**
2. **描述性场景名称**
3. **严格遵循 Given-When-Then**
4. **使用 JFactory 准备复杂数据**
