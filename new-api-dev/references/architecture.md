# 新架构设计要点

## 三层架构

```
Extension Layer (Customer-Specific)
    ↓ extends
Application Layer (avia-base) - ATA2300 Business Logic & APIs
    ↓ uses
Foundation Layer (acorn) - Oak Repository Core Services
    ↓ powered by
Apache Jackrabbit Oak
```

## REST API 设计规范

### 路径处理
- 使用占位符模式：`@RequestMapping("/folders/placeholder")`
- 通过 `X-Request-Path` 请求头提取实际路径
- 提取逻辑：`requestPath.replaceFirst("^/folders/placeholder", "")`

### 请求/响应格式
```json
// 创建请求
POST /api/folders/A320
{
  "attributeMap": {
    "archetype": "csdb",
    "csdbType": "ATA2300",
    "languages": ["EN", "FR"]
  }
}

// 响应
{
  "name": "A320",
  "path": "/A320",
  "type": "dir",
  "attributeMap": {
    "archetype": "csdb",
    "csdbType": "ATA2300",
    "languages": ["EN", "FR"]
  },
  "children": []
}
```

### 查询参数
- `childDirs`: 包含子目录
- `childFiles`: 包含子文件
- `pageNumber`, `pageSize`: 分页
- `force`: 强制删除（有子节点时）

## 错误处理

| 异常类型 | HTTP 状态码 | 用途 |
|---------|-----------|------|
| `IllegalArgumentException` | 400 Bad Request | 验证错误 |
| `IllegalStateException` | 403 Forbidden | 业务逻辑违规 |
| `RuntimeException` | 500 Internal Server Error | 仓库操作异常 |

## 废弃模式（禁止使用）

- ❌ `attributeMap` 子节点存储属性
- ❌ manual/profile archetype 模式
- ❌ 自动派生属性（csdbName, manualName, profileName）
