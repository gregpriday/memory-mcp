import { describe, it, expect } from '@jest/globals';
import { parseFilterExpression, FilterParserError } from '../FilterParser.js';

describe('parseFilterExpression', () => {
  describe('basic comparisons', () => {
    it('should parse @id equality with string literal', () => {
      const result = parseFilterExpression('@id = "abc"');
      expect(result.sql).toBe('id = $1');
      expect(result.params).toEqual(['abc']);
    });

    it('should parse @id equality with == operator (normalized to =)', () => {
      const result = parseFilterExpression('@id == "bar"');
      expect(result.sql).toBe('id = $1');
      expect(result.params).toEqual(['bar']);
    });

    it('should parse metadata field with number literal', () => {
      const result = parseFilterExpression('@metadata.importance = 2');
      expect(result.sql).toBe('importance = $1');
      expect(result.params).toEqual([2]);
    });

    it('should parse metadata field with negative number', () => {
      const result = parseFilterExpression('@metadata.importance = -1');
      expect(result.sql).toBe('importance = $1');
      expect(result.params).toEqual([-1]);
    });

    it('should parse metadata field with boolean literal', () => {
      const result = parseFilterExpression('@metadata.someFlag = true');
      expect(result.sql).toMatch(/metadata->>'someFlag' = \$1/);
      expect(result.params).toEqual(['true']);
    });

    it('should parse metadata field with false boolean', () => {
      const result = parseFilterExpression('@metadata.someFlag = false');
      expect(result.sql).toMatch(/metadata->>'someFlag' = \$1/);
      expect(result.params).toEqual(['false']);
    });
  });

  describe('whitespace handling', () => {
    it('should handle leading and trailing whitespace', () => {
      const result = parseFilterExpression('  @id = "foo"  ');
      expect(result.sql).toBe('id = $1');
      expect(result.params).toEqual(['foo']);
    });

    it('should handle multiple spaces between tokens', () => {
      const result = parseFilterExpression('@id    =    "foo"');
      expect(result.sql).toBe('id = $1');
      expect(result.params).toEqual(['foo']);
    });
  });

  describe('field handling', () => {
    it('should throw error for CONTAINS on @id', () => {
      expect(() => parseFilterExpression('@id CONTAINS "x"')).toThrow(
        /CONTAINS operator not supported for @id field/
      );
    });

    it('should throw error for root @metadata without field name', () => {
      expect(() => parseFilterExpression('@metadata = 1')).toThrow(
        /Root @metadata access not supported in comparisons/
      );
    });

    it('should throw error for invalid field', () => {
      expect(() => parseFilterExpression('@foo = 1')).toThrow(
        /Invalid field: @foo. Expected @id or @metadata/
      );
    });

    it('should throw error for empty field after @metadata.', () => {
      expect(() => parseFilterExpression('@metadata. = 1')).toThrow(/Invalid field: @metadata./);
    });
  });

  describe('logical operators AND / OR and grouping', () => {
    it('should parse AND expression', () => {
      const result = parseFilterExpression('@id = "a" AND @metadata.source = "user"');
      expect(result.sql).toBe('(id = $1 AND source = $2)');
      expect(result.params).toEqual(['a', 'user']);
    });

    it('should parse OR expression', () => {
      const result = parseFilterExpression('@id = "a" OR @id = "b"');
      expect(result.sql).toBe('(id = $1 OR id = $2)');
      expect(result.params).toEqual(['a', 'b']);
    });

    it('should parse nested expression with parentheses', () => {
      const result = parseFilterExpression('(@id = "a" OR @id = "b") AND @metadata.importance = 2');
      expect(result.sql).toBe('((id = $1 OR id = $2) AND importance = $3)');
      expect(result.params).toEqual(['a', 'b', 2]);
    });

    it('should handle multiple AND operators', () => {
      const result = parseFilterExpression(
        '@id = "a" AND @metadata.source = "user" AND @metadata.kind = "raw"'
      );
      expect(result.sql).toBe('((id = $1 AND source = $2) AND kind = $3)');
      expect(result.params).toEqual(['a', 'user', 'raw']);
    });

    it('should handle multiple OR operators', () => {
      const result = parseFilterExpression('@id = "a" OR @id = "b" OR @id = "c"');
      expect(result.sql).toBe('((id = $1 OR id = $2) OR id = $3)');
      expect(result.params).toEqual(['a', 'b', 'c']);
    });
  });

  describe('denormalized metadata fields', () => {
    it('should map @metadata.topic to denormalized column', () => {
      const result = parseFilterExpression('@metadata.topic = "foo"');
      expect(result.sql).toBe('topic = $1');
      expect(result.params).toEqual(['foo']);
    });

    it('should map @metadata.source to denormalized column', () => {
      const result = parseFilterExpression('@metadata.source = "system"');
      expect(result.sql).toBe('source = $1');
      expect(result.params).toEqual(['system']);
    });

    it('should map @metadata.kind to denormalized column', () => {
      const result = parseFilterExpression('@metadata.kind = "raw"');
      expect(result.sql).toBe('kind = $1');
      expect(result.params).toEqual(['raw']);
    });

    it('should map @metadata.sourcePath to source_path column', () => {
      const result = parseFilterExpression('@metadata.sourcePath = "/path/to/file"');
      expect(result.sql).toBe('source_path = $1');
      expect(result.params).toEqual(['/path/to/file']);
    });

    it('should map @metadata.source_path to source_path column', () => {
      const result = parseFilterExpression('@metadata.source_path = "/path/to/file"');
      expect(result.sql).toBe('source_path = $1');
      expect(result.params).toEqual(['/path/to/file']);
    });

    it('should map @metadata.memoryType to memory_type column', () => {
      const result = parseFilterExpression('@metadata.memoryType = "episodic"');
      expect(result.sql).toBe('memory_type = $1');
      expect(result.params).toEqual(['episodic']);
    });

    it('should map @metadata.memory_type to memory_type column', () => {
      const result = parseFilterExpression('@metadata.memory_type = "semantic"');
      expect(result.sql).toBe('memory_type = $1');
      expect(result.params).toEqual(['semantic']);
    });

    describe('importance mapping', () => {
      it('should map importance "high" to 2', () => {
        const result = parseFilterExpression('@metadata.importance = "high"');
        expect(result.sql).toBe('importance = $1');
        expect(result.params).toEqual([2]);
      });

      it('should map importance "medium" to 1', () => {
        const result = parseFilterExpression('@metadata.importance = "medium"');
        expect(result.sql).toBe('importance = $1');
        expect(result.params).toEqual([1]);
      });

      it('should map importance "low" to 0', () => {
        const result = parseFilterExpression('@metadata.importance = "low"');
        expect(result.sql).toBe('importance = $1');
        expect(result.params).toEqual([0]);
      });

      it('should throw error for invalid importance value', () => {
        expect(() => parseFilterExpression('@metadata.importance = "urgent"')).toThrow(
          /Invalid importance value.*Expected 'low', 'medium', or 'high'/
        );
      });

      it('should handle uppercase importance value', () => {
        const result = parseFilterExpression('@metadata.importance = "HIGH"');
        expect(result.sql).toBe('importance = $1');
        expect(result.params).toEqual([2]);
      });

      it('should handle mixed-case importance value', () => {
        const result = parseFilterExpression('@metadata.importance = "Medium"');
        expect(result.sql).toBe('importance = $1');
        expect(result.params).toEqual([1]);
      });

      it('should throw error for CONTAINS on importance field', () => {
        expect(() => parseFilterExpression('@metadata.importance CONTAINS "high"')).toThrow(
          /CONTAINS operator only supported for array fields/
        );
      });
    });

    describe('tags array field', () => {
      it('should handle CONTAINS on tags array', () => {
        const result = parseFilterExpression('@metadata.tags CONTAINS "foo"');
        expect(result.sql).toBe('$1 = ANY(tags)');
        expect(result.params).toEqual(['foo']);
      });

      it('should throw error for equality on tags array', () => {
        expect(() => parseFilterExpression('@metadata.tags = "foo"')).toThrow(
          /Equality comparison not supported for array field tags. Use CONTAINS instead./
        );
      });

      it('should throw error for CONTAINS with non-string value on tags', () => {
        expect(() => parseFilterExpression('@metadata.tags CONTAINS 123')).toThrow(
          /Array CONTAINS requires string value/
        );
      });
    });
  });

  describe('JSONB custom fields', () => {
    it('should use JSONB access for custom field equality', () => {
      const result = parseFilterExpression('@metadata.customField = "foo"');
      expect(result.sql).toBe("metadata->>'customField' = $1");
      expect(result.params).toEqual(['foo']);
    });

    it('should convert number to string for JSONB equality', () => {
      const result = parseFilterExpression('@metadata.customField = 42');
      expect(result.sql).toBe("metadata->>'customField' = $1");
      expect(result.params).toEqual(['42']);
    });

    it('should convert boolean to string for JSONB equality', () => {
      const result = parseFilterExpression('@metadata.customBool = true');
      expect(result.sql).toBe("metadata->>'customBool' = $1");
      expect(result.params).toEqual(['true']);
    });

    it('should use JSONB containment for CONTAINS on custom field', () => {
      const result = parseFilterExpression('@metadata.customField CONTAINS "foo"');
      expect(result.sql).toMatch(/metadata->'customField' @> \$1::jsonb/);
      expect(result.params).toEqual(['["foo"]']);
    });

    it('should throw error for CONTAINS with non-string value on JSONB field', () => {
      expect(() => parseFilterExpression('@metadata.customField CONTAINS true')).toThrow(
        /JSONB array CONTAINS requires string value/
      );
    });

    it('should throw error for invalid JSONB key with special characters', () => {
      // The tokenizer will reject the '!' character before it reaches the translator
      expect(() => parseFilterExpression('@metadata.bad-key! = "foo"')).toThrow(
        /Unexpected character '!'/
      );
    });

    it('should accept valid JSONB key with hyphen', () => {
      const result = parseFilterExpression('@metadata.custom-field = "foo"');
      expect(result.sql).toBe("metadata->>'custom-field' = $1");
      expect(result.params).toEqual(['foo']);
    });

    it('should accept valid JSONB key with underscore', () => {
      const result = parseFilterExpression('@metadata.custom_field = "foo"');
      expect(result.sql).toBe("metadata->>'custom_field' = $1");
      expect(result.params).toEqual(['foo']);
    });

    it('should throw error for JSONB key with dots', () => {
      expect(() => parseFilterExpression('@metadata.foo.bar = "baz"')).toThrow(
        /Invalid JSONB field name.*Only alphanumeric, underscore, and hyphen allowed/
      );
    });

    it('should throw error for JSONB key starting with hyphen', () => {
      expect(() => parseFilterExpression('@metadata.-payload = "baz"')).toThrow(
        /Invalid JSONB field name.*Only alphanumeric, underscore, and hyphen allowed/
      );
    });
  });

  describe('tokenizer error conditions', () => {
    it('should throw error for unterminated string', () => {
      expect(() => parseFilterExpression('@id = "foo')).toThrow(/Unterminated string/);
    });

    it('should throw error for unexpected lowercase identifier', () => {
      expect(() => parseFilterExpression('@id = 1 and @id = 2')).toThrow(
        /Unexpected identifier 'and'/
      );
    });

    it('should throw error for unknown identifier', () => {
      expect(() => parseFilterExpression('@id = 1 UNKNOWN @id = 2')).toThrow(
        /Unexpected identifier 'UNKNOWN'/
      );
    });

    it('should throw error for missing literal value', () => {
      expect(() => parseFilterExpression('@id =')).toThrow(/Expected literal value/);
    });

    it('should throw error for unbalanced parentheses (missing closing)', () => {
      expect(() => parseFilterExpression('(@id = "a" OR @id = "b"')).toThrow(
        /Expected closing parenthesis/
      );
    });

    it('should throw error for unexpected character', () => {
      expect(() => parseFilterExpression('@id = "a" ???')).toThrow(/Unexpected character/);
    });

    it('should throw error for invalid number format', () => {
      expect(() => parseFilterExpression('@metadata.value = 1.2.3')).toThrow(
        /Invalid number format/
      );
    });

    it('should throw error for trailing garbage after valid expression', () => {
      expect(() => parseFilterExpression('@id = "a" foo')).toThrow(/Unexpected identifier 'foo'/);
    });

    it('should throw error for trailing characters after valid expression', () => {
      expect(() => parseFilterExpression('@id = "a")')).toThrow(/Expected end of input/);
    });
  });

  describe('parser error wrapping', () => {
    it('should throw FilterParserError directly (not wrapped)', () => {
      expect(() => parseFilterExpression('invalid')).toThrow(FilterParserError);
    });

    it('should throw FilterParserError with original message', () => {
      expect(() => parseFilterExpression('@id CONTAINS "x"')).toThrow(
        /CONTAINS operator not supported/
      );
      expect(() => parseFilterExpression('@id CONTAINS "x"')).toThrow(FilterParserError);
    });
  });

  describe('string escaping', () => {
    it('should handle escaped quotes in strings', () => {
      const result = parseFilterExpression('@id = "foo\\"bar"');
      expect(result.sql).toBe('id = $1');
      expect(result.params).toEqual(['foo"bar']);
    });

    it('should handle strings with spaces', () => {
      const result = parseFilterExpression('@metadata.topic = "hello world"');
      expect(result.sql).toBe('topic = $1');
      expect(result.params).toEqual(['hello world']);
    });
  });

  describe('complex nested expressions', () => {
    it('should parse complex nested AND/OR with parentheses', () => {
      const result = parseFilterExpression(
        '(@id = "a" OR @id = "b") AND (@metadata.source = "user" OR @metadata.source = "file")'
      );
      expect(result.sql).toBe('((id = $1 OR id = $2) AND (source = $3 OR source = $4))');
      expect(result.params).toEqual(['a', 'b', 'user', 'file']);
    });

    it('should parse deeply nested parentheses', () => {
      const result = parseFilterExpression('((@id = "a" OR @id = "b") AND @metadata.kind = "raw")');
      expect(result.sql).toBe('((id = $1 OR id = $2) AND kind = $3)');
      expect(result.params).toEqual(['a', 'b', 'raw']);
    });

    it('should maintain correct parameter order in complex expressions', () => {
      const result = parseFilterExpression(
        '@id = "first" AND @metadata.source = "second" AND @metadata.kind = "third"'
      );
      expect(result.params).toEqual(['first', 'second', 'third']);
    });
  });

  describe('edge cases', () => {
    it('should handle empty string literal', () => {
      const result = parseFilterExpression('@id = ""');
      expect(result.sql).toBe('id = $1');
      expect(result.params).toEqual(['']);
    });

    it('should handle zero as number', () => {
      const result = parseFilterExpression('@metadata.importance = 0');
      expect(result.sql).toBe('importance = $1');
      expect(result.params).toEqual([0]);
    });

    it('should handle negative zero', () => {
      const result = parseFilterExpression('@metadata.value = -0');
      expect(result.sql).toMatch(/metadata->>'value' = \$1/);
      // For JSONB fields, numbers are converted to strings
      expect(result.params).toEqual(['0']);
    });

    it('should handle decimal numbers', () => {
      const result = parseFilterExpression('@metadata.score = 3.14');
      expect(result.sql).toMatch(/metadata->>'score' = \$1/);
      expect(result.params).toEqual(['3.14']);
    });

    it('should handle negative decimal numbers', () => {
      const result = parseFilterExpression('@metadata.score = -3.14');
      expect(result.sql).toMatch(/metadata->>'score' = \$1/);
      expect(result.params).toEqual(['-3.14']);
    });
  });

  describe('operator precedence', () => {
    it('should bind AND tighter than OR without parentheses', () => {
      const result = parseFilterExpression('@id = "a" OR @id = "b" AND @metadata.kind = "raw"');
      // Should parse as: @id = "a" OR (@id = "b" AND @metadata.kind = "raw")
      expect(result.sql).toBe('(id = $1 OR (id = $2 AND kind = $3))');
      expect(result.params).toEqual(['a', 'b', 'raw']);
    });

    it('should handle multiple AND operations', () => {
      const result = parseFilterExpression('@id = "a" AND @id = "b" AND @id = "c"');
      expect(result.sql).toBe('((id = $1 AND id = $2) AND id = $3)');
      expect(result.params).toEqual(['a', 'b', 'c']);
    });
  });

  describe('SQL injection prevention', () => {
    it('should use parameter binding for potentially malicious strings', () => {
      const maliciousInput = "' OR 1=1; DROP TABLE memories;";
      const result = parseFilterExpression(`@metadata.customField = "${maliciousInput}"`);
      // Should use parameterized query, not embed the string directly
      expect(result.sql).toBe("metadata->>'customField' = $1");
      expect(result.params).toEqual([maliciousInput]);
      expect(result.sql).not.toContain('OR 1=1');
      expect(result.sql).not.toContain('DROP TABLE');
    });

    it('should sanitize JSONB keys to prevent injection', () => {
      // The sanitizer should reject keys with SQL-dangerous characters
      expect(() => parseFilterExpression('@metadata.foo.bar = "baz"')).toThrow(
        /Invalid JSONB field name/
      );
    });
  });

  describe('CONTAINS operator variations', () => {
    it('should throw error for CONTAINS on non-array denormalized field', () => {
      expect(() => parseFilterExpression('@metadata.topic CONTAINS "foo"')).toThrow(
        /CONTAINS operator only supported for array fields/
      );
    });

    it('should throw error for CONTAINS on source field', () => {
      expect(() => parseFilterExpression('@metadata.source CONTAINS "user"')).toThrow(
        /CONTAINS operator only supported for array fields/
      );
    });
  });

  describe('FilterParserError structure', () => {
    describe('tokenizer errors', () => {
      it('should throw FilterParserError for unterminated string with position and hint', () => {
        expect(() => parseFilterExpression('@id = "unterminated')).toThrow(FilterParserError);

        try {
          parseFilterExpression('@id = "unterminated');
        } catch (error) {
          expect(error).toBeInstanceOf(FilterParserError);
          const fpError = error as FilterParserError;
          expect(fpError.stage).toBe('tokenizer');
          expect(fpError.position).toBeGreaterThan(0);
          expect(fpError.snippet).toBeDefined();
          expect(fpError.hint).toContain('double quote');
        }
      });

      it('should throw FilterParserError for invalid number format', () => {
        expect(() => parseFilterExpression('@metadata.value = 1.2.3')).toThrow(FilterParserError);

        try {
          parseFilterExpression('@metadata.value = 1.2.3');
        } catch (error) {
          expect(error).toBeInstanceOf(FilterParserError);
          const fpError = error as FilterParserError;
          expect(fpError.stage).toBe('tokenizer');
          expect(fpError.snippet).toContain('1.2.3');
          expect(fpError.hint).toContain('decimal point');
        }
      });

      it('should throw FilterParserError for unexpected identifier', () => {
        expect(() => parseFilterExpression('@id = "test" INVALID @id = "test2"')).toThrow(
          FilterParserError
        );

        try {
          parseFilterExpression('@id = "test" INVALID @id = "test2"');
        } catch (error) {
          expect(error).toBeInstanceOf(FilterParserError);
          const fpError = error as FilterParserError;
          expect(fpError.stage).toBe('tokenizer');
          expect(fpError.snippet).toContain('INVALID');
          expect(fpError.hint).toContain('keyword');
        }
      });

      it('should throw FilterParserError for unexpected character', () => {
        expect(() => parseFilterExpression('@id $ "test"')).toThrow(FilterParserError);

        try {
          parseFilterExpression('@id $ "test"');
        } catch (error) {
          expect(error).toBeInstanceOf(FilterParserError);
          const fpError = error as FilterParserError;
          expect(fpError.stage).toBe('tokenizer');
          expect(fpError.snippet).toBe('$');
          expect(fpError.hint).toBeDefined();
        }
      });
    });

    describe('parser errors', () => {
      it('should throw FilterParserError for invalid field format', () => {
        expect(() => parseFilterExpression('@invalid = "test"')).toThrow(FilterParserError);

        try {
          parseFilterExpression('@invalid = "test"');
        } catch (error) {
          expect(error).toBeInstanceOf(FilterParserError);
          const fpError = error as FilterParserError;
          expect(fpError.stage).toBe('parser');
          expect(fpError.snippet).toContain('@invalid');
          expect(fpError.hint).toContain('id');
          expect(fpError.hint).toContain('metadata');
        }
      });

      it('should throw FilterParserError for empty field after @metadata.', () => {
        expect(() => parseFilterExpression('@metadata. = "test"')).toThrow(FilterParserError);

        try {
          parseFilterExpression('@metadata. = "test"');
        } catch (error) {
          expect(error).toBeInstanceOf(FilterParserError);
          const fpError = error as FilterParserError;
          expect(fpError.stage).toBe('parser');
          expect(fpError.hint).toContain('fieldName');
        }
      });
    });

    describe('translator errors', () => {
      it('should throw FilterParserError for CONTAINS on @id field', () => {
        expect(() => parseFilterExpression('@id CONTAINS "test"')).toThrow(FilterParserError);

        try {
          parseFilterExpression('@id CONTAINS "test"');
        } catch (error) {
          expect(error).toBeInstanceOf(FilterParserError);
          const fpError = error as FilterParserError;
          expect(fpError.stage).toBe('translator');
          expect(fpError.snippet).toContain('@id CONTAINS');
          expect(fpError.hint).toContain('exact ID matching');
        }
      });

      it('should throw FilterParserError for root @metadata access', () => {
        expect(() => parseFilterExpression('@metadata = "test"')).toThrow(FilterParserError);

        try {
          parseFilterExpression('@metadata = "test"');
        } catch (error) {
          expect(error).toBeInstanceOf(FilterParserError);
          const fpError = error as FilterParserError;
          expect(fpError.stage).toBe('translator');
          expect(fpError.snippet).toBe('@metadata');
          expect(fpError.hint).toContain('fieldName');
        }
      });

      it('should throw FilterParserError for invalid importance value', () => {
        expect(() => parseFilterExpression('@metadata.importance = "invalid"')).toThrow(
          FilterParserError
        );

        try {
          parseFilterExpression('@metadata.importance = "invalid"');
        } catch (error) {
          expect(error).toBeInstanceOf(FilterParserError);
          const fpError = error as FilterParserError;
          expect(fpError.stage).toBe('translator');
          expect(fpError.snippet).toContain('invalid');
          expect(fpError.hint).toContain('low');
          expect(fpError.hint).toContain('medium');
          expect(fpError.hint).toContain('high');
        }
      });

      it('should throw FilterParserError for array CONTAINS with non-string value', () => {
        expect(() => parseFilterExpression('@metadata.tags CONTAINS 123')).toThrow(
          FilterParserError
        );

        try {
          parseFilterExpression('@metadata.tags CONTAINS 123');
        } catch (error) {
          expect(error).toBeInstanceOf(FilterParserError);
          const fpError = error as FilterParserError;
          expect(fpError.stage).toBe('translator');
          expect(fpError.hint).toContain('string value');
        }
      });

      it('should throw FilterParserError for equality on array field', () => {
        expect(() => parseFilterExpression('@metadata.tags = "test"')).toThrow(FilterParserError);

        try {
          parseFilterExpression('@metadata.tags = "test"');
        } catch (error) {
          expect(error).toBeInstanceOf(FilterParserError);
          const fpError = error as FilterParserError;
          expect(fpError.stage).toBe('translator');
          expect(fpError.hint).toContain('CONTAINS');
        }
      });

      it('should throw FilterParserError for CONTAINS on non-array field', () => {
        expect(() => parseFilterExpression('@metadata.topic CONTAINS "test"')).toThrow(
          FilterParserError
        );

        try {
          parseFilterExpression('@metadata.topic CONTAINS "test"');
        } catch (error) {
          expect(error).toBeInstanceOf(FilterParserError);
          const fpError = error as FilterParserError;
          expect(fpError.stage).toBe('translator');
          expect(fpError.hint).toContain('exact matching');
        }
      });

      it('should throw FilterParserError for invalid JSONB field name', () => {
        // Use a field name with invalid characters that passes tokenizer/parser but fails in translator
        expect(() => parseFilterExpression('@metadata.-invalidfield = "test"')).toThrow(
          FilterParserError
        );

        try {
          parseFilterExpression('@metadata.-invalidfield = "test"');
        } catch (error) {
          expect(error).toBeInstanceOf(FilterParserError);
          const fpError = error as FilterParserError;
          expect(fpError.stage).toBe('translator');
          expect(fpError.snippet).toContain('@metadata.-invalidfield');
          expect(fpError.hint).toContain('alphanumeric');
        }
      });
    });
  });
});
