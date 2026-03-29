# JFactory-BDD Quick Reference Card

## Data Preparation

```gherkin
# Table format (multiple records)
假如存在"产品":
| name | price  |
| 书籍 | 29.99  |
| 文具 | 15.50  |

# JSON format (complex data)
假如存在"订单":
"""
{
  "orderNumber": "ORD-001",
  "items": [{"productId": "P001", "quantity": 2}]
}
"""

# Relationships (one-to-many)
假如存在"商品":
| name |
| 书籍 |

并且存在如下"库存"，并且其"product"为"商品.name[书籍]":
| warehouse | quantity |
| 仓库A     | 100      |

# Many-to-many
并且存在"用户.username[admin].roles"的"角色":
| name  |
| ADMIN |
| USER  |
```

## REST API Testing

```gherkin
# GET
When GET "/api/products"
When GET "/api/products/${productId}"

# POST with JSON
When POST "/api/products":
"""
{
  "name": "产品",
  "price": 99.99
}
"""

# PUT (full update)
When PUT "/api/products/${productId}":
"""
{"name": "新名称", "price": 89.99}
"""

# PATCH (partial update)
When PATCH "/api/products/${productId}":
"""
{"price": 79.99}
"""

# DELETE
When DELETE "/api/products/${productId}"

# POST form
When POST form "/api/upload":
"""
{
  "@file": "fileKey",
  "description": "描述"
}
"""
```

## Response Assertions

```gherkin
Then response should be:
"""
: {
  code: 200
  body.json.message: '成功'
  body.json.data.id: ${productId}
  body.json.data.name: '产品'
  body.json.data.price: 99.99
  body.json.data.price > 0
  body.json.data.array.size: 3
  body.json.data.array[0]: 'value'
  body.json.data.field: ${存在}
  body.json.data.nullField: null
}
"""
```

## Data Assertions

```gherkin
# Single entity
那么"产品.id[123]"应为:
"""
.name = '产品'
and .price = 99.99
and .status = 'ACTIVE'
and .createdAt != null
"""

# All entities
那么所有"产品"应为:
"""
.size = 3
and [0].name = '产品A'
and [1].name = '产品B'
"""

# Nested objects
那么"订单.orderNumber[ORD-001]"应为:
"""
.customer.name = '张三'
and .items.size = 2
and .items[0].quantity = 2
and .totalAmount > 0
"""
```

## DAL Operators

```gherkin
# Equality
.field = 'value'
.field != 'value'

# Comparison
.price > 0
.price >= 99.99
.price < 100
.price <= 100

# String matching
.email: '@example.com'        # contains
.name: /^产品/                # starts with
.code: /\d{4}$/               # regex

# Null checks
.field = null
.field != null
.field: ${存在}                # not null and not empty

# Logical
.price > 0 and .price < 100
(.status = 'A' or .status = 'B') and .enabled = true

# Collections
.items.size = 3
.items[0].name = 'value'
.items.every(.price > 0)
.items.any(.quantity > 1)
.items.none(.deleted = true)
```

## Variable Extraction & Usage

```gherkin
# Extract from response
Then response should be:
"""
: {
  code: 201
  body.json.data.productId: ${productId}
  body.json.data.token: ${authToken}
}
"""

# Use in API calls
When GET "/api/products/${productId}"
When GET "/api/secure" with headers:
"""
{
  "Authorization": "Bearer ${authToken}"
}
"""

# Use in data preparation
When POST "/api/orders":
"""
{
  "userId": "${用户.username[admin].id}",
  "productId": "${productId}"
}
"""

# Use in assertions
那么"订单.id[${orderId}]"应为:
"""
.totalAmount = ${expectedAmount}
"""
```

## Common Patterns

### CRUD Pattern
```gherkin
# Create
When POST "/api/products":
"""
{"name": "产品", "price": 99.99}
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
  body.json.data.name: '产品'
}
"""

# Update
When PUT "/api/products/${productId}":
"""
{"name": "新产品", "price": 89.99}
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

### Data Prep + API + Verify Pattern
```gherkin
# 1. Prepare data
假如存在"用户":
| username | email             |
| admin    | admin@example.com |

# 2. Call API
When POST "/api/orders":
"""
{
  "userId": "${用户.username[admin].id}",
  "items": [{"productId": "P001", "quantity": 2}]
}
"""

# 3. Verify response
Then response should be:
"""
: {
  code: 201
  body.json.data.orderId: ${orderId}
}
"""

# 4. Verify data
那么"订单.id[${orderId}]"应为:
"""
.user.username = 'admin'
and .items.size = 1
and .status = 'PENDING'
"""
```

### Validation Pattern
```gherkin
场景大纲: 输入验证
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
  | name | price | errorCode        | errorMessage |
  |      | 99.99 | VALIDATION_ERROR | 名称不能为空 |
  | 产品 | -10   | VALIDATION_ERROR | 价格必须大于0 |
```

## HTTP Query Params & Headers

```gherkin
# Query parameters
When GET "/api/products" with query params:
"""
{
  "page": 0,
  "size": 10,
  "sort": "name,asc",
  "status": "ACTIVE"
}
"""

# Request headers
When GET "/api/products" with headers:
"""
{
  "Authorization": "Bearer ${token}",
  "Accept-Language": "zh-CN"
}
"""

# Response headers assertion
Then response should be:
"""
: {
  code: 200
  headers.Content-Type: 'application/json'
  headers.X-Total-Count: '100'
}
"""
```

## Running Tests

```bash
# All tests
mvn clean test

# Specific feature
mvn test -Dcucumber.features="src/test/resources/features/auth/login.feature"

# By tag
mvn test -Dcucumber.filter.tags="@smoke"
mvn test -Dcucumber.filter.tags="@smoke and @api"
mvn test -Dcucumber.filter.tags="@smoke or @regression"
mvn test -Dcucumber.filter.tags="not @slow"

# By scenario name
mvn test -Dcucumber.filter.name="AUTH-LOGIN.*"
```

## Common Errors & Fixes

| Error | Fix |
|-------|-----|
| Response body access fails | Use `body.json.*` not `body.*` |
| Variable not extracted | Use `: ${varName}` with colon |
| Got 2 objects | Use unique field or `所有"Spec"` |
| File upload fails | See file-upload.md |
| Step not found | Check `@Component` and glue path |

## Best Practices

1. ✅ Use `body.json.*` for JSON responses
2. ✅ Extract variables with `: ${varName}`
3. ✅ Use specific query fields (id, code, email)
4. ✅ Verify audit fields (createdAt, updatedAt)
5. ✅ Test independence - each scenario standalone
6. ✅ Meaningful names - `AUTH-LOGIN-001`
7. ✅ Standard steps first, custom only when needed

## Quick Links

- **Main Guide**: SKILL.md
- **Complete API**: references/framework-api.md
- **DAL Syntax**: references/dal-syntax.md
- **File Upload**: references/file-upload.md
- **Custom Steps**: references/custom-steps.md
- **Full Example**: EXAMPLE.md
