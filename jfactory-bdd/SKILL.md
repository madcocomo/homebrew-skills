---
name: jfactory-bdd
description: |
  遇到 avia-base 后端 BDD / feature 测试任务就使用本 skill：新增或修改 `src/test/resources/features` 下的 feature 文件、给 API 补 Given/When/Then 场景、把 JUnit/MockMvc 接口测试改成项目现有 feature 风格、复用 `ApplicationSteps` / 现有 step definitions / `Given Exists data` / `Then response should be`。即使用户只说“补测试”“补 feature”“给接口加场景”，没有点名 JFactory 或 Cucumber，也默认按仓库现有 JFactory + Cucumber 体系处理。不要把它用于前端 e2e、只做 OpenAPI 设计、只排查运行时问题，或仅重构 `ApplicationSteps` / step definitions / 测试基础设施而不编写或修改 feature 场景。
license: MIT
compatibility: Requires Java 17+, Spring Boot, Maven, JFactory-cucumber, RESTful-cucumber. Designed for backend API testing.
metadata:
  author: onemin-aps
  version: "1.3"
  frameworks: "Cucumber, JFactory, RESTful-cucumber"
allowed-tools: Read Write Edit Bash
---

# JFactory-BDD Testing Guide

## Overview

This skill provides comprehensive guidance for writing BDD (Behavior-Driven Development) tests using:
- **Cucumber**: BDD framework with Gherkin syntax
- **JFactory-cucumber**: Test data preparation and assertions
- **RESTful-cucumber**: REST API testing

**Core Principle**: Prioritize framework-provided standard steps over custom step definitions.

## AH / avia-base Priority Rules

When the task is in `avia-base/application/src/test` or the user asks for API BDD tests in this workspace, use these rules first:

1. **Read nearby examples before writing**: open 1-2 adjacent feature files under `avia-base/application/src/test/resources/features/`, then inspect related test infrastructure such as `CucumberTestRunner`, `ApplicationSteps`, `JFactoryConfig`, and relevant specs under `application/src/test/java/.../jfactory/spec/`.
2. **Resolve conflicts with this precedence**:
   - existing project feature files and step definitions
   - current test infrastructure code (`CucumberTestRunner`, `ApplicationSteps`, `JFactoryConfig`, JFactory specs)
   - this skill and its references
   - abbreviated or generic docs elsewhere
3. **Do not infer test syntax from acorn internals**: acorn stores attributes directly on JCR nodes, but the current avia-base API contract, response payloads, and JFactory fixtures still frequently use `attributeMap` in requests, assertions, and test data.
4. **Prefer the repository's standard English steps** unless the surrounding feature file already uses localized Chinese steps. In this repo, common forms are `Given Exists data`, `When GET/POST/...`, and `Then response should be:`.
5. **Treat JFactory as the default test data mechanism in this repo**. If the user asks for backend BDD / feature tests in avia-base, do not wait for them to explicitly say "use JFactory"; assume the existing test stack should be followed unless they clearly ask for another testing style.
6. **Create custom steps only after searching existing features, DAL expressions, and step definitions**. If DAL or framework steps can express it, do not introduce a new step.

## Quick Start

### 0. avia-base Minimal Example (Preferred in This Repo)

```gherkin
@API-folder
Feature: Folder API

  Scenario: create CSDB folder
    When POST "/api/folders/A320":
    """
    {
      "attributeMap": {
        "archetype": "csdb",
        "csdbType": "ATA2300"
      }
    }
    """
    Then response should be:
    """
    : { code=201 }
    """

  Scenario: query seeded folder
    Given Exists data "Folder":
    """
    {
      path: "/A320"
      attributeMap= { archetype: "csdb", csdbType: "ATA2300" }
    }
    """
    When GET "/api/folders/A320"
    Then response should be:
    """
    : {
      body.json: {
        path: "/A320"
        attributeMap.archetype: "csdb"
      }
    }
    """
```

### 1. Basic Feature File Structure

```gherkin
# language: zh-CN
功能: 用户认证

  背景:
    假如存在"用户":
    | name | email              | status |
    | 张三  | zhang@example.com | ACTIVE |

  场景: 成功登录
    When POST "/api/auth/login":
    """
    {
      "email": "zhang@example.com",
      "password": "password123"
    }
    """
    Then response should be:
    """
    : {
      code: 200
      body.json.token: ${存在}
    }
    """
```

### 2. Test Data Preparation

#### Table Format (Recommended for Multiple Records)
```gherkin
假如存在"商品":
| name  | price | status   |
| 书籍  | 29.99 | ACTIVE   |
| 文具  | 5.99  | INACTIVE |
```

#### JSON Format (Recommended for Complex Data)
```gherkin
假如存在"订单":
"""
{
  "orderNumber": "ORD-001",
  "items": [
    {"productId": "P001", "quantity": 2},
    {"productId": "P002", "quantity": 1}
  ],
  "status": "PENDING"
}
"""
```

#### YAML Format (Alternative)
```gherkin
假如存在"用户":
"""
name: 张三
email: zhang@example.com
roles:
  - USER
  - ADMIN
"""
```

#### BASE64 Format for Binary Content
For preparing binary content like XML files, use the `BASE64:` prefix for readability:

```gherkin
假如存在"File":
"""
[{
  path: "/A320/EN/DM/test.xml"
  fileContents: [{
    variant: "main"
    mimeType: "application/xml"
    encoding: "UTF-8"
    data: "BASE64: <?xml version=\"1.0\"?><root>Test Content</root>"
  }]
}]
"""
```

**Note**: See [Issue 8](#issue-8-base64-data-preparation-syntax) in Common Issues for detailed explanation of BASE64 handling.

### 3. REST API Testing

#### Standard HTTP Methods
```gherkin
# GET request
When GET "/api/products"
When GET "/api/products/123"

# POST request with JSON body
When POST "/api/products":
"""
{
  "name": "新产品",
  "price": 99.99
}
"""

# PUT request
When PUT "/api/products/123":
"""
{
  "name": "更新产品",
  "price": 89.99
}
"""

# PATCH request
When PATCH "/api/products/123":
"""
{
  "price": 79.99
}
"""

# DELETE request
When DELETE "/api/products/123"
```

#### Form Data and File Upload
```gherkin
# Form data submission
When POST form "/api/documents/upload":
"""
{
  "name": "测试文档",
  "type": "pdf",
  "description": "这是测试文档"
}
"""
```

**Important Note**: File upload requires custom step implementation. See [references/file-upload.md](references/file-upload.md) for details.

### 4. Response Assertions

#### Basic Assertion Format
```gherkin
Then response should be:
"""
: {
  code: 200
  body.json.message: '操作成功'
}
"""
```

**Critical**: Use `body.json.*` to access JSON response content, not `body.*` directly.

#### Complex Response Assertions
```gherkin
Then response should be:
"""
: {
  code: 200
  body.json.data.size: 3
  body.json.data[0].name: '产品A'
  body.json.data[0].price > 0
  body.json.data[0].status: 'ACTIVE'
}
"""
```

#### DAL - Unified Assertion Language

The core philosophy of JFactory is that **DAL (Data Assertion Language) is universal and composable**. All assertions—whether for REST API responses, database records, or file content—use the same DAL syntax. Extension capabilities like XML matching, regex, and comparisons can be applied to **any string field**.

**Basic DAL Operators**:
```gherkin
# Exact match
body.json.name: 'value'

# Comparison
body.json.price: '> 100'
body.json.count: '>= 5'

# Regex match (DAL extension)
body.json.token: '/^[a-zA-Z0-9_-]+$/'

# XML match (DAL extension - see XML section for details)
body.json.xmlContent: 'xml: <root><item>value</item></root>'
```

**Key Design Principle**: DAL extensions like XML, Regex, or custom matchers are not tied to specific steps. They can be applied to:
- REST API response fields (`body.json.field`)
- Database record assertions (`那么"Spec"应为:`)
- File content assertions
- Any string value being validated

**List Sorting for Unordered Results**:
When asserting arrays where element order may vary, use table format with `+` prefix on the sort column:
```gherkin
# Assert children array sorted by name
Then response should be:
"""
: {
  body.json: {
    children:
      | + name    | type |
      | file1.xml | file |
      | file2.xml | file |
  }
}
"""
```
- `+` prefix on column header indicates sorting by that field
- This ensures tests pass regardless of array element order

**Example - Multiple Assertion Types**:
```gherkin
Then response should be:
"""
: {
  code: 200
  # Exact match
  body.json.name: 'Product A'
  # Comparison
  body.json.price: '> 0'
  # Regex match - check HTML contains specific content
  body.json.html: '/.*<html>.*<title>Test.*/'
  # XML match - verify XML structure (if XML extension registered)
  body.json.xmlData: 'xml: <root><data>value</data></root>'
}
"""
```

> **Important**: DO NOT create custom steps for simple string containment checks. The DAL framework already supports regex matching and various comparison operators. Only create custom steps when you need domain-specific logic that DAL doesn't provide.

#### Variable Extraction and Reuse
```gherkin
# Extract variable from response
When POST "/api/products":
"""
{
  "name": "新产品"
}
"""
Then response should be:
"""
: {
  code: 201
  body.json.data.productId: ${productId}
}
"""

# Use extracted variable in subsequent requests
When GET "/api/products/${productId}"
Then response should be:
"""
: {
  code: 200
  body.json.data.name: '新产品'
}
"""
```

### 5. Data Assertions (DAL Syntax)

#### Query Specific Record
```gherkin
那么"商品.name[书籍]"应为:
"""
.name='书籍' and .price=29.99 and .status='ACTIVE'
"""
```

#### Query All Records
```gherkin
那么所有"商品"应为:
"""
.size=3
and [0].name='商品A'
and [1].name='商品B'
and [2].name='商品C'
"""
```

#### Complex Object Assertions
```gherkin
那么"订单.orderNumber[ORD-001]"应为:
"""
.customer='张三'
and .items.size=2
and .items[0].quantity=2
and .totalAmount > 0
and .status='COMPLETED'
"""
```

### 6. XML Data Preparation and Verification

The XML Extension provides powerful capabilities for preparing XML test data and verifying XML content in responses or files.

#### 6.1 XML Extension Setup

The XML extension must be registered in your JFactory configuration:

```java
@Configuration
public class JFactoryConfig {

    @Bean
    public JFactory jFactory(DataRepository repository) {
        JFactory jFactory = new JFactory(repository);
        // ... other setup ...

        // Register XML extension
        new XmlExtension().extend(DAL.getInstance());

        return jFactory;
    }
}
```

#### 6.2 Prepare XML Test Data

Using JFactory with XML traits for FileContent:

```gherkin
假如存在"File":
"""
[{
  path: "/A320/EN/DM/SOME.XML"
  fileContents: [{
    variant: "main"
    encoding: "UTF-8"
    mimeType: "application/xml"
    data: '''
<dmodule xmlns="http://www.ataebiz.org/XMLSchema">
   <content>
      <dispatchProcedure id="dp-1">
         <procContent something="not-important">
            <nestedProcedure shouldNotNull="abc">
               <shouldNotNull> <para>Changed content</para> </shouldNotNull>
            </nestedProcedure>
         </procContent>
      </dispatchProcedure>
   </content>
</dmodule>
      '''
    }
  }]
}]
"""
```

**Note**: The model structure may vary depending on your domain model. In Avia Base, files use `fileContents[]` instead of `versions[]`.

#### 6.3 XML Verification in Cucumber Tests

For Cucumber tests, you can use custom steps to verify XML content:

**Step 1: Implement Cucumber Steps**

```java
@Then("XML should match exactly:")
public void xml_should_match_exactly(String expected) {
    try {
        Diff diff = XmlAssertions.diff(actualXml, expected, true);
        assertFalse(diff.hasDifferences(),
            () -> "XML should match exactly but found differences: " + diff.fullDescription());
    } catch (Exception e) {
        throw new AssertionError("XML comparison failed: " + e.getMessage(), e);
    }
}

@Then("XML should match:")
public void xml_should_match(String expected) {
    try {
        Diff diff = XmlAssertions.diff(actualXml, expected, false);
        assertFalse(diff.hasDifferences(),
            () -> "XML should match but found differences: " + diff.fullDescription());
    } catch (Exception e) {
        throw new AssertionError("XML comparison failed: " + e.getMessage(), e);
    }
}
```

**Step 2: Use in Feature Files**

```gherkin
Scenario: Check XML content with exact matching
  Given XML data to verify:
  """
  <dmodule xmlns="http://www.ataebiz.org/XMLSchema">
     <content>
        <dispatchProcedure id="dp-1">
           <procContent something="not-important">
              <nestedProcedure shouldNotNull="abc">
                 <shouldNotNull> <para>Changed content</para> </shouldNotNull>
              </nestedProcedure>
           </procContent>
        </dispatchProcedure>
     </content>
  </dmodule>
  """
  Then XML should match exactly:
  """
  <dmodule xmlns="http://www.ataebiz.org/XMLSchema">
     <content>
        <dispatchProcedure id="dp-1">
           <procContent something="not-important">
              <nestedProcedure shouldNotNull="abc">
                 <shouldNotNull> <para>Changed content</para> </shouldNotNull>
              </nestedProcedure>
           </procContent>
        </dispatchProcedure>
     </content>
  </dmodule>
  """
```

#### 6.4 XML File Content Verification

For verifying XML files, you can use the DAL syntax with the XML extension:

```gherkin
# Create test file
Given Exists file "xml/data.xml" with content:
"""
<dmodule xmlns="http://www.ataebiz.org/XMLSchema">
   <content>
      <dispatchProcedure id="dp-1">
         <procContent something="not-important">
            <nestedProcedure shouldNotNull="abc">
               <shouldNotNull> <para>Test content</para> </shouldNotNull>
            </nestedProcedure>
         </procContent>
      </dispatchProcedure>
   </content>
</dmodule>
"""

# Verify file content
Then file "xml/data.xml" should be:
"""
string.toXml: ```
<dmodule>
   <content>
      <dispatchProcedure id="dp-1">
         <procContent>
            <nestedProcedure shouldNotNull="...">
               <shouldNotNull> <para>Test content</para> </shouldNotNull>
            </nestedProcedure>
         </procContent>
      </dispatchProcedure>
   </content>
</dmodule>
```
"""
```

#### 6.5 Partial Matching with Ignored Values

Use `...` to ignore specific values in XML when using DAL assertions:

```gherkin
Then file "xml/data.xml" should be:
"""
string.toXml: ```
<dmodule>
   <content>
      <dispatchProcedure id="dp-1">
         <procContent something="...">
            <nestedProcedure shouldNotNull="abc">
               <shouldNotNull/>
               <procContent> <inform> <para>Test content</para> </inform> </procContent>
            </nestedProcedure>
         </procContent>
      </dispatchProcedure>
   </content>
</dmodule>
```
"""
```

#### 6.6 List Matching with XML_DIFF List Mode

Use `<?XML_DIFF list?>` processing instruction to enable list matching mode:

```gherkin
Then file "xml/list.xml" should be:
"""
string.toXml: ```
<dmodule>
   <content>
      <important>
        <itemsContentInAttr>
          <items><?XML_DIFF list?>
              <wrapper><item type="A" title="item A"/>Additional info</wrapper>
              <wrapper><item type="B" title="item B"/>Additional info</wrapper>
              <wrapper><item type="C" title="item C"/>Additional info</wrapper>
          </items>
        </itemsContentInAttr>
      </important>
   </content>
</dmodule>
```
"""
```

#### 6.7 Flexible List Matching

Allow matching specific items while ignoring others:

```gherkin
Then file "xml/list.xml" should be:
"""
string.toXml: ```
<dmodule>
   <content>
      <important>
        <itemsContentInAttr>
          <items><?XML_DIFF list?>
              ...
              <wrapper><item type="B" title="item B"/>...</wrapper>
              ...
              <wrapper><item type="C" title="item C"/>...</wrapper>
              ...
          </items>
        </itemsContentInAttr>
      </important>
   </content>
</dmodule>
```
"""
```

#### 6.8 Negative Verification (XML Should NOT Match)

```gherkin
Then file "xml/invalid.xml" should NOT be:
"""
string.toXml: ```
<dmodule/>
```
"""
```

Then verify the error message:
```gherkin
And verification error should be:
"""
message.lines: [...
  /^org.xmlunit.XMLUnitException: .*$/
...]
"""
```

#### 6.9 XML Helper Methods

The XML extension provides helper methods:

- `xml(data)`: Convert string/bytes to XML data type
- `toXml(data)`: Alias for xml() method

These are automatically available in DAL expressions.

#### 6.10 JFactory Spec with XML Trait

In your JFactorySpecs:

```java
public static class FileContent extends Spec<io.rivendale.acorn.model.File.FileContent> {
    @Override
    public void main() {
        property("variant").value("main");
        property("encoding").value("UTF-8");
    }

    @Trait("xml")
    public FileContent xml() {
        property("mimeType").value("application/xml");
        return this;
    }
}
```

Then use it in feature:
```gherkin
假如存在"FileContent":
"""
{
  variant: "main"
  encoding: "UTF-8"
  xml: true
}
"""
```

#### 6.11 Important Notes

**Cucumber Context**: When using XML verification in Cucumber tests, you may need to use custom step definitions that call `XmlAssertions.diff()` directly, as the DAL integration may not work properly in all contexts.

**Model Structure**: The exact property names for file versions may vary. In Avia Base, use `fileContents[]` instead of `versions[]` from the legacy system.

**Namespace Handling**: XML comparison can be sensitive to namespaces. Consider using partial matching or normalizing namespaces when comparing XML from different sources.

### 7. Relational Data Preparation

#### One-to-Many Relationship
```gherkin
假如存在"商品":
| name |
| 书籍 |

并且存在如下"库存"，并且其"product"为"商品.name[书籍]":
| warehouse | quantity |
| 仓库A     | 100      |
| 仓库B     | 200      |
```

#### Many-to-Many Relationship
```gherkin
假如存在"购物车":
| customer |
| 张三     |

并且存在"购物车.customer[张三].products"的"商品":
| name  | price  |
| 商品A | 100.00 |
| 商品B | 200.00 |
```

## Common Patterns

### Pattern 1: Create-Read-Update-Delete (CRUD)
```gherkin
场景: 完整的CRUD操作流程
  # Create
  When POST "/api/products":
  """
  {"name": "测试产品", "price": 99.99}
  """
  Then response should be:
  """
  : {
    code: 201
    body.json.data.productId: ${productId}
  }
  """

  # Read
  When GET "/api/products/${productId}"
  Then response should be:
  """
  : {
    code: 200
    body.json.data.name: '测试产品'
  }
  """

  # Update
  When PUT "/api/products/${productId}":
  """
  {"name": "更新产品", "price": 89.99}
  """
  Then response should be:
  """
  : {
    code: 200
  }
  """

  # Delete
  When DELETE "/api/products/${productId}"
  Then response should be:
  """
  : {
    code: 204
  }
  """
```

### Pattern 2: Data Preparation + API Test + Verification
```gherkin
场景: 端到端测试流程
  # Prepare test data
  假如存在"用户":
  | name | email              |
  | 张三 | zhang@example.com  |

  # Execute API
  When POST "/api/orders":
  """
  {
    "userId": "${用户.name[张三].id}",
    "items": [{"productId": "P001", "quantity": 2}]
  }
  """
  Then response should be:
  """
  : {
    code: 201
    body.json.data.orderId: ${orderId}
  }
  """

  # Verify data persistence
  那么"订单.orderId[${orderId}]"应为:
  """
  .user.name='张三'
  and .items.size=1
  and .status='PENDING'
  """
```

### Pattern 3: Error Handling
```gherkin
场景大纲: 输入验证测试
  When POST "/api/products":
  """
  {
    "name": "<name>",
    "price": <price>
  }
  """
  Then response should be:
  """
  : {
    code: 400
    body.json.error: '<errorCode>'
    body.json.message: '<errorMessage>'
  }
  """

  例子:
  | name | price  | errorCode           | errorMessage |
  |      | 99.99  | VALIDATION_ERROR    | 名称不能为空 |
  | 产品 | -10    | VALIDATION_ERROR    | 价格必须大于0 |
  | 产品 | abc    | VALIDATION_ERROR    | 价格必须是数字 |
```

## Best Practices

### 1. Test Independence
- Each scenario should be independent
- Use `背景` (Background) for common setup
- Clean up test data automatically (use `@Transactional`)

### 2. Meaningful Naming
```gherkin
# Good: Descriptive with module-feature-number format
场景: AUTH-LOGIN-001 成功使用邮箱密码登录
场景: PROD-CREATE-001 成功创建新产品
场景: ORDER-QUERY-001 根据订单号查询订单详情

# Poor: Vague descriptions
场景: 测试登录
场景: 创建产品
```

### 3. Response Assertion Format
```gherkin
# Recommended: Object format
Then response should be:
"""
: {
  code: 200
}
"""

# Avoid: Array format (unless specifically needed)
Then response should be:
"""
: [{
  code: 200
}]
"""
```

### 4. Use Standard Steps First
- **DO**: Use framework-provided steps (JFactory, RESTful-cucumber)
- **DON'T**: Create custom steps unless absolutely necessary
- Custom steps should only handle domain-specific logic

## Quick Reference Table

| Task | Framework | Step Template |
|------|-----------|---------------|
| Prepare test data | JFactory | `假如存在"Spec":` |
| Prepare binary data (XML) | JFactory | `data: "BASE64: <plain text>"` |
| GET request | RESTful | `When GET "path"` |
| POST JSON | RESTful | `When POST "path":` |
| POST form | RESTful | `When POST form "path":` |
| Assert response | RESTful | `Then response should be:` |
| Assert with DAL | DAL | `body.json.field: 'value'` |
| DAL regex match | DAL | `body.json.field: '/regex/'` |
| DAL XML match | DAL | `body.json.field: 'xml: <root>...</root>'` |
| Assert data | JFactory | `那么"queryExpression"应为:` |
| Extract variable | RESTful | `body.json.field: ${varName}` |
| Use variable | Both | `${varName}` |
| Prepare XML file | JFactory | `Given Exists file "path":` |
| XML file verify | DAL | `string.toXml:` |
| XML partial match | DAL | `body.xml:` |
| XML file verify | DAL | `string.toXml:` |

## Running Tests

```bash
# Run all tests
mvn clean test

# Run specific feature
mvn test -Dcucumber.features="src/test/resources/features/auth/login.feature"

# Run by scenario name pattern
mvn test -Dcucumber.filter.name="AUTH-LOGIN.*"

# Run by tags
mvn test -Dcucumber.filter.tags="@smoke"

# Run multiple tags (AND)
mvn test -Dcucumber.filter.tags="@smoke and @api"

# Run multiple tags (OR)
mvn test -Dcucumber.filter.tags="@smoke or @regression"

# Exclude tags
mvn test -Dcucumber.filter.tags="not @slow"
```

## Common Issues and Solutions

### Issue 1: Response Body Access Error
**Problem**: `body.data.field` fails to access JSON property

**Solution**: Use `body.json.data.field` instead
```gherkin
# Wrong
body.data.documentId: ${documentId}

# Correct
body.json.data.documentId: ${documentId}
```

### Issue 2: Variable Extraction Not Working
**Problem**: Extracted variable is not available in subsequent steps

**Solution**: Ensure correct extraction syntax
```gherkin
# Variable extraction requires colon after field name
body.json.data.productId: ${productId}
```

### Issue 3: Multiple Query Results
**Problem**: `Got 2 objects of "商品.name[书籍]"`

**Solution**: Ensure query condition uniquely identifies one record, or use `所有"商品"` for multiple results

### Issue 4: File Upload Fails
**Problem**: "Required part 'file' is not present"

**Solution**: File upload requires custom step implementation. RESTful-cucumber's standard steps don't support file registration. See [references/file-upload.md](references/file-upload.md).

### Issue 5: XML Namespace Not Matching
**Problem**: XML comparison fails due to namespace differences

**Solution**: Use partial matching with `:` operator and ignore namespace differences
```gherkin
# Use partial match instead of exact match
body.xml: ```
<dmodule>
   <content>
      <dispatchProcedure id="dp-1">
         ...
      </dispatchProcedure>
   </content>
</dmodule>
```
```

### Issue 6: XML List Elements Order Matters
**Problem**: XML comparison fails when list elements are in different order

**Solution**: Use `<?XML_DIFF list?>` processing instruction for flexible list matching
```gherkin
Then file "xml/list.xml" should be:
"""
string.toXml: ```
<items><?XML_DIFF list?>
    <wrapper>...</wrapper>
    ...
</items>
```
"""
```

### Issue 7: XML Validation Error Not Clear
**Problem**: Hard to understand XML validation error messages

**Solution**: Check the `verification error should be:` step to see detailed comparison results
```gherkin
Then file "xml/data.xml" should NOT be:
"""
string.toXml: ```
<dmodule/>
```
"""
And verification error should be:
"""
message.lines: [...
  /^Expected.*but was.*$/
...]
"""
```

### Issue 8: BASE64 Data Preparation Syntax
**Problem**: Confusion about when to use `BASE64:` prefix vs plain Base64 strings

**Root Cause**: The `BASE64:` prefix is a **test data preparation syntax sugar**, not part of the API. It's handled by JFactory's transformer, not by the application code.

**Solution**: Use `BASE64:` prefix for readable plain text, or use plain Base64 strings for already-encoded content.

```gherkin
# Format 1: BASE64: prefix (recommended for readability)
# JFactory transformer encodes: "<?xml version=\"1.0\"?><root>Test</root>"
# Storage: raw bytes of the XML content
data: "BASE64: <?xml version=\"1.0\"?><root>Test</root>"

# Format 2: Plain Base64 string (if content is already encoded)
# FileService directly decodes and stores raw bytes
data: "PD94bWwgdmVyc2lvbj0iMS4wIj8+PHJvb3Q+VGVzdDwvcm9vdD4="
```

**Key Points**:
- `BASE64: <plain text>` → JFactory transformer encodes → FileService decodes → stores raw bytes
- `<Base64 content>` → FileService decodes → stores raw bytes
- Both formats result in the **same stored content** (raw bytes in JCR binary)
- The `BASE64:` prefix is purely for **test readability** - developers can write readable XML instead of unreadable Base64 strings

**DO NOT**: Modify application code (FileService.java) to handle this syntax. The logic is already correct - it simply decodes Base64 input. The transformation happens in JFactoryConfig.java's transformer.

## Advanced Topics

For detailed information on the following topics, see the reference files:

- **DAL Expression Syntax**: [references/dal-syntax.md](references/dal-syntax.md)
- **File Upload Implementation**: [references/file-upload.md](references/file-upload.md)
- **JFactory Configuration**: [references/jfactory-config.md](references/jfactory-config.md)
- **Custom Step Definitions**: [references/custom-steps.md](references/custom-steps.md)
- **Complete Framework API**: [references/framework-api.md](references/framework-api.md)

## Directory Structure

```
backend/src/test/
├── java/com/onemin/aps/
│   ├── CucumberTestRunner.java          # Test runner
│   ├── config/CucumberSpringConfig.java # Spring configuration
│   ├── steps/ApiSteps.java              # Custom step definitions
│   └── jfactory/                        # JFactory configuration
│       ├── JFactoryConfig.java          # JFactory setup
│       ├── JakartaJPADataRepository.java # JPA data repository
│       └── spec/                        # Data specifications
│           └── Specs.java               # Test data specs
└── resources/
    ├── features/                        # Feature files
    │   └── auth/
    │       └── login.feature
    └── test-files/                      # Test resources
        └── documents/
            └── test.pdf
```

## Next Steps

1. Read `avia-base/AGENTS.md` for project test structure, runner location, and lifecycle notes
2. Read `docs/modules/test/Test-Lifecycle.md` when tests touch repository cleanup, indexes, or Oak behavior
3. Review nearby feature files plus related JFactory specs under `avia-base/application/src/test/java/.../jfactory/spec/`
4. Start with simple CRUD or happy-path scenarios, then add key error paths
5. Consult reference files for advanced topics such as DAL syntax, file upload, XML, and custom steps
