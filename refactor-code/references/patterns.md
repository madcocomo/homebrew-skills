# 重构模式参考

## 抽取工具类

**Before**：Controller 中直接处理
```java
@RestController
public class FolderController {
    public String extractPath(String requestPath) {
        return requestPath.replaceFirst("^/folders/placeholder", "");
    }
}
```

**After**：抽取到工具类
```java
// PathUtil.java
public class PathUtil {
    public static String extractFolderPath(String requestPath) {
        return requestPath.replaceFirst("^/folders/placeholder", "");
    }
}

// Controller.java
@RestController
public class FolderController {
    public String path = PathUtil.extractFolderPath(requestPath);
}
```

## 统一错误处理

**Before**：每个 Controller 处理异常
```java
@RestController
public class XxxController {
    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Error> handle(IllegalArgumentException e) {
        return ResponseEntity.badRequest().body(new Error(e.getMessage()));
    }
}
```

**After**：抽取到全局处理
```java
@RestControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ErrorResponse> handleValidationError(IllegalArgumentException e) {
        return ResponseEntity.badRequest().body(new ErrorResponse(e.getMessage()));
    }
}
```

## 消除重复代码

**Before**：多处重复的属性验证
```java
// 在多个 Service 中
if (name == null || name.isBlank()) {
    throw new IllegalArgumentException("Name is required");
}
```

**After**：抽取验证方法
```java
// ValidationUtil.java
public class ValidationUtil {
    public static void requireNonBlank(String value, String fieldName) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(fieldName + " is required");
        }
    }
}

// 使用
ValidationUtil.requireNonBlank(name, "name");
```
