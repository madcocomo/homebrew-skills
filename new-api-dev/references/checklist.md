# 新 API 开发检查清单

## 设计阶段
- [ ] 确定 HTTP 方法和端点路径
- [ ] 设计请求/响应格式
- [ ] 确定查询参数
- [ ] 定义错误响应格式

## 代码质量
- [ ] 遵循项目代码风格（Lombok、Jakarta EE、SLF4J）
- [ ] Controller 使用 `@RequiredArgsConstructor` 注入依赖
- [ ] Service 层正确处理 JCR Session 生命周期
- [ ] 适当的错误处理和日志记录

## 架构合规
- [ ] 遵循三层架构（Controller → Service → Repository）
- [ ] 不在 Controller 中编写业务逻辑
- [ ] 使用 Acorn 库进行所有 Oak/JCR 操作
- [ ] 属性直接存储在节点上

## BDD 测试
- [ ] Feature 文件覆盖正常路径
- [ ] Feature 文件覆盖错误场景
- [ ] 使用描述性的场景名称
- [ ] 测试通过

## 构建验证
```bash
# 1. 构建 Acorn（如修改了核心库）
cd acorn && mvn clean install

# 2. 编译 Avia Base
cd avia-base && mvn clean compile

# 3. 运行测试
mvn test
```
