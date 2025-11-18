import { describe, it, expect } from '@jest/globals';
import {
  getRecencyScore,
  getUsageScore,
  getImportanceScore,
  getEmotionScore,
  computeTypeDependentPriority,
} from '../PriorityCalculator.js';
import { MemoryRecord, Importance } from '../types.js';

/**
 * Helper to create a minimal MemoryRecord for testing
 */
function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'm1',
    content: {
      text: 'Test memory',
      timestamp: new Date().toISOString(),
    },
    metadata: {
      index: 'test',
    },
    ...overrides,
  };
}

describe('getRecencyScore', () => {
  it('should return ~1.0 for memory created now', () => {
    const now = new Date();
    const memory = makeMemory({
      content: {
        text: 'Test',
        timestamp: now.toISOString(),
      },
    });

    const score = getRecencyScore(memory, now);
    expect(score).toBeCloseTo(1.0, 6);
  });

  it('should return ~0.5 for memory created 30 days ago (half-life)', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const memory = makeMemory({
      content: {
        text: 'Test',
        timestamp: thirtyDaysAgo.toISOString(),
      },
    });

    const score = getRecencyScore(memory, now);
    const expected = Math.exp((-Math.log(2) * 30) / 30); // 2^(-30/30) = 0.5
    expect(score).toBeCloseTo(expected, 3);
    expect(score).toBeCloseTo(0.5, 3);
  });

  it('should return small positive score for very old memory (365 days)', () => {
    const now = new Date();
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    const memory = makeMemory({
      content: {
        text: 'Test',
        timestamp: oneYearAgo.toISOString(),
      },
    });

    const score = getRecencyScore(memory, now);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.1);
  });

  it('should treat future timestamps as current (ageDays clamped to 0)', () => {
    const now = new Date();
    const future = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
    const memory = makeMemory({
      content: {
        text: 'Test',
        timestamp: future.toISOString(),
      },
    });

    const score = getRecencyScore(memory, now);
    expect(score).toBeCloseTo(1.0, 6);
  });

  it('should return 0 for invalid timestamps', () => {
    const now = new Date();
    const memory = makeMemory({
      content: {
        text: 'Test',
        timestamp: 'not-a-date',
      },
    });

    const score = getRecencyScore(memory, now);
    expect(score).toBe(0);
  });

  it('should return 0 when now is invalid', () => {
    const memory = makeMemory({
      content: {
        text: 'Test',
        timestamp: new Date().toISOString(),
      },
    });

    const score = getRecencyScore(memory, new Date('invalid'));
    expect(score).toBe(0);
  });

  it('should use dynamics.valid_at when present instead of content.timestamp', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

    const memory = makeMemory({
      content: {
        text: 'Test',
        timestamp: thirtyDaysAgo.toISOString(), // Created 30 days ago
      },
      metadata: {
        index: 'test',
        dynamics: {
          valid_at: tenDaysAgo.toISOString(), // But valid 10 days ago (narrative time)
          initialPriority: 0.5,
          currentPriority: 0.5,
          createdAt: thirtyDaysAgo.toISOString(),
          accessCount: 5,
        },
      },
    });

    const score = getRecencyScore(memory, now);
    // Should be based on 10-day decay (from valid_at), not 30-day (from content.timestamp)
    const expectedForTenDays = Math.exp((-Math.log(2) * 10) / 30);
    expect(score).toBeCloseTo(expectedForTenDays, 3);
  });

  it('should fall back to content.timestamp when valid_at is invalid', () => {
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

    const memory = makeMemory({
      content: {
        text: 'Test',
        timestamp: tenDaysAgo.toISOString(), // Valid timestamp
      },
      metadata: {
        index: 'test',
        dynamics: {
          valid_at: 'invalid-timestamp', // Invalid
          initialPriority: 0.5,
          currentPriority: 0.5,
          createdAt: tenDaysAgo.toISOString(),
          accessCount: 0,
        },
      },
    });

    const score = getRecencyScore(memory, now);
    // Should use content.timestamp (10 days ago), not return 0
    const expectedForTenDays = Math.exp((-Math.log(2) * 10) / 30);
    expect(score).toBeCloseTo(expectedForTenDays, 3);
    expect(score).toBeGreaterThan(0);
  });
});

describe('getUsageScore', () => {
  it('should return 0 when no metadata present', () => {
    const memory = makeMemory({ metadata: undefined });
    expect(getUsageScore(memory)).toBe(0);
  });

  it('should return 0 when no dynamics present', () => {
    const memory = makeMemory({
      metadata: { index: 'test' },
    });
    expect(getUsageScore(memory)).toBe(0);
  });

  it('should return 0 when accessCount is 0', () => {
    const memory = makeMemory({
      metadata: {
        index: 'test',
        dynamics: {
          accessCount: 0,
          initialPriority: 0.5,
          currentPriority: 0.5,
          createdAt: new Date().toISOString(),
        },
      },
    });
    expect(getUsageScore(memory)).toBe(0);
  });

  it('should return small positive score for accessCount = 1', () => {
    const memory = makeMemory({
      metadata: {
        index: 'test',
        dynamics: {
          accessCount: 1,
          initialPriority: 0.5,
          currentPriority: 0.5,
          createdAt: new Date().toISOString(),
        },
      },
    });
    const score = getUsageScore(memory);
    const expected = Math.log(2) / Math.log(101);
    expect(score).toBeCloseTo(expected, 6);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.2);
  });

  it('should return near 1.0 for accessCount = 100', () => {
    const memory = makeMemory({
      metadata: {
        index: 'test',
        dynamics: {
          accessCount: 100,
          initialPriority: 0.5,
          currentPriority: 0.5,
          createdAt: new Date().toISOString(),
        },
      },
    });
    const score = getUsageScore(memory);
    const expected = Math.log(101) / Math.log(101);
    expect(score).toBeCloseTo(expected, 3);
    expect(score).toBeGreaterThanOrEqual(0.99);
  });

  it('should clamp negative accessCount to 0', () => {
    const memory = makeMemory({
      metadata: {
        index: 'test',
        dynamics: {
          accessCount: -5,
          initialPriority: 0.5,
          currentPriority: 0.5,
          createdAt: new Date().toISOString(),
        },
      },
    });
    expect(getUsageScore(memory)).toBe(0);
  });

  it('should treat NaN accessCount as 0', () => {
    const memory = makeMemory({
      metadata: {
        index: 'test',
        dynamics: {
          accessCount: NaN,
          initialPriority: 0.5,
          currentPriority: 0.5,
          createdAt: new Date().toISOString(),
        },
      },
    });
    expect(getUsageScore(memory)).toBe(0);
  });

  it('should treat Infinity accessCount as 0', () => {
    const memory = makeMemory({
      metadata: {
        index: 'test',
        dynamics: {
          accessCount: Infinity,
          initialPriority: 0.5,
          currentPriority: 0.5,
          createdAt: new Date().toISOString(),
        },
      },
    });
    expect(getUsageScore(memory)).toBe(0);
  });

  it('should treat non-numeric accessCount as 0', () => {
    const memory = makeMemory({
      metadata: {
        index: 'test',
        dynamics: {
          accessCount: 'not-a-number' as unknown as number,
          initialPriority: 0.5,
          currentPriority: 0.5,
          createdAt: new Date().toISOString(),
        },
      },
    });
    expect(getUsageScore(memory)).toBe(0);
  });

  it('should saturate at 1.0 for very high accessCount (> 100)', () => {
    const memory = makeMemory({
      metadata: {
        index: 'test',
        dynamics: {
          accessCount: 500,
          initialPriority: 0.5,
          currentPriority: 0.5,
          createdAt: new Date().toISOString(),
        },
      },
    });
    const score = getUsageScore(memory);
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThanOrEqual(0.99);
  });
});

describe('getImportanceScore', () => {
  it('should return 1.0 for high importance', () => {
    expect(getImportanceScore('high')).toBe(1.0);
  });

  it('should return 0.6 for medium importance', () => {
    expect(getImportanceScore('medium')).toBe(0.6);
  });

  it('should return 0.3 for low importance', () => {
    expect(getImportanceScore('low')).toBe(0.3);
  });

  it('should return 0.3 for undefined importance', () => {
    expect(getImportanceScore(undefined)).toBe(0.3);
  });

  it('should return 0.3 for any other string value', () => {
    expect(getImportanceScore('urgent' as unknown as Importance)).toBe(0.3);
    expect(getImportanceScore('critical' as unknown as Importance)).toBe(0.3);
    expect(getImportanceScore('' as unknown as Importance)).toBe(0.3);
  });
});

describe('getEmotionScore', () => {
  it('should return 0 for undefined emotion', () => {
    expect(getEmotionScore(undefined)).toBe(0);
  });

  it('should return 0 for empty emotion object', () => {
    expect(getEmotionScore({})).toBe(0);
  });

  it('should return 0 for emotion with intensity 0', () => {
    expect(getEmotionScore({ intensity: 0 })).toBe(0);
  });

  it('should return intensity value for valid emotion', () => {
    expect(getEmotionScore({ intensity: 0.5 })).toBe(0.5);
  });

  it('should clamp negative intensity to 0', () => {
    expect(getEmotionScore({ intensity: -1 })).toBe(0);
  });

  it('should clamp intensity > 1 to 1', () => {
    expect(getEmotionScore({ intensity: 2 })).toBe(1);
  });

  it('should handle emotion with label and intensity', () => {
    expect(getEmotionScore({ label: 'joy', intensity: 0.8 })).toBe(0.8);
  });
});

describe('computeTypeDependentPriority', () => {
  const now = new Date();

  describe('self and belief memory types', () => {
    it('should compute priority for self type with known components', () => {
      const memory = makeMemory({
        content: {
          text: 'I am a developer',
          timestamp: now.toISOString(),
        },
        metadata: {
          index: 'test',
          memoryType: 'self',
          importance: 'high',
          dynamics: {
            accessCount: 0,
            initialPriority: 1.0,
            currentPriority: 1.0,
            createdAt: now.toISOString(),
          },
        },
      });

      const priority = computeTypeDependentPriority(memory, now);
      // recency=1, importance=1, usage=0, emotion=0
      // self: 0.1*1 + 0.4*1 + 0.3*0 + 0.2*0 = 0.5
      expect(priority).toBeCloseTo(0.5, 6);
    });

    it('should apply 0.4 floor for canonical self/belief memories', () => {
      const memory = makeMemory({
        content: {
          text: 'Core belief',
          timestamp: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year old
        },
        metadata: {
          index: 'test',
          memoryType: 'belief',
          importance: 'low',
          dynamics: {
            accessCount: 0,
            stability: 'canonical',
            initialPriority: 0.3,
            currentPriority: 0.3,
            createdAt: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString(),
          },
        },
      });

      const priority = computeTypeDependentPriority(memory, now);
      // Without floor, this would be very low (old, low importance, no usage)
      // With canonical floor, should be at least 0.4
      expect(priority).toBeGreaterThanOrEqual(0.4);
    });

    it('should not apply floor for non-canonical self/belief memories', () => {
      const memory = makeMemory({
        content: {
          text: 'Tentative belief',
          timestamp: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString(),
        },
        metadata: {
          index: 'test',
          memoryType: 'belief',
          importance: 'low',
          dynamics: {
            accessCount: 0,
            stability: 'tentative',
            initialPriority: 0.3,
            currentPriority: 0.1,
            createdAt: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString(),
          },
        },
      });

      const priority = computeTypeDependentPriority(memory, now);
      // Should be low without canonical floor
      expect(priority).toBeLessThan(0.4);
    });
  });

  describe('pattern memory type', () => {
    it('should compute priority for pattern type', () => {
      const memory = makeMemory({
        content: {
          text: 'When coding, I test thoroughly',
          timestamp: now.toISOString(),
        },
        metadata: {
          index: 'test',
          memoryType: 'pattern',
          importance: 'medium',
          dynamics: {
            accessCount: 10,
            initialPriority: 0.6,
            currentPriority: 0.6,
            createdAt: now.toISOString(),
          },
        },
      });

      const priority = computeTypeDependentPriority(memory, now);
      const recency = 1.0;
      const usage = Math.log(11) / Math.log(101);
      const importance = 0.6;
      const emotion = 0.0;
      const expected = 0.25 * recency + 0.3 * importance + 0.3 * usage + 0.15 * emotion;
      expect(priority).toBeCloseTo(expected, 6);
    });
  });

  describe('episodic memory type', () => {
    it('should compute priority for episodic type', () => {
      const memory = makeMemory({
        content: {
          text: 'Met Alice at the conference',
          timestamp: now.toISOString(),
        },
        metadata: {
          index: 'test',
          memoryType: 'episodic',
          importance: 'high',
          emotion: { intensity: 0.7, label: 'excitement' },
          dynamics: {
            accessCount: 5,
            initialPriority: 0.8,
            currentPriority: 0.8,
            createdAt: now.toISOString(),
          },
        },
      });

      const priority = computeTypeDependentPriority(memory, now);
      const recency = 1.0;
      const usage = Math.log(6) / Math.log(101);
      const importance = 1.0;
      const emotion = 0.7;
      const expected = 0.4 * recency + 0.2 * importance + 0.2 * usage + 0.2 * emotion;
      expect(priority).toBeCloseTo(expected, 6);
    });

    it('should decay episodic memory priority with age (9-month-old with high importance yields ~0.2 priority)', () => {
      const nineMonthsAgo = new Date(now.getTime() - 270 * 24 * 60 * 60 * 1000); // ~9 months (270 days)
      const memory = makeMemory({
        content: {
          text: 'YouTube script from February about work-life balance',
          timestamp: nineMonthsAgo.toISOString(),
        },
        metadata: {
          index: 'test',
          memoryType: 'episodic',
          importance: 'high',
          dynamics: {
            accessCount: 0,
            initialPriority: 0.8,
            currentPriority: 0.8,
            createdAt: nineMonthsAgo.toISOString(),
          },
        },
      });

      const priority = computeTypeDependentPriority(memory, now);
      // Episodic formula: 0.4 * recency + 0.2 * importance + 0.2 * usage + 0.2 * emotion
      // With 9-month-old timestamp and high importance (1.0), should be ~0.2
      expect(priority).toBeCloseTo(0.2, 1);
      expect(priority).toBeGreaterThan(0.15);
      expect(priority).toBeLessThan(0.25);
    });
  });

  describe('semantic memory type', () => {
    it('should compute priority for semantic type', () => {
      const memory = makeMemory({
        content: {
          text: 'JavaScript is single-threaded',
          timestamp: now.toISOString(),
        },
        metadata: {
          index: 'test',
          memoryType: 'semantic',
          importance: 'high',
          dynamics: {
            accessCount: 20,
            initialPriority: 0.9,
            currentPriority: 0.9,
            createdAt: now.toISOString(),
          },
        },
      });

      const priority = computeTypeDependentPriority(memory, now);
      const recency = 1.0;
      const usage = Math.log(21) / Math.log(101);
      const importance = 1.0;
      const emotion = 0.0;
      const expected = 0.1 * recency + 0.5 * importance + 0.2 * usage + 0.2 * emotion;
      expect(priority).toBeCloseTo(expected, 6);
    });
  });

  describe('default memory type', () => {
    it('should default to semantic type when memoryType is undefined', () => {
      const memory = makeMemory({
        content: {
          text: 'Some fact',
          timestamp: now.toISOString(),
        },
        metadata: {
          index: 'test',
          importance: 'medium',
          dynamics: {
            accessCount: 0,
            initialPriority: 0.6,
            currentPriority: 0.6,
            createdAt: now.toISOString(),
          },
        },
      });

      const priority = computeTypeDependentPriority(memory, now);
      // Should use semantic formula: 0.1 * recency + 0.5 * importance + 0.2 * usage + 0.2 * emotion
      const expected = 0.1 * 1.0 + 0.5 * 0.6 + 0.2 * 0 + 0.2 * 0;
      expect(priority).toBeCloseTo(expected, 6);
    });

    it('should use default importance (0.3) when importance is undefined', () => {
      const memory = makeMemory({
        content: {
          text: 'Some fact',
          timestamp: now.toISOString(),
        },
        metadata: {
          index: 'test',
          // importance is undefined
          dynamics: {
            accessCount: 0,
            initialPriority: 0.3,
            currentPriority: 0.3,
            createdAt: now.toISOString(),
          },
        },
      });

      const priority = computeTypeDependentPriority(memory, now);
      // Should use semantic formula with default importance: 0.1 * recency + 0.5 * 0.3 + 0.2 * usage + 0.2 * emotion
      const expected = 0.1 * 1.0 + 0.5 * 0.3 + 0.2 * 0 + 0.2 * 0;
      expect(priority).toBeCloseTo(expected, 6);
    });
  });

  describe('priority clamping', () => {
    it('should clamp priority to [0, 1] range', () => {
      const memory = makeMemory({
        content: {
          text: 'Test',
          timestamp: now.toISOString(),
        },
        metadata: {
          index: 'test',
          memoryType: 'semantic',
          importance: 'high',
          emotion: { intensity: 1.0 },
          dynamics: {
            accessCount: 100,
            initialPriority: 1.0,
            currentPriority: 1.0,
            createdAt: now.toISOString(),
          },
        },
      });

      const priority = computeTypeDependentPriority(memory, now);
      expect(priority).toBeLessThanOrEqual(1.0);
      expect(priority).toBeGreaterThanOrEqual(0.0);
    });
  });
});
