import { SearchDiagnostics } from './types.js';

/**
 * Custom error class for memory search failures that carries diagnostic information.
 * This allows upstream callers to access detailed context about what went wrong.
 */
export class MemorySearchError extends Error {
  public readonly diagnostics: SearchDiagnostics;
  public readonly cause?: Error;

  constructor(message: string, diagnostics: SearchDiagnostics, cause?: Error) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MemorySearchError';
    this.diagnostics = diagnostics;
    this.cause = cause;

    // Maintain proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MemorySearchError);
    }
  }

  /**
   * Get the Postgres error code if available
   */
  get postgresCode(): string | undefined {
    return this.diagnostics.postgresCode;
  }

  /**
   * Get troubleshooting hint if available
   */
  get hint(): string | undefined {
    return this.diagnostics.hint;
  }

  /**
   * Get suggested fixes if available
   */
  get suggestedFixes(): string[] | undefined {
    return this.diagnostics.suggestedFixes;
  }

  /**
   * Get additional error details if available
   */
  get details(): Record<string, unknown> | undefined {
    return this.diagnostics.details;
  }
}
