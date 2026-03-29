---
name: new-api-dev
description: |
  在 avia-base 中开发全新 REST API。
  使用场景：当需要实现新功能（如搜索、导出、用户管理）时。
  自动识别开发任务：用户提到"新建API"、"新功能"、"实现搜索"等关键词。
---

# 新 API 开发工作流

在 `avia-base` 中开发符合 ATA2300 规范的新 REST API。

## 开发步骤

### 1. 设计 API 接口

**确定**：
- HTTP 方法和端点路径
- 请求体结构（如需要）
- 响应体结构
- 查询参数

**参考现有模式**：`references/architecture.md`

### 2. 编写 BDD 测试（TDD 方式）

**先写测试**：
- Feature 文件位置：`avia-base/application/src/test/resources/features/`
- 参考：`references/testing-patterns.md`
- 覆盖正常路径和错误场景

### 3. 实现 Controller

**Controller 模板**：
```java
@RestController
@RequestMapping("/folders/placeholder")
@RequiredArgsConstructor
public class XxxController {

    private final XxxService xxxService;

    @GetMapping("/**")
    public ResponseEntity<Xxx> getXxx(
            @RequestHeader("X-Request-Path") String requestPath,
            @RequestParam(required = false) ...) {
        String path = requestPath.replaceFirst("^/folders/placeholder", "");
        Xxx result = xxxService.getXxx(path, ...);
        return ResponseEntity.ok(result);
    }
}
```

### 4. 实现 Service

**Service 模式**：
```java
@Service
@RequiredArgsConstructor
public class XxxService {

    private final FolderRepository folderRepository;

    public Xxx getXxx(String path, ...) {
        Session session = null;
        try {
            session = repository.login(new SimpleCredentials("admin", "admin".toCharArray()));
            // ... JCR 操作 ...
            session.save();
            return result;
        } catch (RepositoryException e) {
            throw new RuntimeException("User-friendly message", e);
        } finally {
            if (session != null) session.logout();
        }
    }
}
```

### 5. 如需修改 Acorn

在 `acorn` 中实现核心逻辑后：
```bash
cd acorn && mvn clean install
```

### 6. 验证

**检查清单**：`references/checklist.md`

## 三层架构

```
Extension Layer (Customer-Specific)
    ↓ extends
Application Layer (avia-base) - REST API & Business Logic
    ↓ uses
Foundation Layer (acorn) - Oak Repository Core
```

## 项目路径

```
AH/
├── acorn/                    # Foundation Layer
│   └── src/main/java/.../
├── avia-base/                # Application Layer
│   ├── application/          # REST API
│   │   ├── src/main/java/.../controller/
│   │   ├── src/main/java/.../service/
│   │   └── src/test/resources/features/
```

## 常用命令

```bash
# 构建 Acorn（如修改了核心库）
cd acorn && mvn clean install

# 编译 Avia Base
cd avia-base && mvn clean compile

# 运行测试
cd avia-base && mvn test

# 启动应用
cd avia-base && mvn spring-boot:run -pl application
```
