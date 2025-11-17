import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { executeWithRetry, RetryOptions } from '../RetryStrategy.js';

describe('executeWithRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should succeed on first attempt', async () => {
    const mockFn = jest.fn<() => Promise<string>>().mockResolvedValue('success');

    const promise = executeWithRetry(mockFn);
    const result = await promise;

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should retry on retryable errors and eventually succeed', async () => {
    const mockFn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('Connection timeout'))
      .mockRejectedValueOnce(new Error('Rate limit exceeded'))
      .mockResolvedValue('success');

    const promise = executeWithRetry(mockFn, { initialDelayMs: 100 });

    // Advance timers to trigger retries
    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(200);

    const result = await promise;

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('should not retry on non-retryable errors', async () => {
    const mockFn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('Invalid credentials'));

    await expect(executeWithRetry(mockFn)).rejects.toThrow('Invalid credentials');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should throw after max retries exceeded', async () => {
    const mockFn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('Connection timeout'));

    const options: RetryOptions = {
      maxRetries: 2,
      initialDelayMs: 100,
    };

    const promise = executeWithRetry(mockFn, options);

    // Use Promise.race to handle timer advances without triggering unhandled rejections
    const resultPromise = Promise.race([
      promise.catch((err) => ({ error: err })),
      (async () => {
        await jest.advanceTimersByTimeAsync(100); // First retry
        await jest.advanceTimersByTimeAsync(200); // Second retry
        await jest.runOnlyPendingTimersAsync(); // Complete any remaining timers
      })(),
    ]);

    await resultPromise;

    await expect(promise).rejects.toThrow('Connection timeout');
    expect(mockFn).toHaveBeenCalledTimes(3); // Initial + 2 retries
  });

  it('should apply exponential backoff correctly', async () => {
    const mockFn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue('success');

    const options: RetryOptions = {
      initialDelayMs: 100,
      backoffMultiplier: 2,
    };

    const promise = executeWithRetry(mockFn, options);

    // First retry: 100ms
    await jest.advanceTimersByTimeAsync(100);
    expect(mockFn).toHaveBeenCalledTimes(2);

    // Second retry: 200ms (100 * 2)
    await jest.advanceTimersByTimeAsync(200);
    expect(mockFn).toHaveBeenCalledTimes(3);

    const result = await promise;
    expect(result).toBe('success');
  });

  it('should respect maxDelayMs cap', async () => {
    const mockFn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue('success');

    const options: RetryOptions = {
      initialDelayMs: 1000,
      backoffMultiplier: 3,
      maxDelayMs: 2000,
    };

    const promise = executeWithRetry(mockFn, options);

    // First retry: 1000ms
    await jest.advanceTimersByTimeAsync(1000);

    // Second retry should be capped at 2000ms, not 3000ms
    await jest.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBe('success');
  });

  it('should handle retryable error codes correctly', async () => {
    const testCases = [
      'econnrefused',
      'etimedout',
      'econnreset',
      'rate limit',
      '429',
      '503',
      'service unavailable',
    ];

    for (const errorMsg of testCases) {
      const mockFn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error(errorMsg.toUpperCase()))
        .mockResolvedValue('success');

      const promise = executeWithRetry(mockFn, { initialDelayMs: 10 });
      await jest.advanceTimersByTimeAsync(10);

      const result = await promise;
      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(2);

      jest.clearAllMocks();
    }
  });

  it('should handle non-Error objects', async () => {
    const mockFn = jest.fn<() => Promise<string>>().mockRejectedValue('string error');

    await expect(executeWithRetry(mockFn)).rejects.toThrow('string error');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should abort immediately on non-retryable error after retryable ones', async () => {
    const retryableError = new Error('timeout');
    const nonRetryableError = new Error('Invalid credentials');

    const mockFn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(nonRetryableError);

    const promise = executeWithRetry(mockFn, { initialDelayMs: 100 });

    // Use Promise.race to handle timer advances without triggering unhandled rejections
    const resultPromise = Promise.race([
      promise.catch((err) => ({ error: err })),
      (async () => {
        await jest.advanceTimersByTimeAsync(100);
        await jest.runOnlyPendingTimersAsync();
      })(),
    ]);

    await resultPromise;

    // Second attempt should throw non-retryable error immediately
    await expect(promise).rejects.toBe(nonRetryableError);
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('should respect maxRetries: 0 (no retries, only initial attempt)', async () => {
    const mockFn = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('timeout'));

    const options: RetryOptions = {
      maxRetries: 0,
      initialDelayMs: 50,
    };

    await expect(executeWithRetry(mockFn, options)).rejects.toThrow('timeout');
    expect(mockFn).toHaveBeenCalledTimes(1);

    // Advance timers to prove no retry occurs
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should maintain maxDelayMs cap across multiple retries', async () => {
    const mockFn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue('success');

    const options: RetryOptions = {
      initialDelayMs: 500,
      backoffMultiplier: 4,
      maxDelayMs: 1000,
    };

    const promise = executeWithRetry(mockFn, options);

    // First retry: 500ms
    await jest.advanceTimersByTimeAsync(500);
    expect(mockFn).toHaveBeenCalledTimes(2);

    // Second retry: should be capped at 1000ms, not 2000ms (500 * 4)
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockFn).toHaveBeenCalledTimes(3);

    // Third retry: should still be capped at 1000ms, not increase further
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockFn).toHaveBeenCalledTimes(4);

    const result = await promise;
    expect(result).toBe('success');
  });

  it('should preserve original error instance, not just message', async () => {
    const originalError = new Error('Invalid credentials');
    const mockFn = jest.fn<() => Promise<string>>().mockRejectedValue(originalError);

    await expect(executeWithRetry(mockFn)).rejects.toBe(originalError);
  });

  it('should preserve original error instance after max retries', async () => {
    const originalError = new Error('Connection timeout');
    const mockFn = jest.fn<() => Promise<string>>().mockRejectedValue(originalError);

    const options: RetryOptions = {
      maxRetries: 1,
      initialDelayMs: 100,
    };

    const promise = executeWithRetry(mockFn, options);

    // Use Promise.race to handle timer advances without triggering unhandled rejections
    const resultPromise = Promise.race([
      promise.catch((err) => ({ error: err })),
      (async () => {
        await jest.advanceTimersByTimeAsync(100);
        await jest.runOnlyPendingTimersAsync();
      })(),
    ]);

    await resultPromise;

    await expect(promise).rejects.toBe(originalError);
    expect(mockFn).toHaveBeenCalledTimes(2);
  });
});
