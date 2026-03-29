# JFactory Configuration Guide

## Overview

JFactory is a test data factory framework that provides powerful data preparation capabilities. This guide covers the configuration and usage of JFactory in your project.

## Configuration Architecture

### 1. JFactoryConfig

The main configuration class that sets up JFactory instance and data repository.

```java
package com.onemin.aps.jfactory;

import com.github.leeonky.jfactory.JFactory;
import com.github.leeonky.jfactory.Spec;
import jakarta.persistence.EntityManager;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class JFactoryConfig {

    @Bean
    public JFactory jFactory(ApplicationContext applicationContext,
                            EntityManager entityManager) {
        JFactory jFactory = new JFactory();

        // Register JPA repository
        jFactory.factory(new JakartaJPADataRepository(entityManager));

        // Register all Spec beans from Spring context
        applicationContext.getBeansOfType(Spec.class)
            .values()
            .forEach(jFactory::register);

        return jFactory;
    }
}
```

### 2. JakartaJPADataRepository

Data repository implementation using Jakarta JPA for persistence operations.

```java
package com.onemin.aps.jfactory;

import com.github.leeonky.jfactory.DataRepository;
import jakarta.persistence.EntityManager;
import jakarta.persistence.TypedQuery;
import jakarta.persistence.criteria.CriteriaBuilder;
import jakarta.persistence.criteria.CriteriaQuery;
import jakarta.persistence.criteria.Root;

import java.util.List;

public class JakartaJPADataRepository implements DataRepository {

    private final EntityManager entityManager;

    public JakartaJPADataRepository(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public <T> T save(T entity) {
        entityManager.persist(entity);
        entityManager.flush();
        return entity;
    }

    @Override
    public <T> List<T> queryAll(Class<T> entityClass) {
        CriteriaBuilder cb = entityManager.getCriteriaBuilder();
        CriteriaQuery<T> cq = cb.createQuery(entityClass);
        Root<T> root = cq.from(entityClass);
        cq.select(root);

        TypedQuery<T> query = entityManager.createQuery(cq);
        return query.getResultList();
    }

    @Override
    public void clear() {
        entityManager.clear();
    }
}
```

### 3. Specs Definition

Define default values and factories for your domain entities.

```java
package com.onemin.aps.jfactory.spec;

import com.github.leeonky.jfactory.Spec;
import com.onemin.aps.domain.User;
import com.onemin.aps.domain.Product;
import com.onemin.aps.domain.Order;
import org.springframework.context.annotation.Bean;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.math.BigDecimal;

@Component
public class Specs {

    @Bean
    public Spec<User> user() {
        return new Spec<>(User.class)
            .property("username", "testuser")
            .property("email", "test@example.com")
            .property("password", "$2a$10$hashed_password") // BCrypt hashed
            .property("status", UserStatus.ACTIVE)
            .property("createdAt", LocalDateTime.now())
            .property("updatedAt", LocalDateTime.now());
    }

    @Bean
    public Spec<Product> product() {
        return new Spec<>(Product.class)
            .property("name", "默认商品")
            .property("price", new BigDecimal("99.99"))
            .property("stock", 100)
            .property("status", ProductStatus.ACTIVE)
            .property("category", "DEFAULT")
            .property("createdAt", LocalDateTime.now());
    }

    @Bean
    public Spec<Order> order() {
        return new Spec<>(Order.class)
            .property("orderNumber", () -> "ORD-" + System.currentTimeMillis())
            .property("status", OrderStatus.PENDING)
            .property("totalAmount", BigDecimal.ZERO)
            .property("createdAt", LocalDateTime.now())
            .property("updatedAt", LocalDateTime.now());
    }
}
```

## Spec Features

### 1. Static Values
```java
.property("name", "固定值")
.property("price", new BigDecimal("99.99"))
.property("status", Status.ACTIVE)
```

### 2. Dynamic Values (Suppliers)
```java
// Generate unique values
.property("orderNumber", () -> "ORD-" + System.currentTimeMillis())
.property("uuid", () -> UUID.randomUUID().toString())

// Current timestamp
.property("createdAt", LocalDateTime::now)

// Random values
.property("code", () -> "CODE-" + new Random().nextInt(10000))
```

### 3. Relationships

#### Many-to-One (Belongs To)
```java
@Bean
public Spec<OrderItem> orderItem() {
    return new Spec<>(OrderItem.class)
        .property("quantity", 1)
        .property("price", BigDecimal.ZERO)
        .link("order", "order")        // References "order" spec
        .link("product", "product");   // References "product" spec
}
```

**Usage in Feature:**
```gherkin
假如存在"订单项":
| quantity | order.orderNumber | product.name |
| 2        | ORD-001          | 书籍         |
```

#### One-to-Many (Has Many)
```java
@Bean
public Spec<Order> order() {
    return new Spec<>(Order.class)
        .property("orderNumber", () -> "ORD-" + System.currentTimeMillis())
        .property("status", OrderStatus.PENDING)
        .collection("items");  // Collection property
}
```

**Usage in Feature:**
```gherkin
假如存在"订单":
| orderNumber |
| ORD-001     |

并且存在"订单.orderNumber[ORD-001].items"的"订单项":
| quantity | product.name |
| 2        | 书籍         |
| 1        | 文具         |
```

#### Many-to-Many
```java
@Bean
public Spec<User> user() {
    return new Spec<>(User.class)
        .property("username", "testuser")
        .collection("roles");
}

@Bean
public Spec<Role> role() {
    return new Spec<>(Role.class)
        .property("name", "USER")
        .collection("users");
}
```

**Usage in Feature:**
```gherkin
假如存在"用户":
| username |
| zhangsan |

并且存在"用户.username[zhangsan].roles"的"角色":
| name  |
| ADMIN |
| USER  |
```

### 4. Traits

Traits allow you to create variations of specs.

```java
@Bean
public Spec<Product> product() {
    return new Spec<>(Product.class)
        .property("name", "默认商品")
        .property("price", new BigDecimal("99.99"))
        .property("status", ProductStatus.ACTIVE)

        // Define traits
        .trait("premium", spec -> spec
            .property("price", new BigDecimal("999.99"))
            .property("category", "PREMIUM"))

        .trait("onSale", spec -> spec
            .property("status", ProductStatus.ON_SALE)
            .property("discount", new BigDecimal("0.2")))

        .trait("outOfStock", spec -> spec
            .property("stock", 0)
            .property("status", ProductStatus.OUT_OF_STOCK));
}
```

**Usage in Feature:**
```gherkin
# Use trait
假如存在"高端的 商品":
| name     |
| 高端商品 |

# Combine multiple traits
假如存在"高端的 促销的 商品":
| name         |
| 高端促销商品 |
```

### 5. Post-Create Hooks

Execute logic after entity creation.

```java
@Bean
public Spec<Order> order() {
    return new Spec<>(Order.class)
        .property("orderNumber", () -> "ORD-" + System.currentTimeMillis())
        .property("status", OrderStatus.PENDING)
        .onCreate(order -> {
            // Calculate total amount after items are added
            BigDecimal total = order.getItems().stream()
                .map(item -> item.getPrice().multiply(
                    BigDecimal.valueOf(item.getQuantity())))
                .reduce(BigDecimal.ZERO, BigDecimal::add);
            order.setTotalAmount(total);
        });
}
```

## Cucumber Integration

### 1. CucumberTestRunner

Configure Cucumber to use JFactory and RESTful steps.

```java
package com.onemin.aps;

import io.cucumber.junit.platform.engine.Constants;
import org.junit.platform.suite.api.ConfigurationParameter;
import org.junit.platform.suite.api.IncludeEngines;
import org.junit.platform.suite.api.SelectClasspathResource;
import org.junit.platform.suite.api.Suite;

@Suite
@IncludeEngines("cucumber")
@SelectClasspathResource("features")
@ConfigurationParameter(
    key = Constants.GLUE_PROPERTY_NAME,
    value = "com.github.leeonky.jfactory.cucumber," +
            "com.github.leeonky.cucumber.restful," +
            "com.onemin.aps.steps"
)
@ConfigurationParameter(
    key = Constants.PLUGIN_PROPERTY_NAME,
    value = "pretty, html:target/cucumber-reports/cucumber.html"
)
public class CucumberTestRunner {
}
```

### 2. Spring Configuration

```java
package com.onemin.aps.config;

import com.github.leeonky.cucumber.restful.RestfulStep;
import com.github.leeonky.jfactory.JFactory;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;

@TestConfiguration
public class CucumberSpringConfig {

    @Bean
    public RestfulStep restfulStep() {
        RestfulStep restfulStep = new RestfulStep();
        // Configure base URL for API tests
        restfulStep.setBaseUrl("http://localhost:${local.server.port}");
        return restfulStep;
    }
}
```

### 3. Test Application Properties

```yaml
# src/test/resources/application-test.yml
spring:
  datasource:
    url: jdbc:h2:mem:testdb
    driver-class-name: org.h2.Driver
    username: sa
    password:

  jpa:
    hibernate:
      ddl-auto: create-drop
    show-sql: true
    properties:
      hibernate:
        format_sql: true
        dialect: org.hibernate.dialect.H2Dialect

  liquibase:
    enabled: true
    change-log: classpath:db/changelog/db.changelog-master.xml

server:
  port: 0  # Random port for testing

logging:
  level:
    com.onemin.aps: DEBUG
    org.hibernate.SQL: DEBUG
```

## Advanced Patterns

### 1. Hierarchical Data

```gherkin
假如存在:
"""
组织:
  - name: 公司A
    code: ORG-001
    departments:
      - name: 技术部
        code: DEPT-001
        employees:
          - name: 张三
            email: zhang@example.com
          - name: 李四
            email: li@example.com
      - name: 销售部
        code: DEPT-002
        employees:
          - name: 王五
            email: wang@example.com
"""
```

### 2. Complex Relationships

```java
@Bean
public Spec<Tender> tender() {
    return new Spec<>(Tender.class)
        .property("tenderCode", () -> "T-" + System.currentTimeMillis())
        .property("name", "默认标书")
        .property("status", TenderStatus.DRAFT)
        .link("creator", "user")
        .collection("documents")
        .collection("participants")
        .onCreate(tender -> {
            // Auto-set creation info
            tender.setCreatedAt(LocalDateTime.now());
            tender.setUpdatedAt(LocalDateTime.now());
        });
}
```

**Usage:**
```gherkin
假如存在"标书":
| tenderCode | name     | creator.username |
| T-001      | 测试标书 | admin            |

并且存在"标书.tenderCode[T-001].documents"的"文档":
| fileName      | type     |
| 技术方案.pdf  | TECHNICAL |
| 商务方案.pdf  | BUSINESS  |

并且存在"标书.tenderCode[T-001].participants"的"参与者":
| user.username | role      |
| user1        | REVIEWER  |
| user2        | APPROVER  |
```

### 3. Custom Factories

For complex object creation logic:

```java
@Component
public class CustomFactories {

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Bean
    public Spec<User> authenticatedUser() {
        return new Spec<>(User.class)
            .property("username", "testuser")
            .property("email", "test@example.com")
            .property("status", UserStatus.ACTIVE)
            .onCreate(user -> {
                // Encrypt password
                user.setPassword(passwordEncoder.encode("password123"));

                // Generate verification token
                user.setVerificationToken(UUID.randomUUID().toString());

                // Set timestamps
                user.setCreatedAt(LocalDateTime.now());
                user.setLastLoginAt(LocalDateTime.now());
            });
    }
}
```

## Troubleshooting

### Issue 1: Spec Not Found
```
Error: Cannot find spec 'xyz'
```
**Solution**:
- Ensure Spec bean is defined in Specs class
- Check bean name matches the spec name used in feature file
- Verify `@Component` annotation on Specs class

### Issue 2: Circular Dependencies
```
Error: Circular dependency detected
```
**Solution**:
- Use `.link()` instead of directly creating related objects
- Define relationships in one direction
- Use lazy initialization

### Issue 3: Unique Constraint Violation
```
Error: Duplicate key value violates unique constraint
```
**Solution**:
- Use dynamic values for unique fields:
  ```java
  .property("email", () -> "user" + System.currentTimeMillis() + "@example.com")
  .property("username", () -> "user_" + UUID.randomUUID().toString().substring(0, 8))
  ```

### Issue 4: Transaction Issues
```
Error: No transaction is in progress
```
**Solution**:
- Add `@Transactional` to test class:
  ```java
  @SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
  @Transactional
  public class CucumberSpringConfig {
  }
  ```

## Best Practices

1. **Meaningful Defaults**: Set sensible default values for all properties
2. **Dynamic Unique Values**: Use suppliers for unique fields (email, username, codes)
3. **Minimal Data**: Only create data necessary for the test
4. **Clear Traits**: Use traits for common variations
5. **Organized Specs**: Group related specs in logical packages
6. **Reusable Specs**: Design specs to be reusable across multiple tests
7. **Documentation**: Document custom traits and complex specs

## References

- JFactory Documentation: https://github.com/leeonky/jfactory
- JFactory-Cucumber: https://github.com/leeonky/jfactory-cucumber
- Spring Boot Testing Guide: https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.testing
