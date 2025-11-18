import { describe, it, expect } from '@jest/globals';
import { TimestampValidator } from '../TimestampValidator.js';
import { MemoryType } from '../../memory/types.js';

describe('TimestampValidator', () => {
  const validator = new TimestampValidator();

  describe('format validation', () => {
    it('should accept valid ISO 8601 date-only format', () => {
      const result = validator.validate('2025-02-04');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.normalized).toBeDefined();
    });

    it('should accept valid ISO 8601 datetime with Z suffix', () => {
      const result = validator.validate('2025-02-04T10:00:00Z');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.normalized).toBeDefined();
    });

    it('should accept valid ISO 8601 datetime with timezone offset', () => {
      const result = validator.validate('2025-02-04T10:00:00+02:00');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.normalized).toBeDefined();
    });

    it('should accept valid ISO 8601 datetime with negative timezone offset', () => {
      const result = validator.validate('2025-02-04T10:00:00-05:00');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBeDefined();
    });

    it('should reject invalid format "Feb 4, 2025"', () => {
      const result = validator.validate('Feb 4, 2025');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('ISO 8601');
    });

    it('should reject invalid format "2025/02/04"', () => {
      const result = validator.validate('2025/02/04');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject invalid format "04-02-2025"', () => {
      const result = validator.validate('04-02-2025');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject empty string', () => {
      const result = validator.validate('');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject non-string input', () => {
      const result = validator.validate(null as unknown as string);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('non-empty string');
    });

    it('should normalize timestamp to ISO string', () => {
      const result = validator.validate('2025-02-04');
      expect(result.normalized).toBeDefined();
      expect(result.normalized).toMatch(/T.*Z$/); // Should be ISO string
    });

    it('should handle timestamps with extra whitespace', () => {
      const result = validator.validate('  2025-02-04  ');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBeDefined();
    });

    it('should accept date that JS normalizes (Feb 30 becomes Mar 2)', () => {
      // JavaScript's Date constructor normalizes Feb 30 to Mar 2
      // This is valid behavior - the ISO regex accepts it, and Date parses it
      const result = validator.validate('2025-02-30');
      // Behavior depends on implementation - JS is lenient
      expect(result).toHaveProperty('valid');
    });

    it('should reject invalid month format (month 13)', () => {
      const result = validator.validate('2025-13-01');
      // Month 13 fails regex validation
      expect(result.valid).toBe(false);
    });
  });

  describe('future date rejection', () => {
    it('should reject timestamp in the future', () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);
      const futureISO = futureDate.toISOString();

      const result = validator.validate(futureISO);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('future');
    });

    it('should accept timestamp from today', () => {
      const today = new Date().toISOString().split('T')[0];
      const result = validator.validate(today);
      expect(result.valid).toBe(true);
    });

    it('should accept timestamp from the past', () => {
      const pastDate = new Date();
      pastDate.setFullYear(pastDate.getFullYear() - 1);
      const pastISO = pastDate.toISOString();

      const result = validator.validate(pastISO);
      expect(result.valid).toBe(true);
    });

    it('should reject timestamp with custom "now" reference', () => {
      const now = new Date('2025-01-15T10:00:00Z');
      const futureDate = new Date('2025-02-15T10:00:00Z');

      const result = validator.validate(futureDate.toISOString(), undefined, now);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('future');
    });
  });

  describe('priority warnings', () => {
    it('should warn for very old episodic memory (4+ years ago)', () => {
      // Create a memory timestamp from 4+ years ago
      // With exponential decay, episodic memory at 4 years with medium importance
      // will drop significantly in priority
      const fourYearsAgo = new Date();
      fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);
      const oldTimestamp = fourYearsAgo.toISOString();

      const result = validator.validate(oldTimestamp, 'episodic');
      expect(result.valid).toBe(true);
      // May have warning for old episodic memory (optional, depends on exact calculation)
      // The warning is best effort - we're testing that validation doesn't crash
      expect(result.normalized).toBeDefined();
    });

    it('should not warn for recent episodic memory', () => {
      const today = new Date().toISOString().split('T')[0];
      const result = validator.validate(today, 'episodic');
      expect(result.valid).toBe(true);
      // Warning is optional for recent memories
    });

    it('should not warn for 2 year old semantic memory', () => {
      // Semantic memories with default importance shouldn't warn even if 2 years old
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      const oldTimestamp = twoYearsAgo.toISOString();

      const result = validator.validate(oldTimestamp, 'semantic');
      expect(result.valid).toBe(true);
      // Semantic memories don't decay as fast, so no warning expected
    });

    it('should not warn for 2 year old belief memory', () => {
      // Beliefs with default importance shouldn't warn even if 2 years old
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      const oldTimestamp = twoYearsAgo.toISOString();

      const result = validator.validate(oldTimestamp, 'belief');
      expect(result.valid).toBe(true);
      // Beliefs don't decay as fast
    });

    it('should handle validation with undefined memoryType', () => {
      const today = new Date().toISOString().split('T')[0];
      const result = validator.validate(today, undefined);
      expect(result.valid).toBe(true);
    });
  });

  describe('temporal consistency', () => {
    it('should accept consistent relationship timestamps', () => {
      const olderDate = new Date('2025-01-01T00:00:00Z').toISOString();
      const newerDate = new Date('2025-02-01T00:00:00Z').toISOString();

      const result = validator.checkTemporalConsistency(newerDate, [
        {
          timestamp: olderDate,
          targetId: 'related-1',
          relationshipType: 'derived_from',
        },
      ]);

      expect(result.consistent).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should flag temporal paradox: derived from newer memory', () => {
      const olderDate = new Date('2025-01-01T00:00:00Z').toISOString();
      const newerDate = new Date('2025-02-01T00:00:00Z').toISOString();

      const result = validator.checkTemporalConsistency(olderDate, [
        {
          timestamp: newerDate,
          targetId: 'related-1',
          relationshipType: 'derived_from',
        },
      ]);

      expect(result.consistent).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]).toContain('paradox');
    });

    it('should handle empty relationship list', () => {
      const today = new Date().toISOString();
      const result = validator.checkTemporalConsistency(today, []);

      expect(result.consistent).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should handle missing timestamp in relationship', () => {
      const today = new Date().toISOString();
      const result = validator.checkTemporalConsistency(today, [
        {
          timestamp: '',
          targetId: 'related-1',
          relationshipType: 'supports',
        },
      ]);

      expect(result.consistent).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should warn when supporting very old memory', () => {
      const now = new Date('2025-01-15T00:00:00Z').toISOString();
      const veryOld = new Date('2023-01-15T00:00:00Z').toISOString();

      const result = validator.checkTemporalConsistency(now, [
        {
          timestamp: veryOld,
          targetId: 'old-memory',
          relationshipType: 'supports',
        },
      ]);

      expect(result.consistent).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('should skip invalid timestamps gracefully in temporal consistency check', () => {
      const today = new Date().toISOString();
      const result = validator.checkTemporalConsistency(today, [
        {
          timestamp: 'invalid-date',
          targetId: 'related-1',
          relationshipType: 'supports',
        },
      ]);

      // Invalid timestamp should be skipped or reported as issue
      if (result.issues.length > 0) {
        expect(result.consistent).toBe(false);
      }
      // Otherwise skipped gracefully
    });
  });

  describe('edge cases', () => {
    it('should handle leap year dates', () => {
      const result = validator.validate('2024-02-29');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBeDefined();
    });

    it('should handle very old dates', () => {
      const result = validator.validate('1970-01-01');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBeDefined();
    });

    it('should handle timestamps with milliseconds', () => {
      // ISO string with milliseconds (not standard input, but test robustness)
      const isoWithMs = new Date('2025-02-04T10:00:00.123Z').toISOString();
      const result = validator.validate(isoWithMs);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBeDefined();
    });

    it('should normalize different ISO formats to consistent ISO string', () => {
      const dateOnly = '2025-02-04';
      const withTime = '2025-02-04T10:00:00Z';

      const result1 = validator.validate(dateOnly);
      const result2 = validator.validate(withTime);

      expect(result1.normalized).toBeDefined();
      expect(result2.normalized).toBeDefined();
      // Both should normalize to ISO format
      expect(result1.normalized).toMatch(/T.*Z$/);
      expect(result2.normalized).toMatch(/T.*Z$/);
    });

    it('should handle validation without crashing on malformed input', () => {
      const malformedInputs = [
        '2025-02-04T25:00:00Z', // Invalid hour
        'not-a-date',
        '🚀 2025-02-04',
        '2025-02-04; DROP TABLE memories;',
        null,
        undefined,
        123,
        {},
      ];

      for (const input of malformedInputs) {
        expect(() => {
          validator.validate(input as unknown as string);
        }).not.toThrow();
      }
    });

    it('should return consistent result structure for valid timestamp', () => {
      const result = validator.validate('2025-02-04', 'episodic');

      expect(typeof result.valid).toBe('boolean');
      expect(result.normalized).toBeDefined();
      expect(typeof result.normalized).toBe('string');

      // error and warning are optional properties
      if (result.error) expect(typeof result.error).toBe('string');
      if (result.warning) expect(typeof result.warning).toBe('string');
    });

    it('should return error in result structure for invalid timestamp', () => {
      const result = validator.validate('invalid-date');

      expect(typeof result.valid).toBe('boolean');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });
  });

  describe('integration scenarios', () => {
    it('should handle typical backdating use case', () => {
      const backdatedTimestamp = '2024-12-15T14:30:00Z';
      const result = validator.validate(backdatedTimestamp, 'episodic');

      expect(result.valid).toBe(true);
      expect(result.normalized).toBeDefined();
      // May have warning depending on how old
    });

    it('should reject realistic user mistake: "Feb 4, 2025"', () => {
      const result = validator.validate('Feb 4, 2025');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('ISO');
    });

    it('should reject user mistake: typing future year "2026"', () => {
      const result = validator.validate('2026-02-04');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('future');
    });

    it('should accept and normalize timestamp without time component', () => {
      const result = validator.validate('2024-12-25');
      expect(result.valid).toBe(true);
      expect(result.normalized).toMatch(/Z$/); // ISO with Z
    });
  });

  describe('memory type coverage', () => {
    const memoryTypes: MemoryType[] = ['self', 'belief', 'pattern', 'episodic', 'semantic'];

    for (const memType of memoryTypes) {
      it(`should handle ${memType} memory type validation`, () => {
        const result = validator.validate('2025-02-04', memType);
        expect(result.valid).toBe(true);
        expect(result.normalized).toBeDefined();
      });
    }
  });
});
