# File Upload Implementation Guide

## Overview

File upload in RESTful-cucumber requires custom step implementation due to framework limitations. This guide explains the issue and provides a complete solution.

## The Problem

### Framework Limitation

RESTful-cucumber's `POST form` step has a critical limitation:

```java
// Framework checks if KEY starts with "@", not VALUE
private void appendEntry(HttpStream httpStream, String key, String value, String boundary) {
    httpStream.bound(boundary, () ->
        key.startsWith("@") ?   // ❌ Checks key, not value
            httpStream.appendFile(key, request.files.get(value)) :
            httpStream.appendField(key, value)
    );
}
```

### Why Standard Steps Don't Work

```gherkin
# ❌ This will NOT work with standard steps
When POST form "/api/upload":
"""
{
  "file": "@test-files/document.pdf",
  "description": "文档描述"
}
"""
# Result: "Required part 'file' is not present"
```

**Reason**: The framework needs:
1. File registered in `request.files` map
2. Key (not value) to start with `@`

But standard steps provide no file registration mechanism.

## The Solution

### Step 1: Create File Registration Step

Create a custom step to register files before upload:

```java
package com.onemin.aps.steps;

import com.github.leeonky.cucumber.restful.RestfulStep;
import io.cucumber.java.en.Given;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

@Component
public class FileUploadSteps {

    @Autowired
    private RestfulStep restfulStep;

    /**
     * Register a file for upload
     * @param fileKey - Key to reference the file in form data
     * @param filePath - Relative path from test resources
     */
    @Given("a file {string} with path {string}")
    public void registerFile(String fileKey, String filePath) throws IOException {
        // Get file from test resources
        Path testFilePath = Paths.get("src/test/resources", filePath);

        // Read file content
        byte[] fileContent = Files.readAllBytes(testFilePath);

        // Get file name
        String fileName = testFilePath.getFileName().toString();

        // Create UploadFile instance
        RestfulStep.UploadFile uploadFile = RestfulStep.UploadFile.content(fileContent)
            .name(fileName);

        // Register file to RestfulStep
        restfulStep.file(fileKey, uploadFile);
    }

    /**
     * Register a file with custom name
     */
    @Given("a file {string} with path {string} and name {string}")
    public void registerFileWithName(String fileKey, String filePath, String customName)
            throws IOException {
        Path testFilePath = Paths.get("src/test/resources", filePath);
        byte[] fileContent = Files.readAllBytes(testFilePath);

        RestfulStep.UploadFile uploadFile = RestfulStep.UploadFile.content(fileContent)
            .name(customName);

        restfulStep.file(fileKey, uploadFile);
    }
}
```

### Step 2: Use in Feature Files

```gherkin
# language: zh-CN
功能: 文档上传

  场景: 成功上传PDF文档
    # Step 1: Register the file
    Given a file "documentFile" with path "test-files/documents/sample.pdf"

    # Step 2: Upload using registered file key
    # IMPORTANT: Use @fileKey as the KEY, not the value
    When POST form "/api/documents/upload":
    """
    {
      "@documentFile": "documentFile",
      "description": "测试文档",
      "type": "TENDER"
    }
    """

    Then response should be:
    """
    : {
      code: 201
      body.json.data.documentId: ${documentId}
      body.json.data.fileName: 'sample.pdf'
    }
    """
```

### Step 3: Alternative - Custom Upload Step

For a cleaner approach, create a complete upload step:

```java
@When("upload file {string} to {string} with:")
public void uploadFileWithData(String filePath, String apiPath, String formDataJson)
        throws IOException, URISyntaxException {

    // Parse JSON form data
    JSONObject formData = new JSONObject(formDataJson);

    // Prepare file
    Path testFilePath = Paths.get("src/test/resources", filePath);
    byte[] fileContent = Files.readAllBytes(testFilePath);
    String fileName = testFilePath.getFileName().toString();

    // Create upload file
    RestfulStep.UploadFile uploadFile = RestfulStep.UploadFile.content(fileContent)
        .name(fileName);

    // Register temporarily
    String tempKey = "upload_" + System.currentTimeMillis();
    restfulStep.file(tempKey, uploadFile);

    // Build form data with file
    Map<String, String> formMap = new HashMap<>();
    formMap.put("@file", tempKey);  // Use @file as key
    formData.keySet().forEach(key ->
        formMap.put(key, formData.getString(key))
    );

    // Execute upload
    restfulStep.postForm(apiPath, formMap);
}
```

**Usage:**
```gherkin
When upload file "test-files/documents/sample.pdf" to "/api/documents/upload" with:
"""
{
  "description": "测试文档",
  "type": "TENDER"
}
"""
```

## Complete Example

### Test File Structure
```
backend/src/test/resources/
├── features/
│   └── document/
│       └── document-upload.feature
└── test-files/
    └── documents/
        ├── sample.pdf          # Valid PDF file
        ├── large-file.pdf      # Large file (>10MB)
        ├── invalid.txt         # Invalid file type
        └── empty.pdf           # Empty file
```

### Feature File
```gherkin
# language: zh-CN
功能: 文档上传管理

  背景:
    假如存在"用户":
    | username | email              | status |
    | testuser | test@example.com   | ACTIVE |

  规则: 文件上传验证

    场景: DOC-UPLOAD-001 成功上传PDF文档
      Given a file "validPdf" with path "test-files/documents/sample.pdf"

      When POST form "/api/documents/upload":
      """
      {
        "@validPdf": "validPdf",
        "userId": "${用户.username[testuser].id}",
        "description": "标书文档",
        "type": "TENDER"
      }
      """

      Then response should be:
      """
      : {
        code: 201
        body.json.data.documentId: ${documentId}
        body.json.data.fileName: 'sample.pdf'
        body.json.data.fileSize > 0
        body.json.data.status: 'UPLOADED'
      }
      """

      # Verify data persistence
      那么"文档.documentId[${documentId}]"应为:
      """
      .fileName='sample.pdf'
      and .type='TENDER'
      and .status='UPLOADED'
      and .uploadedBy.username='testuser'
      """

    场景: DOC-UPLOAD-002 拒绝不支持的文件类型
      Given a file "invalidFile" with path "test-files/documents/invalid.txt"

      When POST form "/api/documents/upload":
      """
      {
        "@invalidFile": "invalidFile",
        "userId": "${用户.username[testuser].id}",
        "type": "TENDER"
      }
      """

      Then response should be:
      """
      : {
        code: 400
        body.json.error: 'UNSUPPORTED_FILE_TYPE'
        body.json.message: '不支持的文件格式，仅支持PDF、DOC、DOCX、XLS、XLSX格式'
      }
      """

    场景: DOC-UPLOAD-003 拒绝超大文件
      Given a file "largeFile" with path "test-files/documents/large-file.pdf"

      When POST form "/api/documents/upload":
      """
      {
        "@largeFile": "largeFile",
        "userId": "${用户.username[testuser].id}",
        "type": "TENDER"
      }
      """

      Then response should be:
      """
      : {
        code: 400
        body.json.error: 'FILE_TOO_LARGE'
        body.json.message: '文件大小超过限制，最大支持10MB'
      }
      """

    场景: DOC-UPLOAD-004 文件名包含中文
      Given a file "chineseNameFile" with path "test-files/documents/sample.pdf" and name "测试文档.pdf"

      When POST form "/api/documents/upload":
      """
      {
        "@chineseNameFile": "chineseNameFile",
        "userId": "${用户.username[testuser].id}",
        "type": "TENDER"
      }
      """

      Then response should be:
      """
      : {
        code: 201
        body.json.data.fileName: '测试文档.pdf'
      }
      """
```

## Advanced Patterns

### Multiple File Upload
```java
@When("upload files to {string}:")
public void uploadMultipleFiles(String apiPath, DataTable dataTable)
        throws IOException, URISyntaxException {

    Map<String, String> formData = new HashMap<>();

    // First row: headers [fieldName, filePath, fileName]
    List<List<String>> rows = dataTable.asLists();

    for (int i = 1; i < rows.size(); i++) {
        List<String> row = rows.get(i);
        String fieldName = row.get(0);
        String filePath = row.get(1);
        String fileName = row.size() > 2 ? row.get(2) : null;

        // Read and register file
        Path testFilePath = Paths.get("src/test/resources", filePath);
        byte[] content = Files.readAllBytes(testFilePath);
        String name = fileName != null ? fileName : testFilePath.getFileName().toString();

        RestfulStep.UploadFile uploadFile = RestfulStep.UploadFile.content(content).name(name);
        String fileKey = "file_" + i;
        restfulStep.file(fileKey, uploadFile);

        formData.put("@" + fieldName, fileKey);
    }

    restfulStep.postForm(apiPath, formData);
}
```

**Usage:**
```gherkin
When upload files to "/api/documents/batch-upload":
| fieldName | filePath                         | fileName      |
| file1     | test-files/documents/doc1.pdf    | 文档1.pdf     |
| file2     | test-files/documents/doc2.pdf    | 文档2.pdf     |
| file3     | test-files/documents/doc3.pdf    | 文档3.pdf     |
```

### File with Complex Form Data
```gherkin
场景: 上传文档并关联到标书
  假如存在"标书":
  | tenderCode | name      |
  | T-001      | 测试标书   |

  Given a file "tenderDoc" with path "test-files/documents/tender.pdf"

  When POST form "/api/tender/documents/upload":
  """
  {
    "@tenderDoc": "tenderDoc",
    "tenderCode": "T-001",
    "documentType": "TECHNICAL_PROPOSAL",
    "metadata": {
      "author": "张三",
      "version": "1.0",
      "tags": ["重要", "技术"]
    }
  }
  """
```

## Testing File Upload Controller

### Controller Implementation
```java
@RestController
@RequestMapping("/api/documents")
public class DocumentUploadController {

    @PostMapping("/upload")
    public ResponseEntity<?> uploadDocument(
            @RequestParam("file") MultipartFile file,
            @RequestParam("userId") Long userId,
            @RequestParam(required = false) String description,
            @RequestParam String type) {

        // Validate file type
        if (!isValidFileType(file)) {
            return ResponseEntity.badRequest()
                .body(Map.of(
                    "error", "UNSUPPORTED_FILE_TYPE",
                    "message", "不支持的文件格式，仅支持PDF、DOC、DOCX、XLS、XLSX格式"
                ));
        }

        // Validate file size
        if (file.getSize() > 10 * 1024 * 1024) { // 10MB
            return ResponseEntity.badRequest()
                .body(Map.of(
                    "error", "FILE_TOO_LARGE",
                    "message", "文件大小超过限制，最大支持10MB"
                ));
        }

        // Save document
        Document document = documentService.saveDocument(file, userId, description, type);

        return ResponseEntity.status(HttpStatus.CREATED)
            .body(Map.of("data", document));
    }
}
```

## Troubleshooting

### Issue 1: "Required part 'file' is not present"
**Cause**: File not registered or incorrect key format

**Solution**:
```gherkin
# ✅ Correct: Register file first, use @fileKey as KEY
Given a file "myFile" with path "test-files/doc.pdf"
When POST form "/api/upload":
"""
{
  "@myFile": "myFile"
}
"""

# ❌ Wrong: No file registration
When POST form "/api/upload":
"""
{
  "file": "@test-files/doc.pdf"
}
"""
```

### Issue 2: File content is empty
**Cause**: File path incorrect or file not found

**Solution**:
- Verify file exists: `ls -la src/test/resources/test-files/`
- Check path is relative to `src/test/resources/`
- Ensure file has content: `cat src/test/resources/test-files/doc.pdf`

### Issue 3: Filename encoding issues
**Cause**: Chinese characters in filename not properly encoded

**Solution**:
```java
// Use UTF-8 encoding explicitly
RestfulStep.UploadFile uploadFile = RestfulStep.UploadFile.content(content)
    .name(new String(fileName.getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8));
```

## Best Practices

1. **Organize Test Files**: Keep test files in organized directories
2. **Use Descriptive File Keys**: `"tenderDocument"` better than `"file1"`
3. **Clean File Names**: Use simple names in tests, test special characters separately
4. **File Size**: Keep test files small (<1MB) for fast tests
5. **Valid Test Data**: Use real file formats, not empty or corrupted files
6. **Cleanup**: Consider cleanup step to delete uploaded files after tests

## References

- RESTful-cucumber source: https://github.com/leeonky/RESTful-cucumber
- Spring MultipartFile docs: https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/multipart/MultipartFile.html
