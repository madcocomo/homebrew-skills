# Example: Complete Product Management Test

This example demonstrates a complete product management API test using JFactory-BDD.

## Feature File

```gherkin
# language: zh-CN
# File: backend/src/test/resources/features/product/product-management.feature

功能: 产品管理

  作为系统管理员
  我想要管理产品信息
  以便维护产品目录

  背景:
    假如存在"用户":
    | username | email             | role  | status |
    | admin    | admin@example.com | ADMIN | ACTIVE |

    并且存在"产品分类":
    | code | name   | description |
    | ELEC | 电子   | 电子产品    |
    | BOOK | 图书   | 图书类      |
    | FOOD | 食品   | 食品类      |

  规则: 产品创建和查询

    @smoke @api
    场景: PROD-CREATE-001 成功创建产品
      When POST "/api/products":
      """
      {
        "name": "MacBook Pro",
        "description": "Apple笔记本电脑",
        "price": 12999.00,
        "categoryCode": "ELEC",
        "stock": 50,
        "sku": "APPLE-MBP-001",
        "specifications": {
          "brand": "Apple",
          "model": "MacBook Pro 14-inch",
          "year": 2024
        }
      }
      """

      Then response should be:
      """
      : {
        code: 201
        body.json.success: true
        body.json.data.productId: ${productId}
        body.json.data.name: 'MacBook Pro'
        body.json.data.price: 12999.00
        body.json.data.category.code: 'ELEC'
        body.json.data.category.name: '电子'
        body.json.data.sku: 'APPLE-MBP-001'
        body.json.data.stock: 50
        body.json.data.status: 'ACTIVE'
        body.json.data.createdAt: ${存在}
      }
      """

      那么"产品.id[${productId}]"应为:
      """
      .name = 'MacBook Pro'
      and .description = 'Apple笔记本电脑'
      and .price = 12999.00
      and .category.code = 'ELEC'
      and .sku = 'APPLE-MBP-001'
      and .stock = 50
      and .status = 'ACTIVE'
      and .specifications.brand = 'Apple'
      and .specifications.model = 'MacBook Pro 14-inch'
      and .createdAt != null
      and .updatedAt != null
      """

    @api
    场景: PROD-QUERY-001 根据分类查询产品列表
      假如存在"产品":
      | name        | price     | category                | stock | status   |
      | MacBook Pro | 12999.00  | @产品分类.code[ELEC]    | 50    | ACTIVE   |
      | iPhone 15   | 5999.00   | @产品分类.code[ELEC]    | 100   | ACTIVE   |
      | 数据结构    | 89.00     | @产品分类.code[BOOK]    | 200   | ACTIVE   |
      | 算法导论    | 128.00    | @产品分类.code[BOOK]    | 150   | ACTIVE   |
      | 有机食品    | 25.00     | @产品分类.code[FOOD]    | 0     | INACTIVE |

      When GET "/api/products" with query params:
      """
      {
        "categoryCode": "ELEC",
        "status": "ACTIVE",
        "minPrice": 1000,
        "page": 0,
        "size": 10,
        "sort": "price,desc"
      }
      """

      Then response should be:
      """
      : {
        code: 200
        body.json.success: true
        body.json.data.content.size: 2
        body.json.data.content[0].name: 'MacBook Pro'
        body.json.data.content[0].price: 12999.00
        body.json.data.content[1].name: 'iPhone 15'
        body.json.data.content[1].price: 5999.00
        body.json.data.totalElements: 2
        body.json.data.totalPages: 1
        body.json.data.first: true
        body.json.data.last: true
      }
      """

  规则: 产品更新和删除

    @api
    场景: PROD-UPDATE-001 成功更新产品信息
      假如存在"产品":
      | id  | name      | price    | category                | sku           |
      | 100 | 旧产品名  | 999.00   | @产品分类.code[ELEC]    | OLD-SKU-001   |

      When PUT "/api/products/100":
      """
      {
        "name": "新产品名",
        "description": "更新后的描述",
        "price": 1299.00,
        "categoryCode": "BOOK",
        "stock": 150
      }
      """

      Then response should be:
      """
      : {
        code: 200
        body.json.success: true
        body.json.data.id: 100
        body.json.data.name: '新产品名'
        body.json.data.description: '更新后的描述'
        body.json.data.price: 1299.00
        body.json.data.category.code: 'BOOK'
        body.json.data.stock: 150
      }
      """

      那么"产品.id[100]"应为:
      """
      .name = '新产品名'
      and .description = '更新后的描述'
      and .price = 1299.00
      and .category.code = 'BOOK'
      and .stock = 150
      and .sku = 'OLD-SKU-001'
      and .updatedAt != null
      and .updatedAt > .createdAt
      """

    @api
    场景: PROD-PATCH-001 部分更新产品价格
      假如存在"产品":
      | id  | name   | price    |
      | 101 | 测试   | 999.00   |

      When PATCH "/api/products/101":
      """
      {
        "price": 799.00
      }
      """

      Then response should be:
      """
      : {
        code: 200
        body.json.data.price: 799.00
      }
      """

      那么"产品.id[101]"应为:
      """
      .name = '测试'
      and .price = 799.00
      and .updatedAt > .createdAt
      """

    @api
    场景: PROD-DELETE-001 软删除产品
      假如存在"产品":
      | id  | name   | status |
      | 102 | 待删除 | ACTIVE |

      When DELETE "/api/products/102"

      Then response should be:
      """
      : {
        code: 204
      }
      """

      那么"产品.id[102]"应为:
      """
      .status = 'DELETED'
      and .deletedAt != null
      and .deletedBy != null
      """

  规则: 输入验证

    @api @validation
    场景大纲: PROD-VALID-001 产品创建输入验证
      When POST "/api/products":
      """
      {
        "name": "<name>",
        "price": <price>,
        "categoryCode": "<categoryCode>",
        "stock": <stock>
      }
      """

      Then response should be:
      """
      : {
        code: 400
        body.json.error: 'VALIDATION_ERROR'
        body.json.message: '<errorMessage>'
      }
      """

      例子:
      | name   | price    | categoryCode | stock | errorMessage           |
      |        | 999.00   | ELEC         | 10    | 产品名称不能为空       |
      | 产品   | -100     | ELEC         | 10    | 价格必须大于0          |
      | 产品   | 999.00   |              | 10    | 产品分类不能为空       |
      | 产品   | 999.00   | INVALID      | 10    | 产品分类不存在         |
      | 产品   | 999.00   | ELEC         | -5    | 库存不能为负数         |

  规则: 库存管理

    @api
    场景: PROD-STOCK-001 库存不足时无法购买
      假如存在"产品":
      | id  | name   | stock |
      | 103 | 测试   | 5     |

      When POST "/api/orders":
      """
      {
        "items": [
          {
            "productId": 103,
            "quantity": 10
          }
        ]
      }
      """

      Then response should be:
      """
      : {
        code: 400
        body.json.error: 'INSUFFICIENT_STOCK'
        body.json.message: '库存不足'
      }
      """

    @api
    场景: PROD-STOCK-002 成功扣减库存
      假如存在"产品":
      | id  | name   | price   | stock |
      | 104 | 测试   | 999.00  | 100   |

      When POST "/api/orders":
      """
      {
        "items": [
          {
            "productId": 104,
            "quantity": 10
          }
        ]
      }
      """

      Then response should be:
      """
      : {
        code: 201
        body.json.data.orderId: ${orderId}
      }
      """

      那么"产品.id[104]"应为:
      """
      .stock = 90
      """

      那么"订单.id[${orderId}]"应为:
      """
      .status = 'PENDING'
      and .items.size = 1
      and .items[0].product.id = 104
      and .items[0].quantity = 10
      and .items[0].unitPrice = 999.00
      and .totalAmount = 9990.00
      """

  规则: 复杂场景

    @api @integration
    场景: PROD-COMPLEX-001 完整的购物流程
      # 准备测试数据
      假如存在"用户":
      | username | email              |
      | buyer    | buyer@example.com  |

      并且存在"产品":
      | id  | name        | price    | stock |
      | 201 | MacBook Pro | 12999.00 | 10    |
      | 202 | iPhone 15   | 5999.00  | 20    |
      | 203 | AirPods     | 1299.00  | 50    |

      # 创建购物车
      When POST "/api/carts":
      """
      {
        "userId": "${用户.username[buyer].id}"
      }
      """

      Then response should be:
      """
      : {
        code: 201
        body.json.data.cartId: ${cartId}
      }
      """

      # 添加商品到购物车
      When POST "/api/carts/${cartId}/items":
      """
      [
        {"productId": 201, "quantity": 1},
        {"productId": 202, "quantity": 2},
        {"productId": 203, "quantity": 1}
      ]
      """

      Then response should be:
      """
      : {
        code: 200
        body.json.data.items.size: 3
        body.json.data.totalAmount: 26296.00
      }
      """

      # 验证购物车数据
      那么"购物车.id[${cartId}]"应为:
      """
      .user.username = 'buyer'
      and .items.size = 3
      and .items[0].product.id = 201
      and .items[0].quantity = 1
      and .items[1].product.id = 202
      and .items[1].quantity = 2
      and .items[2].product.id = 203
      and .items[2].quantity = 1
      and .totalAmount = 26296.00
      """

      # 创建订单
      When POST "/api/orders/from-cart/${cartId}":
      """
      {
        "shippingAddress": {
          "province": "北京",
          "city": "北京",
          "district": "朝阳区",
          "detail": "某某街道123号"
        }
      }
      """

      Then response should be:
      """
      : {
        code: 201
        body.json.data.orderId: ${orderId}
        body.json.data.orderNumber: ${orderNumber}
      }
      """

      # 验证订单数据
      那么"订单.id[${orderId}]"应为:
      """
      .orderNumber = '${orderNumber}'
      and .user.username = 'buyer'
      and .items.size = 3
      and .totalAmount = 26296.00
      and .status = 'PENDING'
      and .shippingAddress.province = '北京'
      """

      # 验证库存已扣减
      那么"产品.id[201]"应为:
      """
      .stock = 9
      """

      那么"产品.id[202]"应为:
      """
      .stock = 18
      """

      那么"产品.id[203]"应为:
      """
      .stock = 49
      """
```

## Key Takeaways

This example demonstrates:

1. **Complete CRUD operations**: Create, Read, Update, Delete
2. **Data preparation**: Using JFactory to create test data with relationships
3. **API testing**: Testing various HTTP methods (GET, POST, PUT, PATCH, DELETE)
4. **Response assertions**: Validating API responses and extracting variables
5. **Data assertions**: Verifying database state after operations
6. **Scenario outlines**: Parameterized tests for validation scenarios
7. **Complex workflows**: Multi-step integration test with data relationships
8. **Best practices**: Meaningful naming, test organization, proper assertions

## Running This Example

```bash
# Run all product tests
mvn test -Dcucumber.features="src/test/resources/features/product/"

# Run only smoke tests
mvn test -Dcucumber.filter.tags="@smoke"

# Run specific scenario
mvn test -Dcucumber.filter.name="PROD-CREATE-001"
```
