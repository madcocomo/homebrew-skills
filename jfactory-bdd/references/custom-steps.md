# Custom Step Definitions Guide

## Overview

While JFactory-cucumber and RESTful-cucumber provide comprehensive standard steps, sometimes you need custom steps for domain-specific logic. This guide shows when and how to create custom steps.

## When to Create Custom Steps

### DO Create Custom Steps For:
1. **Domain-specific business logic**
2. **Complex setup that appears in multiple tests**
3. **Workarounds for framework limitations** (e.g., file upload)
4. **Custom assertions specific to your domain**
5. **Integration with external systems**

### DON'T Create Custom Steps For:
1. **Operations already covered by standard steps**
2. **One-off operations** (use standard steps instead)
3. **Simple data manipulation** (use JFactory specs instead)
4. **Basic REST operations** (use RESTful-cucumber steps)

## Step Definition Structure

### 1. Basic Step Definition

```java
package com.onemin.aps.steps;

import io.cucumber.java.en.Given;
import io.cucumber.java.en.When;
import io.cucumber.java.en.Then;
import org.springframework.stereotype.Component;

@Component
public class CustomSteps {

    @Given("the system time is {string}")
    public void setSystemTime(String dateTime) {
        // Implementation
    }

    @When("I wait for {int} seconds")
    public void waitForSeconds(int seconds) throws InterruptedException {
        Thread.sleep(seconds * 1000);
    }

    @Then("the database should contain {int} users")
    public void verifyUserCount(int expectedCount) {
        // Implementation
    }
}
```

### 2. Step with DataTable

```java
@Given("the following roles exist:")
public void createRoles(DataTable dataTable) {
    List<Map<String, String>> rows = dataTable.asMaps();

    for (Map<String, String> row : rows) {
        String name = row.get("name");
        String description = row.get("description");

        // Create role
        Role role = new Role();
        role.setName(name);
        role.setDescription(description);
        roleRepository.save(role);
    }
}
```

**Usage:**
```gherkin
Given the following roles exist:
| name  | description      |
| ADMIN | 管理员权限       |
| USER  | 普通用户权限     |
```

### 3. Step with DocString

```java
@Given("I have the following configuration:")
public void setConfiguration(String configJson) {
    JSONObject config = new JSONObject(configJson);
    // Apply configuration
    configService.applyConfig(config);
}
```

**Usage:**
```gherkin
Given I have the following configuration:
"""
{
  "maxUploadSize": 10485760,
  "allowedFileTypes": ["pdf", "doc", "docx"],
  "enableNotifications": true
}
"""
```

### 4. Step with Regular Expressions

```java
// Match: "I have 5 products", "I have 100 products"
@Given("I have {int} product(s)")
public void createProducts(int count) {
    for (int i = 0; i < count; i++) {
        // Create product
    }
}

// Match: "the product 'Book' has price 29.99"
@Given("the product {string} has price {double}")
public void setProductPrice(String productName, double price) {
    Product product = productRepository.findByName(productName);
    product.setPrice(BigDecimal.valueOf(price));
    productRepository.save(product);
}
```

## Common Custom Step Patterns

### Pattern 1: Authentication Steps

```java
@Component
public class AuthenticationSteps {

    @Autowired
    private RestfulStep restfulStep;

    @Autowired
    private JwtTokenProvider tokenProvider;

    private String currentAuthToken;

    @Given("I am authenticated as {string}")
    public void authenticateAs(String username) {
        User user = userRepository.findByUsername(username)
            .orElseThrow(() -> new IllegalStateException("User not found: " + username));

        // Generate JWT token
        currentAuthToken = tokenProvider.generateToken(user);

        // Set Authorization header
        Map<String, Object> headers = new HashMap<>();
        headers.put("Authorization", "Bearer " + currentAuthToken);
        restfulStep.header(headers);
    }

    @Given("I am not authenticated")
    public void clearAuthentication() {
        currentAuthToken = null;
        Map<String, Object> headers = new HashMap<>();
        headers.put("Authorization", null);
        restfulStep.header(headers);
    }

    @Then("I should receive an authentication error")
    public void verifyAuthenticationError() {
        // Verify 401 response
        restfulStep.responseShouldBe(
            ": {\n" +
            "  code: 401\n" +
            "  body.json.error: 'UNAUTHORIZED'\n" +
            "}"
        );
    }
}
```

**Usage:**
```gherkin
场景: 访问受保护资源需要认证
  Given I am authenticated as "admin"
  When GET "/api/admin/users"
  Then response should be:
  """
  : {
    code: 200
  }
  """

场景: 未认证用户无法访问受保护资源
  Given I am not authenticated
  When GET "/api/admin/users"
  Then I should receive an authentication error
```

### Pattern 2: Time Manipulation Steps

```java
@Component
public class TimeSteps {

    private Clock fixedClock;

    @Given("the current time is {string}")
    public void setCurrentTime(String isoDateTime) {
        Instant instant = Instant.parse(isoDateTime);
        fixedClock = Clock.fixed(instant, ZoneId.systemDefault());

        // Inject clock into services that need it
        // This requires your services to use Clock instead of LocalDateTime.now()
    }

    @Given("it is {int} days later")
    public void advanceTime(int days) {
        if (fixedClock != null) {
            Instant newInstant = fixedClock.instant().plus(Duration.ofDays(days));
            fixedClock = Clock.fixed(newInstant, ZoneId.systemDefault());
        }
    }

    @After
    public void resetClock() {
        fixedClock = null;
    }
}
```

**Usage:**
```gherkin
场景: 订单超时自动取消
  Given the current time is "2024-01-01T10:00:00Z"
  And 存在"订单":
  | orderNumber | status  |
  | ORD-001     | PENDING |

  When it is 7 days later
  And I run the order timeout check job

  Then "订单.orderNumber[ORD-001]"应为:
  """
  .status='CANCELLED'
  """
```

### Pattern 3: File Upload Steps

```java
@Component
public class FileUploadSteps {

    @Autowired
    private RestfulStep restfulStep;

    @Given("a file {string} with path {string}")
    public void registerFile(String fileKey, String filePath) throws IOException {
        Path testFilePath = Paths.get("src/test/resources", filePath);
        byte[] fileContent = Files.readAllBytes(testFilePath);
        String fileName = testFilePath.getFileName().toString();

        RestfulStep.UploadFile uploadFile = RestfulStep.UploadFile.content(fileContent)
            .name(fileName);

        restfulStep.file(fileKey, uploadFile);
    }

    @When("I upload file {string} to {string} as {string}")
    public void uploadFile(String filePath, String apiPath, String fileType)
            throws IOException, URISyntaxException {

        // Register file
        String fileKey = "tempFile";
        registerFile(fileKey, filePath);

        // Upload
        Map<String, String> formData = new HashMap<>();
        formData.put("@file", fileKey);
        formData.put("type", fileType);

        restfulStep.postForm(apiPath, formData);
    }
}
```

### Pattern 4: Database State Steps

```java
@Component
public class DatabaseSteps {

    @Autowired
    private EntityManager entityManager;

    @Given("the database is empty")
    public void clearDatabase() {
        // Clear all tables in reverse dependency order
        entityManager.createNativeQuery("DELETE FROM order_items").executeUpdate();
        entityManager.createNativeQuery("DELETE FROM orders").executeUpdate();
        entityManager.createNativeQuery("DELETE FROM products").executeUpdate();
        entityManager.createNativeQuery("DELETE FROM users").executeUpdate();
        entityManager.flush();
        entityManager.clear();
    }

    @Then("the {string} table should have {int} records")
    public void verifyTableRecordCount(String tableName, int expectedCount) {
        Long count = (Long) entityManager.createNativeQuery(
            "SELECT COUNT(*) FROM " + tableName
        ).getSingleResult();

        assertEquals(expectedCount, count.intValue(),
            "Expected " + expectedCount + " records in " + tableName +
            " but found " + count);
    }

    @Then("the {string} table should be empty")
    public void verifyTableIsEmpty(String tableName) {
        verifyTableRecordCount(tableName, 0);
    }
}
```

### Pattern 5: Message Queue Steps

```java
@Component
public class MessageQueueSteps {

    @Autowired
    private RabbitTemplate rabbitTemplate;

    private String lastReceivedMessage;

    @When("I send message to queue {string}:")
    public void sendMessage(String queueName, String messageBody) {
        rabbitTemplate.convertAndSend(queueName, messageBody);
    }

    @Then("I should receive a message from queue {string}:")
    public void verifyReceivedMessage(String queueName, String expectedMessage) {
        // Wait for message (with timeout)
        Message message = rabbitTemplate.receive(queueName, 5000);

        assertNotNull(message, "No message received from queue: " + queueName);

        String messageBody = new String(message.getBody());
        lastReceivedMessage = messageBody;

        assertEquals(expectedMessage, messageBody);
    }

    @Then("the message payload should contain:")
    public void verifyMessagePayload(String expectedJson) {
        assertNotNull(lastReceivedMessage, "No message was received");

        JSONObject actual = new JSONObject(lastReceivedMessage);
        JSONObject expected = new JSONObject(expectedJson);

        assertEquals(expected.toString(), actual.toString());
    }
}
```

**Usage:**
```gherkin
场景: 订单创建后发送通知消息
  Given 存在"用户":
  | username | email              |
  | testuser | test@example.com   |

  When POST "/api/orders":
  """
  {
    "userId": "${用户.username[testuser].id}",
    "items": [{"productId": "P001", "quantity": 2}]
  }
  """

  Then I should receive a message from queue "order.created":
  """
  {
    "orderId": "${orderId}",
    "userId": "${用户.username[testuser].id}",
    "eventType": "ORDER_CREATED"
  }
  """
```

### Pattern 6: External API Mock Steps

```java
@Component
public class ExternalApiSteps {

    @Autowired
    private WireMockServer wireMockServer;

    @Given("the payment gateway returns success for order {string}")
    public void mockPaymentSuccess(String orderNumber) {
        wireMockServer.stubFor(
            WireMock.post(WireMock.urlEqualTo("/api/payment/process"))
                .withRequestBody(WireMock.containing(orderNumber))
                .willReturn(WireMock.aResponse()
                    .withStatus(200)
                    .withHeader("Content-Type", "application/json")
                    .withBody("{\"status\":\"SUCCESS\",\"transactionId\":\"TXN-123\"}")
                )
        );
    }

    @Given("the payment gateway is unavailable")
    public void mockPaymentUnavailable() {
        wireMockServer.stubFor(
            WireMock.post(WireMock.urlEqualTo("/api/payment/process"))
                .willReturn(WireMock.aResponse()
                    .withStatus(503)
                    .withBody("{\"error\":\"SERVICE_UNAVAILABLE\"}")
                )
        );
    }

    @After
    public void resetWireMock() {
        wireMockServer.resetAll();
    }
}
```

## Best Practices

### 1. Keep Steps Focused
```java
// ✅ Good: Single responsibility
@Given("I am authenticated as {string}")
public void authenticateAs(String username) { ... }

// ❌ Bad: Multiple responsibilities
@Given("I am authenticated and have admin role and have created 5 products")
public void complexSetup() { ... }
```

### 2. Use Descriptive Names
```java
// ✅ Good: Clear intent
@When("I upload a PDF document to tender {string}")

// ❌ Bad: Unclear
@When("I do file stuff")
```

### 3. Leverage Dependency Injection
```java
@Component
public class CustomSteps {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private RestfulStep restfulStep;

    @Autowired
    private JFactory jFactory;

    // Use injected dependencies
}
```

### 4. Handle Cleanup
```java
@Component
public class StatefulSteps {

    private List<String> createdResourceIds = new ArrayList<>();

    @When("I create a temporary resource")
    public void createResource() {
        String resourceId = resourceService.create();
        createdResourceIds.add(resourceId);
    }

    @After
    public void cleanup() {
        // Clean up created resources
        createdResourceIds.forEach(resourceService::delete);
        createdResourceIds.clear();
    }
}
```

### 5. Provide Meaningful Error Messages
```java
@Then("the response should contain user {string}")
public void verifyUserInResponse(String username) {
    JSONObject response = getResponseBody();

    assertTrue(
        response.has("user"),
        "Response does not contain 'user' field. Actual response: " + response
    );

    String actualUsername = response.getJSONObject("user").getString("username");

    assertEquals(
        username,
        actualUsername,
        "Expected user '" + username + "' but found '" + actualUsername + "'"
    );
}
```

### 6. Reuse Standard Steps
```java
@Component
public class CompositeSteps {

    @Autowired
    private RestfulStep restfulStep;

    @When("I create a product with name {string} and price {double}")
    public void createProduct(String name, double price) throws Exception {
        // Reuse standard POST step
        String requestBody = String.format(
            "{\"name\":\"%s\",\"price\":%.2f}",
            name, price
        );

        restfulStep.post("/api/products", requestBody, "application/json");
    }
}
```

## Testing Custom Steps

### Unit Test Example
```java
@ExtendWith(MockitoExtension.class)
class AuthenticationStepsTest {

    @Mock
    private UserRepository userRepository;

    @Mock
    private JwtTokenProvider tokenProvider;

    @Mock
    private RestfulStep restfulStep;

    @InjectMocks
    private AuthenticationSteps authenticationSteps;

    @Test
    void shouldAuthenticateUser() {
        // Given
        User user = new User();
        user.setUsername("testuser");
        when(userRepository.findByUsername("testuser"))
            .thenReturn(Optional.of(user));
        when(tokenProvider.generateToken(user))
            .thenReturn("mock-token");

        // When
        authenticationSteps.authenticateAs("testuser");

        // Then
        verify(restfulStep).header(argThat(headers ->
            headers.get("Authorization").equals("Bearer mock-token")
        ));
    }
}
```

## Troubleshooting

### Issue 1: Step Not Found
```
Undefined step: Given I am authenticated as "admin"
```
**Solution**:
- Verify step definition exists
- Check `@Component` annotation on step class
- Ensure glue path includes step package in CucumberTestRunner

### Issue 2: Ambiguous Steps
```
Multiple step definitions match: "I create a product"
```
**Solution**:
- Make step patterns more specific
- Use different wording for different steps
- Check for duplicate step definitions

### Issue 3: Dependency Injection Fails
```
NullPointerException when accessing @Autowired field
```
**Solution**:
- Add `@Component` to step class
- Ensure Spring context is loaded in tests
- Check component scan configuration

## References

- Cucumber Java Documentation: https://cucumber.io/docs/cucumber/api/?lang=java
- Cucumber Expressions: https://github.com/cucumber/cucumber-expressions
- Spring Testing Guide: https://docs.spring.io/spring-framework/docs/current/reference/html/testing.html
