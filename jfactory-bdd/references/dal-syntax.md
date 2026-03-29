# DAL Expression Syntax Reference

DAL (Data Access Language) is a powerful assertion language provided by JFactory-cucumber for complex data structure validation.

## Basic Syntax

### Property Access
```
.property          # Access object property
.property.nested   # Access nested property
```

**Example:**
```gherkin
那么"用户.name[张三]"应为:
"""
.email='zhang@example.com'
and .status='ACTIVE'
"""
```

### Array/Collection Access
```
[index]           # Access array element by index (0-based)
.size             # Get collection size
.length           # Get string length
```

**Example:**
```gherkin
那么所有"商品"应为:
"""
.size=3
and [0].name='商品A'
and [1].name='商品B'
and [2].name='商品C'
"""
```

## Comparison Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `=` | Equal | `.price=29.99` |
| `!=` | Not equal | `.status!='DELETED'` |
| `>` | Greater than | `.quantity>0` |
| `>=` | Greater than or equal | `.age>=18` |
| `<` | Less than | `.stock<100` |
| `<=` | Less than or equal | `.discount<=0.5` |

**Example:**
```gherkin
那么"订单.orderNumber[ORD-001]"应为:
"""
.totalAmount > 0
and .discount <= 0.3
and .items.size >= 1
"""
```

## Logical Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `and` | Logical AND | `.name='书籍' and .price=29.99` |
| `or` | Logical OR | `.status='ACTIVE' or .status='PENDING'` |
| `not` | Logical NOT | `not .deleted` |

**Example:**
```gherkin
那么"用户.email[zhang@example.com]"应为:
"""
(.role='ADMIN' or .role='SUPER_ADMIN')
and not .locked
and .loginAttempts < 5
"""
```

## Collection Operations

### In Operator
```
in [value1, value2, ...]      # Check if value is in list
not in [value1, value2, ...]  # Check if value is not in list
```

**Example:**
```gherkin
那么"商品.name[书籍]"应为:
"""
.category in ['教育', '学习', '图书']
and .status not in ['DELETED', 'ARCHIVED']
"""
```

### Collection Filters
```
[condition]       # Filter collection by condition
```

**Example:**
```gherkin
那么"订单.orderNumber[ORD-001]"应为:
"""
.items[.quantity>1].size=2
and .items[.price>100].size=1
"""
```

## Existence Checks

```
${存在}           # Value exists (not null)
${不存在}         # Value does not exist (null)
```

**Example:**
```gherkin
Then response should be:
"""
: {
  code: 200
  body.json.token: ${存在}
  body.json.error: ${不存在}
}
"""
```

## Complex Expressions

### Nested Object Assertions
```gherkin
那么"订单.orderNumber[ORD-001]"应为:
"""
.customer.name='张三'
and .customer.email='zhang@example.com'
and .shippingAddress.city='北京'
and .shippingAddress.zipCode='100000'
"""
```

### Collection with Nested Objects
```gherkin
那么"购物车.customer[张三]"应为:
"""
.items.size=2
and .items[0].product.name='书籍'
and .items[0].product.price=29.99
and .items[0].quantity=2
and .items[1].product.name='文具'
"""
```

### Conditional Assertions
```gherkin
那么"商品.name[书籍]"应为:
"""
.price > 0
and .price < 1000
and .stock >= 10
and (.status='ACTIVE' or .status='PRESALE')
and .categories.size > 0
and .reviews[.rating>=4].size > .reviews.size * 0.7
"""
```

## Query Expression Syntax

Query expressions are used to locate specific records in test data.

### Basic Format
```
"Spec.property[value]"
```

**Example:**
```gherkin
那么"用户.email[zhang@example.com]"应为:
"""
.name='张三'
"""
```

### Multi-level Query
```
"Spec.property1[value1].property2[value2]"
```

**Example:**
```gherkin
那么"订单.customer.name[张三].orderNumber[ORD-001]"应为:
"""
.status='COMPLETED'
"""
```

### Collection Index Access
```
"Spec.collection[index]"
```

**Example:**
```gherkin
那么"用户.roles[0]"应为:
"""
.name='ADMIN'
"""
```

## DAL - Unified Assertion Design

DAL (Data Assertion Language) is designed as a **universal, composable assertion layer**. This means:

1. **Same syntax everywhere**: Whether you're asserting REST API responses, database records, or file content, the DAL syntax is consistent.

2. **Extensions are composable**: Extensions like XML matching, regex, and comparison operators can be applied to **any string field**, not just specific contexts.

3. **Extensible**: Custom matchers can be registered and used anywhere DAL is used.

### String Matching
```gherkin
# Exact match
.name='张三'

# Contains (requires custom extension)
.description contains '测试'

# Regex match (requires custom extension)
.email matches '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'
```

### Applying DAL to Any Context

DAL works consistently across different contexts:

**REST API Response**:
```gherkin
Then response should be:
"""
: {
  body.json.field: 'exact value'
  body.json.html: '/.*<html>.*/'
}
"""
```

**Database Assertion**:
```gherkin
那么"商品.name[书籍]"应为:
"""
.price > 100
"""
```

**File Content** (with XML extension):
```gherkin
那么"文件.path[/data.xml]"应为:
"""
string.toXml: <root><item>value</item></root>
"""
```

### Date/Time Comparison
```gherkin
# Basic comparison (requires proper date format)
.createdAt > '2024-01-01T00:00:00'
.updatedAt <= '2024-12-31T23:59:59'

# Date arithmetic (requires custom extension)
.expiresAt > ${now}
.createdAt > ${now - 7 days}
```

### Null/Empty Checks
```gherkin
# Check for null
.deletedAt: ${不存在}

# Check for not null
.createdAt: ${存在}

# Check for empty collection
.items.size=0

# Check for empty string
.description=''
```

## Common Patterns

### Pattern 1: Full Object Validation
```gherkin
那么"商品.name[书籍]"应为:
"""
.name='书籍'
and .price=29.99
and .category='教育'
and .status='ACTIVE'
and .stock=100
and .createdAt: ${存在}
and .updatedAt: ${存在}
"""
```

### Pattern 2: Partial Object Validation
```gherkin
那么"用户.email[zhang@example.com]"应为:
"""
.status='ACTIVE'
and .lastLoginAt: ${存在}
"""
```

### Pattern 3: Collection Validation
```gherkin
那么"订单.orderNumber[ORD-001]"应为:
"""
.items.size=3
and .items[0].quantity > 0
and .items[1].quantity > 0
and .items[2].quantity > 0
and .items[.product.price>100].size=1
"""
```

### Pattern 4: Complex Nested Validation
```gherkin
那么"购物车.customer[张三]"应为:
"""
.customer='张三'
and .items.size=2
and .items[0].product.name='书籍'
and .items[0].product.stocks.size=1
and .items[0].product.stocks[0].warehouse='仓库A'
and .items[0].product.stocks[0].quantity=100
and .totalAmount > 0
"""
```

## Troubleshooting

### Issue 1: Property Not Found
```
Error: Cannot find property 'xyz' on object
```
**Solution**:
- Verify property name matches exactly (case-sensitive)
- Check if property is accessible (public/has getter)
- Ensure object is not null

### Issue 2: Type Mismatch
```
Error: Cannot compare String with Integer
```
**Solution**:
- Use correct value type: `.price=29.99` not `.price='29.99'`
- For strings, use quotes: `.name='张三'`
- For numbers, no quotes: `.quantity=5`
- For booleans: `.active=true` or `.active=false`

### Issue 3: Collection Index Out of Bounds
```
Error: Index 5 out of bounds for size 3
```
**Solution**:
- Check collection size first: `.items.size=3`
- Use valid indices: `[0]`, `[1]`, `[2]` for size 3
- Use size-based conditions: `.items.size > 5`

### Issue 4: Multiple Results in Query
```
Error: Got 2 objects of "商品.name[书籍]"
```
**Solution**:
- Use more specific query: `"商品.name[书籍].category[教育]"`
- Or use `所有"商品"` to work with all results
- Ensure test data doesn't have duplicates

## Best Practices

1. **Keep Assertions Focused**: Assert only what matters for the test
2. **Use Meaningful Names**: Choose descriptive property names
3. **Validate Critical Fields**: Always check key business logic fields
4. **Check Existence First**: Use `${存在}` before accessing nested properties
5. **Use Appropriate Operators**: Choose `>` vs `>=` based on business rules
6. **Group Related Assertions**: Use `and` to combine related checks
7. **Handle Edge Cases**: Test boundary conditions (0, empty, null)

## Additional Resources

- **JFactory-cucumber Documentation**: https://github.com/leeonky/jfactory-cucumber
- **DAL-java Repository**: https://github.com/leeonky/DAL-java
- **Project Test Guidance**: `avia-base/AGENTS.md`
- **Test Lifecycle Notes**: `docs/modules/test/Test-Lifecycle.md`
