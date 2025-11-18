import { describe, it, expect } from '@jest/globals';
import { MetadataValidator, ValidationError } from '../MetadataValidator.js';
import { MemoryMetadata } from '../../memory/types.js';

describe('MetadataValidator', () => {
  describe('ValidationError', () => {
    it('should have correct name and message', () => {
      const error = new ValidationError('test message');
      expect(error.name).toBe('ValidationError');
      expect(error.message).toBe('test message');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('valid metadata', () => {
    it('should accept fully valid metadata without throwing', () => {
      const validMetadata: Partial<MemoryMetadata> = {
        index: 'test-index',
        memoryType: 'semantic',
        importance: 'medium',
        source: 'user',
        kind: 'summary',
        tags: ['tag1', 'tag2'],
        date: '2024-01-02',
        relatedIds: ['id1', 'id2'],
        derivedFromIds: ['id3'],
        dynamics: {
          stability: 'canonical',
          initialPriority: 0.5,
          currentPriority: 0.6,
          accessCount: 10,
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
        relationships: [
          {
            targetId: 'target-1',
            type: 'supports',
            weight: 0.8,
          },
        ],
        emotion: {
          label: 'joy',
          intensity: 0.5,
        },
      };

      expect(() => MetadataValidator.validate(validMetadata)).not.toThrow();
    });

    it('should accept metadata with only some fields present', () => {
      const metadata: Partial<MemoryMetadata> = {
        index: 'test',
        importance: 'high',
      };

      expect(() => MetadataValidator.validate(metadata)).not.toThrow();
    });

    it('should accept empty metadata object', () => {
      expect(() => MetadataValidator.validate({})).not.toThrow();
    });
  });

  describe('invalid enum fields', () => {
    it('should reject invalid memoryType', () => {
      const metadata: Partial<MemoryMetadata> = {
        memoryType: 'unknown' as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /Invalid memoryType.*Must be one of: self, belief, pattern, episodic, semantic/
      );
    });

    it('should reject invalid importance', () => {
      const metadata: Partial<MemoryMetadata> = {
        importance: 'urgent' as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /Invalid importance.*Must be one of: low, medium, high/
      );
    });

    it('should reject invalid source', () => {
      const metadata: Partial<MemoryMetadata> = {
        source: 'api' as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /Invalid source.*Must be one of: user, file, system/
      );
    });

    it('should reject invalid kind', () => {
      const metadata: Partial<MemoryMetadata> = {
        kind: 'other' as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /Invalid kind.*Must be one of: raw, summary, derived/
      );
    });
  });

  describe('dynamics validation', () => {
    it('should reject non-object dynamics', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: 'not-an-object' as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(/dynamics must be an object/);
    });

    it('should reject null dynamics', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: null as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(/dynamics must be an object/);
    });

    it('should reject invalid stability value', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: {
          stability: 'invalid' as any,
          initialPriority: 0.5,
          currentPriority: 0.5,
          accessCount: 0,
          createdAt: new Date().toISOString(),
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /Invalid dynamics.stability.*Must be one of: tentative, stable, canonical/
      );
    });

    it('should reject non-number initialPriority', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: {
          initialPriority: 'not-a-number' as any,
          currentPriority: 0.5,
          accessCount: 0,
          createdAt: new Date().toISOString(),
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /dynamics.initialPriority must be a number between 0.0 and 1.0/
      );
    });

    it('should reject initialPriority < 0', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: {
          initialPriority: -0.1,
          currentPriority: 0.5,
          accessCount: 0,
          createdAt: new Date().toISOString(),
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /dynamics.initialPriority must be a number between 0.0 and 1.0/
      );
    });

    it('should reject initialPriority > 1', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: {
          initialPriority: 1.5,
          currentPriority: 0.5,
          accessCount: 0,
          createdAt: new Date().toISOString(),
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /dynamics.initialPriority must be a number between 0.0 and 1.0/
      );
    });

    it('should reject non-number currentPriority', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: {
          initialPriority: 0.5,
          currentPriority: 'invalid' as any,
          accessCount: 0,
          createdAt: new Date().toISOString(),
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /dynamics.currentPriority must be a number between 0.0 and 1.0/
      );
    });

    it('should reject currentPriority < 0', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: {
          initialPriority: 0.5,
          currentPriority: -0.5,
          accessCount: 0,
          createdAt: new Date().toISOString(),
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /dynamics.currentPriority must be a number between 0.0 and 1.0/
      );
    });

    it('should reject currentPriority > 1', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: {
          initialPriority: 0.5,
          currentPriority: 2.0,
          accessCount: 0,
          createdAt: new Date().toISOString(),
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /dynamics.currentPriority must be a number between 0.0 and 1.0/
      );
    });

    it('should reject non-number accessCount', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: {
          initialPriority: 0.5,
          currentPriority: 0.5,
          accessCount: 'invalid' as any,
          createdAt: new Date().toISOString(),
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /dynamics.accessCount must be a non-negative integer/
      );
    });

    it('should reject negative accessCount', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: {
          initialPriority: 0.5,
          currentPriority: 0.5,
          accessCount: -5,
          createdAt: new Date().toISOString(),
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /dynamics.accessCount must be a non-negative integer/
      );
    });

    it('should reject non-integer accessCount', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: {
          initialPriority: 0.5,
          currentPriority: 0.5,
          accessCount: 1.5,
          createdAt: new Date().toISOString(),
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /dynamics.accessCount must be a non-negative integer/
      );
    });

    it('should reject invalid createdAt timestamp', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: {
          initialPriority: 0.5,
          currentPriority: 0.5,
          accessCount: 0,
          createdAt: 'not-a-timestamp',
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /dynamics.createdAt must be a valid ISO 8601 timestamp/
      );
    });

    it('should reject invalid lastAccessedAt timestamp', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: {
          initialPriority: 0.5,
          currentPriority: 0.5,
          accessCount: 0,
          createdAt: new Date().toISOString(),
          lastAccessedAt: 'invalid-timestamp',
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /dynamics.lastAccessedAt must be a valid ISO 8601 timestamp/
      );
    });

    it('should accept valid ISO 8601 timestamps', () => {
      const metadata: Partial<MemoryMetadata> = {
        dynamics: {
          initialPriority: 0.5,
          currentPriority: 0.5,
          accessCount: 0,
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      };

      expect(() => MetadataValidator.validate(metadata)).not.toThrow();
    });
  });

  describe('relationships validation', () => {
    it('should reject non-array relationships', () => {
      const metadata: Partial<MemoryMetadata> = {
        relationships: 'not-an-array' as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(/relationships must be an array/);
    });

    it('should reject relationships element that is not an object', () => {
      const metadata: Partial<MemoryMetadata> = {
        relationships: ['not-an-object'] as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /relationships\[0\] must be an object/
      );
    });

    it('should reject relationships element that is null', () => {
      const metadata: Partial<MemoryMetadata> = {
        relationships: [null] as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /relationships\[0\] must be an object/
      );
    });

    it('should reject missing targetId', () => {
      const metadata: Partial<MemoryMetadata> = {
        relationships: [
          {
            type: 'supports',
          } as any,
        ],
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /relationships\[0\].targetId must be a string/
      );
    });

    it('should reject non-string targetId', () => {
      const metadata: Partial<MemoryMetadata> = {
        relationships: [
          {
            targetId: 123,
            type: 'supports',
          } as any,
        ],
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /relationships\[0\].targetId must be a string/
      );
    });

    it('should reject invalid relationship type', () => {
      const metadata: Partial<MemoryMetadata> = {
        relationships: [
          {
            targetId: 'target-1',
            type: 'invalid-type' as any,
          },
        ],
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /relationships\[0\].type must be one of:/
      );
    });

    it('should reject non-number weight', () => {
      const metadata: Partial<MemoryMetadata> = {
        relationships: [
          {
            targetId: 'target-1',
            type: 'supports',
            weight: 'not-a-number' as any,
          },
        ],
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /relationships\[0\].weight must be a number between 0.0 and 1.0/
      );
    });

    it('should reject weight < 0', () => {
      const metadata: Partial<MemoryMetadata> = {
        relationships: [
          {
            targetId: 'target-1',
            type: 'supports',
            weight: -0.1,
          },
        ],
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /relationships\[0\].weight must be a number between 0.0 and 1.0/
      );
    });

    it('should reject weight > 1', () => {
      const metadata: Partial<MemoryMetadata> = {
        relationships: [
          {
            targetId: 'target-1',
            type: 'supports',
            weight: 1.5,
          },
        ],
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /relationships\[0\].weight must be a number between 0.0 and 1.0/
      );
    });

    it('should accept valid relationships without weight', () => {
      const metadata: Partial<MemoryMetadata> = {
        relationships: [
          {
            targetId: 'target-1',
            type: 'supports',
          },
        ],
      };

      expect(() => MetadataValidator.validate(metadata)).not.toThrow();
    });

    it('should accept weight = 0 (lower boundary)', () => {
      const metadata: Partial<MemoryMetadata> = {
        relationships: [
          {
            targetId: 'target-1',
            type: 'supports',
            weight: 0,
          },
        ],
      };

      expect(() => MetadataValidator.validate(metadata)).not.toThrow();
    });

    it('should accept weight = 1 (upper boundary)', () => {
      const metadata: Partial<MemoryMetadata> = {
        relationships: [
          {
            targetId: 'target-1',
            type: 'supports',
            weight: 1,
          },
        ],
      };

      expect(() => MetadataValidator.validate(metadata)).not.toThrow();
    });

    it('should validate all relationship types', () => {
      const validTypes: Array<string> = [
        'summarizes',
        'example_of',
        'is_generalization_of',
        'supports',
        'contradicts',
        'causes',
        'similar_to',
        'historical_version_of',
        'derived_from',
      ];

      validTypes.forEach((type) => {
        const metadata: Partial<MemoryMetadata> = {
          relationships: [
            {
              targetId: 'target-1',
              type: type as any,
            },
          ],
        };

        expect(() => MetadataValidator.validate(metadata)).not.toThrow();
      });
    });
  });

  describe('emotion validation', () => {
    it('should reject non-object emotion', () => {
      const metadata: Partial<MemoryMetadata> = {
        emotion: 'not-an-object' as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(/emotion must be an object/);
    });

    it('should reject null emotion', () => {
      const metadata: Partial<MemoryMetadata> = {
        emotion: null as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(/emotion must be an object/);
    });

    it('should reject non-string emotion label', () => {
      const metadata: Partial<MemoryMetadata> = {
        emotion: {
          label: 123 as any,
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(/emotion.label must be a string/);
    });

    it('should accept emotion with valid label', () => {
      const metadata: Partial<MemoryMetadata> = {
        emotion: {
          label: 'joy',
        },
      };

      expect(() => MetadataValidator.validate(metadata)).not.toThrow();
    });

    it('should reject non-number emotion intensity', () => {
      const metadata: Partial<MemoryMetadata> = {
        emotion: {
          intensity: 'not-a-number' as any,
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /emotion.intensity must be a number between 0.0 and 1.0/
      );
    });

    it('should reject emotion intensity < 0', () => {
      const metadata: Partial<MemoryMetadata> = {
        emotion: {
          intensity: -0.5,
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /emotion.intensity must be a number between 0.0 and 1.0/
      );
    });

    it('should reject emotion intensity > 1', () => {
      const metadata: Partial<MemoryMetadata> = {
        emotion: {
          intensity: 1.5,
        },
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /emotion.intensity must be a number between 0.0 and 1.0/
      );
    });

    it('should accept valid emotion with intensity', () => {
      const metadata: Partial<MemoryMetadata> = {
        emotion: {
          label: 'joy',
          intensity: 0.7,
        },
      };

      expect(() => MetadataValidator.validate(metadata)).not.toThrow();
    });
  });

  describe('array and date fields', () => {
    it('should reject non-array tags', () => {
      const metadata: Partial<MemoryMetadata> = {
        tags: 'not-an-array' as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(/tags must be an array/);
    });

    it('should reject tags with non-string elements', () => {
      const metadata: Partial<MemoryMetadata> = {
        tags: ['valid', 123, 'another'] as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(/all tags must be strings/);
    });

    it('should accept valid tags array', () => {
      const metadata: Partial<MemoryMetadata> = {
        tags: ['tag1', 'tag2', 'tag3'],
      };

      expect(() => MetadataValidator.validate(metadata)).not.toThrow();
    });

    it('should reject non-string date', () => {
      const metadata: Partial<MemoryMetadata> = {
        date: 123 as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /date must be in YYYY-MM-DD format/
      );
    });

    it('should reject invalid date format', () => {
      const metadata: Partial<MemoryMetadata> = {
        date: '20240101',
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /date must be in YYYY-MM-DD format/
      );
    });

    it('should reject invalid date values', () => {
      const metadata: Partial<MemoryMetadata> = {
        date: '2024-13-40',
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /date must be in YYYY-MM-DD format/
      );
    });

    it('should reject date overflow (February 31)', () => {
      const metadata: Partial<MemoryMetadata> = {
        date: '2024-02-31',
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /date must be in YYYY-MM-DD format/
      );
    });

    it('should reject date overflow (April 31)', () => {
      const metadata: Partial<MemoryMetadata> = {
        date: '2023-04-31',
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /date must be in YYYY-MM-DD format/
      );
    });

    it('should accept valid date format', () => {
      const metadata: Partial<MemoryMetadata> = {
        date: '2024-01-15',
      };

      expect(() => MetadataValidator.validate(metadata)).not.toThrow();
    });

    it('should reject non-array relatedIds', () => {
      const metadata: Partial<MemoryMetadata> = {
        relatedIds: 'not-an-array' as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(/relatedIds must be an array/);
    });

    it('should reject relatedIds with non-string elements', () => {
      const metadata: Partial<MemoryMetadata> = {
        relatedIds: ['id1', 123, 'id3'] as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(/all relatedIds must be strings/);
    });

    it('should accept valid relatedIds array', () => {
      const metadata: Partial<MemoryMetadata> = {
        relatedIds: ['id1', 'id2', 'id3'],
      };

      expect(() => MetadataValidator.validate(metadata)).not.toThrow();
    });

    it('should reject non-array derivedFromIds', () => {
      const metadata: Partial<MemoryMetadata> = {
        derivedFromIds: 'not-an-array' as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(/derivedFromIds must be an array/);
    });

    it('should reject derivedFromIds with non-string elements', () => {
      const metadata: Partial<MemoryMetadata> = {
        derivedFromIds: ['id1', false, 'id3'] as any,
      };

      expect(() => MetadataValidator.validate(metadata)).toThrow(ValidationError);
      expect(() => MetadataValidator.validate(metadata)).toThrow(
        /all derivedFromIds must be strings/
      );
    });

    it('should accept valid derivedFromIds array', () => {
      const metadata: Partial<MemoryMetadata> = {
        derivedFromIds: ['id1', 'id2'],
      };

      expect(() => MetadataValidator.validate(metadata)).not.toThrow();
    });
  });
});
