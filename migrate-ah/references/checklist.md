# 迁移检查清单

## 迁移前检查

- [ ] 确认要迁移的功能范围
- [ ] 识别遗留代码位置（Controller、Service、Repository）
- [ ] 查找对应的遗留测试

## 迁移中检查

### 架构合规
- [ ] 遵循三层架构（Controller → Service → Repository）
- [ ] Controller 使用 `@RequiredArgsConstructor` 注入依赖
- [ ] Service 层正确处理 JCR Session 生命周期
- [ ] 使用 Acorn 库进行所有 Oak/JCR 操作

### REST API 规范
- [ ] 正确的 HTTP 方法（GET/POST/PUT/DELETE）
- [ ] 正确的 HTTP 状态码（200/201/204/400/403/500）
- [ ] 路径处理使用 `X-Request-Path` 模式

### 数据模型
- [ ] 属性直接存储在节点上（无 attributeMap 子节点）
- [ ] 移除 manual/profile archetype
- [ ] 更新了测试数据的层级结构

## 迁移后检查

- [ ] BDD 测试全部通过
- [ ] 代码 Review 通过
- [ ] 迁移文档更新完成

## 详细检查清单

**参考**：`docs/reference/migration-checklist.md`
