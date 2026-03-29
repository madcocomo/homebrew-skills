# 遗留系统 API 映射参考

## 项目对照

| 遗留系统 | 新系统 |
|---------|--------|
| `knowledge-base-j/webapp` | `avia-base/application` |
| `knowledge-base-j/core` | `acorn` |
| Spring Boot 2 + javax | Spring Boot 3 + Jakarta |

## 端点迁移对照

### 文件夹 API

| 遗留端点 | 新端点 | 备注 |
|---------|-------|------|
| `GET /api/tree/{path}` | `GET /api/folders/{path}` | 路径格式相同 |
| `POST /api/tree/{path}` | `POST /api/folders/{path}` | 请求体结构变化 |
| `PUT /api/tree/{path}` | `PUT /api/folders/{path}` | 请求体结构变化 |
| `DELETE /api/tree/{path}` | `DELETE /api/folders/{path}` | 增加 force 参数 |

### 文件 API

| 遗留端点 | 新端点 | 备注 |
|---------|-------|------|
| `GET /api/files/{path}` | `GET /api/files/{path}` | 待实现 |
| `POST /api/files/{path}` | `POST /api/files/{path}` | 待实现 |
| `GET /api/files/{path}/versions` | `GET /api/files/{path}/versions` | 待实现 |

## 详细映射文档

**参考**：`docs/req/legacy-mapping.md`

该文档包含：
- 完整的 Feature 文件迁移示例
- 常见迁移模式（CSDB创建、子文件夹创建等）
- archetype 到具体属性的映射表
