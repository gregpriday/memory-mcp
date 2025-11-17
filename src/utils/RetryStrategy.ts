export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

const RETRYABLE_SNIPPETS = [
  'timeout',
  'econnrefused',
  'etimedout',
  'econnreset',
  'rate limit',
  '429',
  '503',
  'service unavailable',
];

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return RETRYABLE_SNIPPETS.some((snippet) => message.includes(snippet));
}

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const backoffMultiplier = options.backoffMultiplier ?? 2;

  let delay = initialDelayMs;
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt > maxRetries || !isRetryable(error)) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }
}
