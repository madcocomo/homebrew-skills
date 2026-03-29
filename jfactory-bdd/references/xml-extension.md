# XML Extension for JFactory

## Overview

The XML Extension provides comprehensive XML support for JFactory, enabling:
- XML test data preparation
- XML content verification in responses and files
- Flexible XML comparison with partial matching
- Advanced list matching capabilities

## Configuration

### Maven Dependencies

Add the following dependencies to your `pom.xml`:

```xml
<dependency>
    <groupId>org.xmlunit</groupId>
    <artifactId>xmlunit-core</artifactId>
    <version>2.9.1</version>
    <scope>test</scope>
</dependency>

<dependency>
    <groupId>org.xmlunit</groupId>
    <artifactId>xmlunit-legacy</artifactId>
    <version>2.9.1</version>
    <scope>test</scope>
</dependency>

<dependency>
    <groupId>com.github.leeonky.dal</groupId>
    <artifactId>dal</artifactId>
    <version>1.7.7</version>
    <scope>test</scope>
</dependency>

<dependency>
    <groupId>com.github.leeonky.jfactory</groupId>
    <artifactId>jfactory-cucumber</artifactId>
    <version>1.4.0</version>
    <scope>test</scope>
</dependency>
```

### JFactory Configuration

Update your `JFactoryConfig.java`:

```java
@Configuration
public class JFactoryConfig {

    @Bean
    public JFactory jFactory(DataRepository repository) {
        JFactory jFactory = new JFactory(repository);
        registerSpecs(jFactory);
        registerTextFormater();
        new XmlExtension().extend(DAL.getInstance());
        return jFactory;
    }

    @SuppressWarnings("unchecked")
    private static void registerSpecs(JFactory jFactory) {
        Classes.assignableTypesOf(Spec.class, "io.rivendale.avia.jfactory.spec")
            .forEach(jFactory::register);
    }

    private static void registerTextFormater() {
        DAL.getInstance().getRuntimeContextBuilder()
                .registerTextFormatter("OS-EOL", new TextFormatter<String, String>() {
                    @Override
                    public String description() {
                        return "use system line break as new line";
                    }

                    @Override
                    protected TextAttribute attribute(TextAttribute attribute) {
                        return attribute.newLine(System.lineSeparator());
                    }
                });
    }
}
```

## Components

### 1. XmlExtension

Main extension class that registers:
- XML helper methods (`xml()`, `toXml()`)
- XML checkers (`equals`, `matches`)
- FileGroup readers for XML files

### 2. XmlAssertions

Provides XML comparison functionality using XMLUnit:
- Exact comparison (strict mode)
- Partial comparison (flexible mode)
- Custom difference evaluator

### 3. ControlModeUtil

Manages XML comparison modes via processing instructions:
- `PI_STRICT`: "strict" mode for exact matching
- `PI_LIST`: "list" mode for flexible list matching

### 4. ExtendableNodeMatcher

Enhanced node matcher that supports:
- Element matching
- Comment nodes
- Attribute matching
- List sequence matching

### 5. FunctionalUtil

Utility class for exception handling:
- `wrapException()`: Wraps checked exceptions
- Helper methods for file operations

## Usage Examples

### Creating XML Test Data

```gherkin
假如存在"File":
"""
[{
  path: "/A320/EN/DM/DATA.XML"
  versions: [{
    fileContent: {
      variant: "main"
      encoding: "UTF-8"
      mimeType: "application/xml"
      data: '''
<dmodule xmlns="http://www.ataebiz.org/XMLSchema">
   <content>
      <dispatchProcedure id="dp-1">
         <procContent>
            <inform>
              <para>Test content</para>
            </inform>
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

### Verifying XML Response

```gherkin
When GET "/api/files/A320/EN/DM/DATA.XML"
Then response should be:
"""
body.xml: ```
<dmodule>
   <content>
      <dispatchProcedure id="dp-1">
         <procContent>
            <inform> <para>Test content</para> </inform>
         </procContent>
      </dispatchProcedure>
   </content>
</dmodule>
```
"""
```

### Negative Verification

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
  /Expected.*but was.*/
...]
"""
```

## Advanced Features

### List Matching Mode

Enable flexible list matching with `<?XML_DIFF list?>`:

```gherkin
Then file "xml/list.xml" should be:
"""
string.toXml: ```
<items><?XML_DIFF list?>
    <wrapper><item type="A" title="item A"/>Info A</wrapper>
    <wrapper><item type="B" title="item B"/>Info B</wrapper>
    <wrapper><item type="C" title="item C"/>Info C</wrapper>
</items>
```
"""
```

### Ignoring Specific Values

Use `...` to ignore specific values:

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
               <inform> <para>Test content</para> </inform>
            </nestedProcedure>
         </procContent>
      </dispatchProcedure>
   </content>
</dmodule>
```
"""
```

### Flexible List Matching

Match specific items while ignoring others:

```gherkin
Then file "xml/list.xml" should be:
"""
string.toXml: ```
<items><?XML_DIFF list?>
    ...
    <wrapper><item type="B" title="item B"/>...</wrapper>
    ...
    <wrapper><item type="D" title="item D"/>...</wrapper>
    ...
</items>
```
"""
```

## API Reference

### XmlExtension Methods

- `xml(byte[] data)`: Convert byte array to XmlData
- `xml(CharSequence data)`: Convert string to XmlData
- `toXml(CharSequence data)`: Alias for xml()

### XmlChecker Methods

- `equals(Data d1, Data d2)`: Exact XML comparison
- `matches(Data d1, Data d2)`: Partial XML comparison

### DAL Operators

- `=`: Exact match (strict mode)
- `:`: Partial match (flexible mode)
- `string.toXml`: Access XML content from file

## Best Practices

1. **Use partial matching for complex XML**: Prefer `:` over `=` for flexible assertions
2. **Leverage list mode for arrays**: Use `<?XML_DIFF list?>` for matching lists
3. **Ignore dynamic values**: Use `...` for values that change frequently
4. **Test negative cases**: Verify XML validation errors with `should NOT be`
5. **Organize test files**: Keep XML test files in dedicated directories (e.g., `xml/`)

## Troubleshooting

### XML Comparison Fails

**Problem**: Namespace or whitespace differences cause failures

**Solution**:
- Use partial matching (`:`, not `=`)
- Normalize whitespace in assertions
- Use `normalizeWhitespace()` in XmlAssertions

### List Matching Order Issues

**Problem**: List elements must be in exact order

**Solution**:
- Enable list mode with `<?XML_DIFF list?>`
- Use `...` to ignore items between matched elements
- Consider if order truly matters for your test case

### Error Messages Not Clear

**Problem**: XML validation errors are hard to understand

**Solution**:
- Use `verification error should be:` step
- Check full description from XMLUnit diff
- Extract specific error patterns with regex

## Migration from Legacy Code

When migrating from knowledge-base-j to avia-base:

1. Copy all XML extension classes to your project
2. Update package names from `io.rivendale.kbj.*` to your project's package
3. Update JFactoryConfig to register XmlExtension
4. Update JFactory specs to use XML traits
5. Adjust feature files to use new package references

## Example Migration

**Before** (knowledge-base-j):
```java
package io.rivendale.kbj.jfactory;
```

**After** (avia-base):
```java
package io.rivendale.avia.jfactory;
```

## Integration with Cucumber

Add step definitions for XML verification:

```java
@Then("file {string} should NOT be:")
public void fileShouldNotBe(String filePath, String expression) {
    assertionError = assertThrows(AssertionError.class,
            () -> expect(Path.of(workspaceRoot, filePath).toFile()).should(expression));
}

@And("verification error should be:")
public void verificationErrorShouldBe(String expression) {
    expect(assertionError).should(expression);
}
```

## References

- [XMLUnit Documentation](https://www.xmlunit.org/)
- [DAL Expression Syntax](dal-syntax.md)
- [JFactory Configuration](jfactory-config.md)
- [Complete Framework API](framework-api.md)
