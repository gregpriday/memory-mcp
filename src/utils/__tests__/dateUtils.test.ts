import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { formatRelativeTime } from '../dateUtils.js';

describe('formatRelativeTime', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const setCurrentTime = (isoString: string) => {
    jest.setSystemTime(new Date(isoString));
  };

  describe('just now', () => {
    it('should return "just now" for timestamps less than 1 minute old', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');
      expect(formatRelativeTime('2025-01-15T11:59:30.000Z')).toBe('just now');
      expect(formatRelativeTime('2025-01-15T11:59:59.999Z')).toBe('just now');
    });

    it('should return "just now" for current timestamp', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');
      expect(formatRelativeTime('2025-01-15T12:00:00.000Z')).toBe('just now');
    });
  });

  describe('minutes ago', () => {
    it('should return "1 minute ago" for timestamps 1 minute old', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');
      expect(formatRelativeTime('2025-01-15T11:59:00.000Z')).toBe('1 minute ago');
    });

    it('should return plural "minutes ago" for multiple minutes', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');
      expect(formatRelativeTime('2025-01-15T11:55:00.000Z')).toBe('5 minutes ago');
      expect(formatRelativeTime('2025-01-15T11:30:00.000Z')).toBe('30 minutes ago');
      expect(formatRelativeTime('2025-01-15T11:01:00.000Z')).toBe('59 minutes ago');
    });
  });

  describe('hours ago', () => {
    it('should return "1 hour ago" for timestamps 1 hour old', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');
      expect(formatRelativeTime('2025-01-15T11:00:00.000Z')).toBe('1 hour ago');
    });

    it('should return plural "hours ago" for multiple hours', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');
      expect(formatRelativeTime('2025-01-15T10:00:00.000Z')).toBe('2 hours ago');
      expect(formatRelativeTime('2025-01-15T00:00:00.000Z')).toBe('12 hours ago');
      expect(formatRelativeTime('2025-01-14T13:00:00.000Z')).toBe('23 hours ago');
    });
  });

  describe('days ago', () => {
    it('should return "1 day ago" for timestamps 1 day old', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');
      expect(formatRelativeTime('2025-01-14T12:00:00.000Z')).toBe('1 day ago');
    });

    it('should return plural "days ago" for multiple days', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');
      expect(formatRelativeTime('2025-01-13T12:00:00.000Z')).toBe('2 days ago');
      expect(formatRelativeTime('2025-01-10T12:00:00.000Z')).toBe('5 days ago');
      expect(formatRelativeTime('2025-01-09T12:00:00.000Z')).toBe('6 days ago');
    });
  });

  describe('weeks ago', () => {
    it('should return "1 week ago" for timestamps 7-13 days old', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');
      expect(formatRelativeTime('2025-01-08T12:00:00.000Z')).toBe('1 week ago');
      expect(formatRelativeTime('2025-01-02T12:00:00.000Z')).toBe('1 week ago');
    });

    it('should return plural "weeks ago" for multiple weeks', () => {
      setCurrentTime('2025-01-31T12:00:00.000Z');
      expect(formatRelativeTime('2025-01-17T12:00:00.000Z')).toBe('2 weeks ago');
      expect(formatRelativeTime('2025-01-10T12:00:00.000Z')).toBe('3 weeks ago');
      expect(formatRelativeTime('2025-01-03T12:00:00.000Z')).toBe('4 weeks ago');
    });

    it('should handle boundary at 29-30 days (weeks to months transition)', () => {
      setCurrentTime('2025-02-01T12:00:00.000Z');
      // 29 days = 4 weeks
      expect(formatRelativeTime('2025-01-03T12:00:00.000Z')).toBe('4 weeks ago');
      // 30 days = 1 month
      expect(formatRelativeTime('2025-01-02T12:00:00.000Z')).toBe('1 month ago');
    });
  });

  describe('months ago', () => {
    it('should return "1 month ago" for timestamps 30-59 days old', () => {
      setCurrentTime('2025-02-15T12:00:00.000Z');
      expect(formatRelativeTime('2025-01-16T12:00:00.000Z')).toBe('1 month ago');
      // 60 days is 2 months in simple day-based calculation
      expect(formatRelativeTime('2024-12-17T12:00:00.000Z')).toBe('2 months ago');
    });

    it('should handle boundary at 59 days (still 1 month)', () => {
      setCurrentTime('2025-03-01T12:00:00.000Z');
      // 59 days ago should still be "1 month ago"
      const fiftyNineDaysAgo = new Date('2025-03-01T12:00:00.000Z');
      fiftyNineDaysAgo.setDate(fiftyNineDaysAgo.getDate() - 59);
      expect(formatRelativeTime(fiftyNineDaysAgo.toISOString())).toBe('1 month ago');
    });

    it('should return plural "months ago" for multiple months', () => {
      setCurrentTime('2025-06-15T12:00:00.000Z');
      expect(formatRelativeTime('2025-04-16T12:00:00.000Z')).toBe('2 months ago');
      expect(formatRelativeTime('2025-03-16T12:00:00.000Z')).toBe('3 months ago');
      expect(formatRelativeTime('2025-01-16T12:00:00.000Z')).toBe('5 months ago');
      expect(formatRelativeTime('2024-12-16T12:00:00.000Z')).toBe('6 months ago');
      expect(formatRelativeTime('2024-08-16T12:00:00.000Z')).toBe('10 months ago');
    });
  });

  describe('years ago', () => {
    it('should return "1 year ago" for timestamps 365-729 days old', () => {
      setCurrentTime('2026-01-15T12:00:00.000Z');
      expect(formatRelativeTime('2025-01-15T12:00:00.000Z')).toBe('1 year ago');
      expect(formatRelativeTime('2024-02-15T12:00:00.000Z')).toBe('1 year ago');
    });

    it('should return plural "years ago" for multiple years', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');
      expect(formatRelativeTime('2023-01-15T12:00:00.000Z')).toBe('2 years ago');
      expect(formatRelativeTime('2020-01-15T12:00:00.000Z')).toBe('5 years ago');
      expect(formatRelativeTime('2015-01-15T12:00:00.000Z')).toBe('10 years ago');
    });

    it('should handle boundary at 364 days (still months, not years)', () => {
      setCurrentTime('2026-01-15T12:00:00.000Z');
      // 364 days = 12 months
      const date364DaysAgo = new Date('2026-01-15T12:00:00.000Z');
      date364DaysAgo.setDate(date364DaysAgo.getDate() - 364);
      expect(formatRelativeTime(date364DaysAgo.toISOString())).toBe('12 months ago');
    });
  });

  describe('edge cases', () => {
    it('should handle timestamps at exact boundaries', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');

      // Exactly 60 seconds = 1 minute
      expect(formatRelativeTime('2025-01-15T11:59:00.000Z')).toBe('1 minute ago');

      // Exactly 60 minutes = 1 hour
      expect(formatRelativeTime('2025-01-15T11:00:00.000Z')).toBe('1 hour ago');

      // Exactly 24 hours = 1 day
      expect(formatRelativeTime('2025-01-14T12:00:00.000Z')).toBe('1 day ago');

      // Exactly 7 days = 1 week
      expect(formatRelativeTime('2025-01-08T12:00:00.000Z')).toBe('1 week ago');
    });

    it('should handle timestamps with milliseconds', () => {
      setCurrentTime('2025-01-15T12:00:00.500Z');
      expect(formatRelativeTime('2025-01-15T11:59:00.123Z')).toBe('1 minute ago');
    });

    it('should handle different ISO timestamp formats', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');

      // With timezone offset (converts to UTC 12:00:00)
      expect(formatRelativeTime('2025-01-15T07:00:00-05:00')).toBe('just now');

      // With milliseconds
      expect(formatRelativeTime('2025-01-15T11:55:00.000Z')).toBe('5 minutes ago');

      // ISO 8601 strings are always parsed as UTC when they have a Z suffix
      expect(formatRelativeTime('2025-01-15T12:00:00.000Z')).toBe('just now');
    });

    it('should handle future timestamps gracefully', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');

      // Future timestamp should return "just now" (negative diff becomes 0)
      expect(formatRelativeTime('2025-01-15T13:00:00.000Z')).toBe('just now');
    });

    it('should handle very old timestamps', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');
      expect(formatRelativeTime('1990-01-15T12:00:00.000Z')).toBe('35 years ago');
    });

    it('should handle invalid ISO strings gracefully', () => {
      setCurrentTime('2025-01-15T12:00:00.000Z');

      // Invalid date should return 'unknown age'
      expect(formatRelativeTime('invalid-date')).toBe('unknown age');
      expect(formatRelativeTime('')).toBe('unknown age');
      expect(formatRelativeTime('not-a-date')).toBe('unknown age');
    });
  });

  describe('real-world scenarios', () => {
    it('should format recent memory access correctly', () => {
      setCurrentTime('2025-01-15T14:30:00.000Z');
      expect(formatRelativeTime('2025-01-15T14:25:00.000Z')).toBe('5 minutes ago');
      expect(formatRelativeTime('2025-01-15T13:30:00.000Z')).toBe('1 hour ago');
      expect(formatRelativeTime('2025-01-15T10:30:00.000Z')).toBe('4 hours ago');
    });

    it('should format memory from previous days correctly', () => {
      setCurrentTime('2025-01-15T14:30:00.000Z');
      expect(formatRelativeTime('2025-01-14T14:30:00.000Z')).toBe('1 day ago');
      expect(formatRelativeTime('2025-01-13T14:30:00.000Z')).toBe('2 days ago');
    });

    it('should format older memories correctly', () => {
      setCurrentTime('2025-01-15T14:30:00.000Z');
      expect(formatRelativeTime('2025-01-08T14:30:00.000Z')).toBe('1 week ago');
      expect(formatRelativeTime('2024-12-15T14:30:00.000Z')).toBe('1 month ago');
      expect(formatRelativeTime('2024-01-15T14:30:00.000Z')).toBe('1 year ago');
    });
  });
});
