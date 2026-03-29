# JFactory-BDD Skill

A comprehensive BDD testing skill for Java/Spring Boot applications using Cucumber, JFactory, and RESTful-cucumber frameworks.

## Overview

This skill provides complete guidance for writing behavior-driven development (BDD) tests with:
- **Cucumber**: BDD framework with Gherkin syntax for readable test scenarios
- **JFactory-cucumber**: Advanced test data preparation and assertions
- **RESTful-cucumber**: REST API testing with minimal boilerplate

## Quick Start

1. **Read the main skill file**: `SKILL.md` - Contains quick start guide and common patterns
2. **Explore reference docs**: See `references/` directory for detailed documentation
3. **Run tests**: Use Maven to execute your feature files

## Directory Structure

```
jfactory-bdd/
├── SKILL.md                          # Main skill documentation
├── README.md                         # This file
└── references/                       # Detailed reference documentation
    ├── dal-syntax.md                 # DAL query and assertion language
    ├── file-upload.md                # File upload implementation guide
    ├── jfactory-config.md            # JFactory configuration reference
    ├── custom-steps.md               # Custom step definition patterns
    └── framework-api.md              # Complete framework API reference
```

## Documentation Guide

### For Beginners

Start with these resources in order:

1. **SKILL.md** - Read the "Quick Start" section to understand basic concepts
2. **framework-api.md** - Learn the standard steps provided by JFactory and RESTful-cucumber
3. **dal-syntax.md** - Understand how to query and assert data
4. **SKILL.md** - Study the "Common Patterns" section for real-world examples

### For Experienced Users

Quick reference for specific topics:

- **Data Preparation**: See SKILL.md § "Test Data Preparation" or framework-api.md § "JFactory-cucumber API"
- **API Testing**: See SKILL.md § "REST API Testing" or framework-api.md § "RESTful-cucumber API"
- **Response Assertions**: See SKILL.md § "Response Assertions" or dal-syntax.md
- **File Upload**: See file-upload.md for complete implementation guide
- **Custom Steps**: See custom-steps.md when framework steps are insufficient
- **Configuration**: See jfactory-config.md for JFactory setup

## Key Features

### 1. Zero Boilerplate Data Preparation

Create test data using natural Gherkin syntax:

```gherkin
假如存在"用户":
| username | email             |
| admin    | admin@example.com |
```

### 2. Intuitive API Testing

Test REST APIs without writing Java code:

```gherkin
When POST "/api/products":
"""
{
  "name": "新产品",
  "price": 99.99
}
"""

Then response should be:
"""
: {
  code: 201
  body.json.data.productId: ${productId}
}
"""
```

### 3. Powerful Assertions

Assert complex data structures with DAL syntax:

```gherkin
那么"订单.orderNumber[ORD-001]"应为:
"""
.customer.name = '张三'
and .items.size = 2
and .totalAmount > 0
"""
```

### 4. Framework-First Approach

Prioritize using standard framework steps to:
- Reduce custom code maintenance
- Leverage well-tested functionality
- Improve test readability
- Speed up test development

## Common Use Cases

### API Testing
- CRUD operations
- Input validation
- Error handling
- Authentication/Authorization
- Complex business flows

### Data Verification
- Database state assertions
- Relational data validation
- Collection operations
- Complex object structures

### Integration Testing
- End-to-end scenarios
- Multi-service interactions
- Event-driven workflows
- External API integrations

## Best Practices

1. **Use Standard Steps First**: Always check if JFactory/RESTful-cucumber provides the functionality before creating custom steps

2. **Test Independence**: Each scenario should be independent and not rely on other scenarios

3. **Meaningful Names**: Use descriptive scenario names with module-feature-number format (e.g., `AUTH-LOGIN-001`)

4. **Background for Setup**: Use `背景` (Background) for common setup shared across scenarios

5. **Clear Assertions**: Make assertions explicit and verify all important properties

6. **Keep It Simple**: Don't over-engineer tests; focus on behavior verification

## Running Tests

```bash
# Run all tests
mvn clean test

# Run specific feature
mvn test -Dcucumber.features="src/test/resources/features/auth/login.feature"

# Run by tags
mvn test -Dcucumber.filter.tags="@smoke"

# Run by scenario name pattern
mvn test -Dcucumber.filter.name="AUTH-.*"
```

## Troubleshooting

Common issues and solutions:

| Issue | Solution |
|-------|----------|
| Response body access error | Use `body.json.*` not `body.*` |
| Variable extraction fails | Ensure `: ${varName}` syntax |
| Multiple query results | Use more specific query or `所有"Spec"` |
| File upload fails | See file-upload.md for implementation |
| Step not found | Check component scan and glue configuration |

## Examples

See the `backend/src/test/resources/features/` directory in your project for real-world examples:

- `auth/password_auth.feature` - Authentication scenarios
- `document/document-upload.feature` - File upload scenarios
- Various domain-specific features

## Contributing

When adding new patterns or solutions:

1. Document in appropriate reference file
2. Add examples to SKILL.md if commonly used
3. Keep documentation clear and concise
4. Include both Chinese and English where applicable

## Framework Versions

This skill is designed for:
- Java 17+
- Spring Boot 2.x/3.x
- Cucumber 7+
- JFactory-cucumber latest
- RESTful-cucumber latest

## Additional Resources

- [Cucumber Documentation](https://cucumber.io/docs/cucumber/)
- [JFactory-cucumber GitHub](https://github.com/leeonky/jfactory-cucumber)
- [RESTful-cucumber GitHub](https://github.com/leeonky/RESTful-cucumber)
- [Gherkin Reference](https://cucumber.io/docs/gherkin/reference/)

## License

MIT License - See LICENSE file for details

---

**Note**: This skill is part of the onemin-aps project test infrastructure. For project-specific guidance, read `avia-base/AGENTS.md`, `docs/modules/test/Test-Lifecycle.md`, and nearby feature files under `avia-base/application/src/test/resources/features/`.
