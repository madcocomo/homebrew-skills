# Framework API Complete Reference

## Overview

This document provides comprehensive API reference for:
- **JFactory-cucumber**: Test data preparation framework
- **RESTful-cucumber**: REST API testing framework
- **Cucumber**: BDD testing framework

## JFactory-cucumber API

### Data Preparation Steps

#### 1. Create Single Entity with Table

```gherkin
假如存在"EntitySpec":
| field1 | field2 | field3 |
| value1 | value2 | value3 |
```

**Translations:**
- `假如存在` (Given exists)
- `Given there is`
- `Given exists`

**Example:**
```gherkin
假如存在"用户":
| username | email             | status |
| admin    | admin@example.com | ACTIVE |
```

#### 2. Create Multiple Entities with Table

```gherkin
假如存在"EntitySpec":
| field1 | field2 |
| value1 | value2 |
| value3 | value4 |
| value5 | value6 |
```

**Example:**
```gherkin
假如存在"商品":
| name  | price  | status |
| 书籍  | 29.99  | ACTIVE |
| 文具  | 15.50  | ACTIVE |
| 玩具  | 89.99  | INACTIVE |
```

#### 3. Create Entity with JSON

```gherkin
假如存在"EntitySpec":
"""
{
  "field1": "value1",
  "field2": "value2",
  "nested": {
    "field3": "value3"
  }
}
"""
```

**Example:**
```gherkin
假如存在"订单":
"""
{
  "orderNumber": "ORD-001",
  "customer": {
    "name": "张三",
    "email": "zhang@example.com"
  },
  "items": [
    {"productId": "P001", "quantity": 2},
    {"productId": "P002", "quantity": 1}
  ],
  "status": "PENDING"
}
"""
```

#### 4. Create Entity with YAML

```gherkin
假如存在"EntitySpec":
"""
field1: value1
field2: value2
nested:
  field3: value3
  field4: value4
"""
```

**Example:**
```gherkin
假如存在"配置":
"""
appName: TestApp
features:
  - authentication
  - authorization
  - logging
settings:
  maxUploadSize: 10485760
  enableCache: true
"""
```

#### 5. Create Related Entities (One-to-Many)

```gherkin
假如存在"ParentSpec":
| field |
| value |

并且存在如下"ChildSpec"，并且其"parentField"为"ParentSpec.field[value]":
| childField1 | childField2 |
| value1      | value2      |
| value3      | value4      |
```

**Translations:**
- `并且存在如下` (And exists following)
- `并且其` (and its)
- `为` (is)

**Example:**
```gherkin
假如存在"商品":
| name |
| 书籍 |

并且存在如下"库存"，并且其"product"为"商品.name[书籍]":
| warehouse | quantity |
| 北京仓    | 100      |
| 上海仓    | 200      |
| 广州仓    | 150      |
```

#### 6. Create Many-to-Many Relationship

```gherkin
假如存在"EntityA":
| field |
| value |

并且存在"EntityA.field[value].collectionField"的"EntityB":
| fieldB1 | fieldB2 |
| value1  | value2  |
| value3  | value4  |
```

**Example:**
```gherkin
假如存在"用户":
| username |
| admin    |

并且存在"用户.username[admin].roles"的"角色":
| name  | description |
| ADMIN | 管理员权限  |
| USER  | 用户权限    |
```

### Data Assertion Steps

#### 1. Assert Single Entity

```gherkin
那么"EntitySpec.field[value]"应为:
"""
.field1 = 'expectedValue1'
and .field2 = expectedValue2
and .field3 > 0
"""
```

**Translations:**
- `那么` (Then)
- `应为` (should be)
- `Then should be`

**Example:**
```gherkin
那么"用户.username[admin]"应为:
"""
.username = 'admin'
and .email = 'admin@example.com'
and .status = 'ACTIVE'
and .createdAt != null
"""
```

#### 2. Assert All Entities

```gherkin
那么所有"EntitySpec"应为:
"""
.size = 3
and [0].field = 'value1'
and [1].field = 'value2'
and [2].field = 'value3'
"""
```

**Translations:**
- `所有` (all)
- `Then all should be`

**Example:**
```gherkin
那么所有"商品"应为:
"""
.size = 3
and [0].name = '书籍'
and [0].price = 29.99
and [1].name = '文具'
and [1].price = 15.50
and [2].name = '玩具'
and [2].price = 89.99
"""
```

#### 3. Assert with Property Navigation

```gherkin
那么"EntitySpec.field[value]"应为:
"""
.nestedObject.property = 'value'
and .collection.size = 2
and .collection[0].field = 'value'
"""
```

**Example:**
```gherkin
那么"订单.orderNumber[ORD-001]"应为:
"""
.customer.name = '张三'
and .customer.email = 'zhang@example.com'
and .items.size = 2
and .items[0].quantity = 2
and .items[1].quantity = 1
and .totalAmount > 0
"""
```

## RESTful-cucumber API

### HTTP Request Steps

#### 1. GET Request

```gherkin
When GET "path"
When GET "path" with headers:
When GET "path" with query params:
```

**Examples:**
```gherkin
# Simple GET
When GET "/api/products"

# GET with path parameter
When GET "/api/products/123"

# GET with variable
When GET "/api/products/${productId}"

# GET with headers
When GET "/api/products" with headers:
"""
{
  "X-Custom-Header": "value",
  "Accept-Language": "zh-CN"
}
"""

# GET with query parameters
When GET "/api/products" with query params:
"""
{
  "page": 1,
  "size": 10,
  "sort": "name,asc"
}
"""
```

#### 2. POST Request

```gherkin
When POST "path":
"""
{request body in JSON}
"""

When POST "path" with content type "content-type":
"""
{request body}
"""
```

**Examples:**
```gherkin
# POST with JSON body
When POST "/api/products":
"""
{
  "name": "新产品",
  "price": 99.99,
  "category": "电子"
}
"""

# POST with XML body
When POST "/api/products" with content type "application/xml":
"""
<product>
  <name>新产品</name>
  <price>99.99</price>
</product>
"""

# POST with variables
When POST "/api/orders":
"""
{
  "userId": "${用户.username[admin].id}",
  "productId": "${productId}",
  "quantity": 2
}
"""
```

#### 3. PUT Request

```gherkin
When PUT "path":
"""
{request body}
"""
```

**Example:**
```gherkin
When PUT "/api/products/${productId}":
"""
{
  "name": "更新后的产品",
  "price": 89.99,
  "status": "ACTIVE"
}
"""
```

#### 4. PATCH Request

```gherkin
When PATCH "path":
"""
{partial update body}
"""
```

**Example:**
```gherkin
# Only update specific fields
When PATCH "/api/products/${productId}":
"""
{
  "price": 79.99
}
"""
```

#### 5. DELETE Request

```gherkin
When DELETE "path"
```

**Examples:**
```gherkin
When DELETE "/api/products/123"
When DELETE "/api/products/${productId}"
```

#### 6. POST Form Data

```gherkin
When POST form "path":
"""
{
  "field1": "value1",
  "field2": "value2"
}
"""
```

**Example:**
```gherkin
When POST form "/api/documents/upload":
"""
{
  "@file": "documentFile",
  "description": "文档描述",
  "type": "PDF"
}
"""
```

### Response Assertion Steps

#### 1. Basic Response Assertion

```gherkin
Then response should be:
"""
: {
  code: 200
}
"""
```

**Example:**
```gherkin
Then response should be:
"""
: {
  code: 200
  body.json.message: '操作成功'
}
"""
```

#### 2. Response Body Assertions

```gherkin
Then response should be:
"""
: {
  code: expectedCode
  body.json.field: 'expectedValue'
  body.json.nested.field: expectedValue
  body.json.array.size: expectedSize
  body.json.array[0]: 'expectedValue'
}
"""
```

**Examples:**
```gherkin
# Assert response code and message
Then response should be:
"""
: {
  code: 200
  body.json.success: true
  body.json.message: '创建成功'
}
"""

# Assert nested object
Then response should be:
"""
: {
  code: 200
  body.json.data.product.id: ${productId}
  body.json.data.product.name: '测试产品'
  body.json.data.product.price: 99.99
}
"""

# Assert array
Then response should be:
"""
: {
  code: 200
  body.json.data.size: 3
  body.json.data[0].name: '产品A'
  body.json.data[1].name: '产品B'
  body.json.data[2].name: '产品C'
}
"""
```

#### 3. Extract Variables from Response

```gherkin
Then response should be:
"""
: {
  code: 200
  body.json.field: ${variableName}
}
"""
```

**Example:**
```gherkin
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
  body.json.data.token: ${authToken}
}
"""

# Use extracted variables
When GET "/api/products/${productId}"
When GET "/api/secure/endpoint" with headers:
"""
{
  "Authorization": "Bearer ${authToken}"
}
"""
```

#### 4. Comparison Operators in Response

```gherkin
Then response should be:
"""
: {
  code: 200
  body.json.count > 0
  body.json.price >= 99.99
  body.json.stock <= 1000
  body.json.rating < 5.0
}
"""
```

#### 5. String Matching in Response

```gherkin
Then response should be:
"""
: {
  code: 200
  body.json.message: /^Success/
  body.json.email: /@example\.com$/
}
"""
```

#### 6. Null and Existence Checks

```gherkin
Then response should be:
"""
: {
  code: 200
  body.json.data.id: ${存在}
  body.json.data.deletedAt: null
  body.json.data.createdAt != null
}
"""
```

### Headers and Authentication

#### 1. Set Request Headers

```gherkin
When GET "path" with headers:
"""
{
  "Header-Name": "value",
  "Another-Header": "value"
}
"""

When POST "path" with headers:
"""
{
  "Content-Type": "application/json",
  "Authorization": "Bearer ${token}"
}
""":
"""
{request body}
"""
```

#### 2. Assert Response Headers

```gherkin
Then response should be:
"""
: {
  code: 200
  headers.Content-Type: 'application/json'
  headers.X-Custom-Header: 'value'
}
"""
```

### Query Parameters

```gherkin
When GET "path" with query params:
"""
{
  "param1": "value1",
  "param2": "value2",
  "page": 1,
  "size": 10
}
"""
```

**Example:**
```gherkin
When GET "/api/products" with query params:
"""
{
  "category": "电子",
  "minPrice": 100,
  "maxPrice": 1000,
  "sort": "price,desc",
  "page": 0,
  "size": 20
}
"""
```

## Cucumber Standard Steps

### Scenario Structure

```gherkin
# language: zh-CN
功能: Feature name
  Feature description

  背景:
    # Background steps run before each scenario
    假如 background setup

  场景: Scenario name
    假如 precondition
    当 action
    那么 assertion

  场景大纲: Scenario outline name
    假如 precondition with <parameter>
    当 action with <parameter>
    那么 assertion with <parameter>

    例子:
    | parameter1 | parameter2 |
    | value1     | value2     |
    | value3     | value4     |

  规则: Rule name
    Rule description

    场景: Scenario under rule
      假如 precondition
      当 action
      那么 assertion
```

### Tags

```gherkin
@smoke @api
场景: Tagged scenario
  # Scenario steps
```

**Common tags:**
- `@smoke` - Smoke tests
- `@regression` - Regression tests
- `@api` - API tests
- `@integration` - Integration tests
- `@slow` - Slow-running tests
- `@wip` - Work in progress
- `@ignore` - Ignored tests

### Comments

```gherkin
# This is a comment
场景: Test scenario
  # Comments can be anywhere
  假如存在"用户":  # Inline comments
  | username |
  | admin    |
```

## Complete Example

```gherkin
# language: zh-CN
功能: 产品管理API

  作为系统管理员
  我想要管理产品信息
  以便维护产品目录

  背景:
    假如存在"用户":
    | username | email             | role  |
    | admin    | admin@example.com | ADMIN |

    并且存在"分类":
    | code | name   |
    | ELEC | 电子   |
    | BOOK | 图书   |

  规则: 产品CRUD操作

    @smoke @api
    场景: PROD-CREATE-001 成功创建产品
      Given I am authenticated as "admin"

      When POST "/api/products":
      """
      {
        "name": "测试产品",
        "price": 99.99,
        "categoryCode": "ELEC",
        "description": "这是测试产品",
        "stock": 100
      }
      """

      Then response should be:
      """
      : {
        code: 201
        body.json.data.productId: ${productId}
        body.json.data.name: '测试产品'
        body.json.data.price: 99.99
        body.json.data.category.code: 'ELEC'
        body.json.data.stock: 100
        body.json.data.status: 'ACTIVE'
        body.json.data.createdAt: ${存在}
      }
      """

      那么"产品.id[${productId}]"应为:
      """
      .name = '测试产品'
      and .price = 99.99
      and .category.code = 'ELEC'
      and .stock = 100
      and .status = 'ACTIVE'
      and .createdBy.username = 'admin'
      and .createdAt != null
      """

    @api
    场景: PROD-UPDATE-001 成功更新产品
      假如存在"产品":
      | id  | name   | price | category                |
      | 100 | 旧产品 | 50.00 | @分类.code[BOOK]        |

      When PUT "/api/products/100":
      """
      {
        "name": "新产品名称",
        "price": 89.99,
        "categoryCode": "ELEC"
      }
      """

      Then response should be:
      """
      : {
        code: 200
        body.json.data.id: 100
        body.json.data.name: '新产品名称'
        body.json.data.price: 89.99
        body.json.data.category.code: 'ELEC'
      }
      """

      那么"产品.id[100]"应为:
      """
      .name = '新产品名称'
      and .price = 89.99
      and .category.code = 'ELEC'
      and .updatedAt != null
      and .updatedAt > .createdAt
      """

    @api
    场景大纲: PROD-VALID-001 输入验证
      When POST "/api/products":
      """
      {
        "name": "<name>",
        "price": <price>,
        "categoryCode": "<category>"
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
      | name   | price  | category | errorCode        | errorMessage     |
      |        | 99.99  | ELEC     | VALIDATION_ERROR | 产品名称不能为空 |
      | 产品   | -10    | ELEC     | VALIDATION_ERROR | 价格必须大于0    |
      | 产品   | 99.99  |          | VALIDATION_ERROR | 分类不能为空     |
      | 产品   | 99.99  | INVALID  | VALIDATION_ERROR | 分类不存在       |

    @api
    场景: PROD-DELETE-001 成功删除产品
      假如存在"产品":
      | id  | name   |
      | 100 | 测试   |

      When DELETE "/api/products/100"

      Then response should be:
      """
      : {
        code: 204
      }
      """

      那么"产品.id[100]"应为:
      """
      .deleted = true
      and .deletedAt != null
      and .deletedBy.username = 'admin'
      """

    @api
    场景: PROD-QUERY-001 查询产品列表
      假如存在"产品":
      | name  | price  | category            | status   |
      | 产品A | 100.00 | @分类.code[ELEC]    | ACTIVE   |
      | 产品B | 200.00 | @分类.code[ELEC]    | ACTIVE   |
      | 产品C | 50.00  | @分类.code[BOOK]    | INACTIVE |

      When GET "/api/products" with query params:
      """
      {
        "categoryCode": "ELEC",
        "status": "ACTIVE",
        "minPrice": 50,
        "page": 0,
        "size": 10
      }
      """

      Then response should be:
      """
      : {
        code: 200
        body.json.data.content.size: 2
        body.json.data.content[0].name: '产品A'
        body.json.data.content[0].category.code: 'ELEC'
        body.json.data.content[1].name: '产品B'
        body.json.data.content[1].category.code: 'ELEC'
        body.json.data.totalElements: 2
        body.json.data.totalPages: 1
      }
      """
```

## References

- JFactory-cucumber: https://github.com/leeonky/jfactory-cucumber
- RESTful-cucumber: https://github.com/leeonky/RESTful-cucumber
- Cucumber Documentation: https://cucumber.io/docs/cucumber/
- Gherkin Reference: https://cucumber.io/docs/gherkin/reference/
