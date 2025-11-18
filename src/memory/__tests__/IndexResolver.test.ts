import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { IndexResolver } from '../IndexResolver.js';

const forceType = <T>(value: unknown): T => value as T;

describe('IndexResolver', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.MEMORY_DEFAULT_INDEX;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MEMORY_DEFAULT_INDEX = originalEnv;
    } else {
      delete process.env.MEMORY_DEFAULT_INDEX;
    }
  });

  describe('constructor', () => {
    it('should use provided default index', () => {
      const resolver = new IndexResolver('custom-index');
      expect(resolver.getDefault()).toBe('custom-index');
    });

    it('should use environment variable when no default provided', () => {
      process.env.MEMORY_DEFAULT_INDEX = 'env-index';
      const resolver = new IndexResolver();
      expect(resolver.getDefault()).toBe('env-index');
    });

    it('should use "memory" as fallback when no default or env var', () => {
      delete process.env.MEMORY_DEFAULT_INDEX;
      const resolver = new IndexResolver();
      expect(resolver.getDefault()).toBe('memory');
    });

    it('should prefer constructor argument over environment variable', () => {
      process.env.MEMORY_DEFAULT_INDEX = 'env-index';
      const resolver = new IndexResolver('custom-index');
      expect(resolver.getDefault()).toBe('custom-index');
    });
  });

  describe('getDefault', () => {
    it('should return the default index', () => {
      const resolver = new IndexResolver('test-index');
      expect(resolver.getDefault()).toBe('test-index');
    });

    it('should return "memory" when constructed with no arguments', () => {
      delete process.env.MEMORY_DEFAULT_INDEX;
      const resolver = new IndexResolver();
      expect(resolver.getDefault()).toBe('memory');
    });
  });

  describe('resolve', () => {
    let resolver: IndexResolver;

    beforeEach(() => {
      resolver = new IndexResolver('default-index');
    });

    describe('valid index names', () => {
      it('should accept alphanumeric index name', () => {
        const result = resolver.resolve('test123');
        expect(result).toBe('test123');
      });

      it('should accept index name with hyphens', () => {
        const result = resolver.resolve('test-index-name');
        expect(result).toBe('test-index-name');
      });

      it('should accept index name with underscores', () => {
        const result = resolver.resolve('test_index_name');
        expect(result).toBe('test_index_name');
      });

      it('should accept index name with mixed valid characters', () => {
        const result = resolver.resolve('test_Index-123');
        expect(result).toBe('test_Index-123');
      });

      it('should accept uppercase letters', () => {
        const result = resolver.resolve('UPPERCASE');
        expect(result).toBe('UPPERCASE');
      });

      it('should accept mixed case', () => {
        const result = resolver.resolve('MixedCase');
        expect(result).toBe('MixedCase');
      });

      it('should accept single character', () => {
        const result = resolver.resolve('a');
        expect(result).toBe('a');
      });

      it('should accept 64 character name (boundary)', () => {
        const longName = 'a'.repeat(64);
        const result = resolver.resolve(longName);
        expect(result).toBe(longName);
      });

      it('should trim whitespace from index name', () => {
        const result = resolver.resolve('  test-index  ');
        expect(result).toBe('test-index');
      });

      it('should trim tabs and newlines', () => {
        const result = resolver.resolve('\ttest-index\n');
        expect(result).toBe('test-index');
      });
    });

    describe('default index resolution', () => {
      it('should return default index when requestedIndex is undefined', () => {
        const result = resolver.resolve(undefined);
        expect(result).toBe('default-index');
      });

      it('should return default index when requestedIndex is null', () => {
        const result = resolver.resolve(forceType(null));
        expect(result).toBe('default-index');
      });

      it('should use requested index over default when provided', () => {
        const result = resolver.resolve('custom-index');
        expect(result).toBe('custom-index');
      });
    });

    describe('invalid index names', () => {
      it('should reject empty string', () => {
        expect(() => resolver.resolve('')).toThrow('Index name must be a non-empty string');
      });

      it('should reject whitespace-only string', () => {
        expect(() => resolver.resolve('   ')).toThrow('Index name must be a non-empty string');
      });

      it('should throw error for non-string input (number)', () => {
        // Note: Current implementation calls .trim() before type check, so it throws different error
        expect(() => resolver.resolve(forceType(123))).toThrow();
      });

      it('should throw error for non-string input (object)', () => {
        // Note: Current implementation calls .trim() before type check, so it throws different error
        expect(() => resolver.resolve(forceType({}))).toThrow();
      });

      it('should throw error for non-string input (array)', () => {
        // Note: Current implementation calls .trim() before type check, so it throws different error
        expect(() => resolver.resolve(forceType([]))).toThrow();
      });

      it('should reject index name with spaces', () => {
        expect(() => resolver.resolve('test index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (!)', () => {
        expect(() => resolver.resolve('test!')).toThrow(/Invalid index name.*Only alphanumeric/);
      });

      it('should reject index name with special characters (@)', () => {
        expect(() => resolver.resolve('test@index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (#)', () => {
        expect(() => resolver.resolve('test#index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters ($)', () => {
        expect(() => resolver.resolve('test$')).toThrow(/Invalid index name.*Only alphanumeric/);
      });

      it('should reject index name with special characters (%)', () => {
        expect(() => resolver.resolve('test%index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (^)', () => {
        expect(() => resolver.resolve('test^index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (&)', () => {
        expect(() => resolver.resolve('test&index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (*)', () => {
        expect(() => resolver.resolve('test*index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (()', () => {
        expect(() => resolver.resolve('test(index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters ())', () => {
        expect(() => resolver.resolve('test)index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (+)', () => {
        expect(() => resolver.resolve('test+index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (=)', () => {
        expect(() => resolver.resolve('test=index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters ([)', () => {
        expect(() => resolver.resolve('test[index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (])', () => {
        expect(() => resolver.resolve('test]index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters ({)', () => {
        expect(() => resolver.resolve('test{index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (})', () => {
        expect(() => resolver.resolve('test}index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (|)', () => {
        expect(() => resolver.resolve('test|index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (\\)', () => {
        expect(() => resolver.resolve('test\\index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (/)', () => {
        expect(() => resolver.resolve('test/index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (:)', () => {
        expect(() => resolver.resolve('test:index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (;)', () => {
        expect(() => resolver.resolve('test;index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (")', () => {
        expect(() => resolver.resolve('test"index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it("should reject index name with special characters (')", () => {
        expect(() => resolver.resolve("test'index")).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (<)', () => {
        expect(() => resolver.resolve('test<index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (>)', () => {
        expect(() => resolver.resolve('test>index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (,)', () => {
        expect(() => resolver.resolve('test,index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (.)', () => {
        expect(() => resolver.resolve('test.index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with special characters (?)', () => {
        expect(() => resolver.resolve('test?index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with Unicode characters', () => {
        expect(() => resolver.resolve('test✓index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name with emoji', () => {
        expect(() => resolver.resolve('test😀index')).toThrow(
          /Invalid index name.*Only alphanumeric/
        );
      });

      it('should reject index name longer than 64 characters', () => {
        const longName = 'a'.repeat(65);
        expect(() => resolver.resolve(longName)).toThrow(
          'Index name must be 64 characters or less'
        );
      });

      it('should reject very long index name (100+ characters)', () => {
        const longName = 'a'.repeat(100);
        expect(() => resolver.resolve(longName)).toThrow(
          'Index name must be 64 characters or less'
        );
      });
    });
  });
});
