import { loadDebugConfig, LogLevel } from '../config/debug.js';

const debugConfig = loadDebugConfig();

export type DebugCategory =
  | 'operation'
  | 'validation'
  | 'access'
  | 'repository'
  | 'query-expansion';

function categoryEnabled(category: DebugCategory): boolean {
  if (!debugConfig.enabled) {
    return false;
  }

  switch (category) {
    case 'operation':
      return debugConfig.logOperations;
    case 'validation':
      return debugConfig.logValidation;
    case 'access':
      return debugConfig.logAccessTracking;
    case 'repository':
      return debugConfig.logRepository;
    case 'query-expansion':
      return debugConfig.logQueryExpansion;
    default:
      return false;
  }
}

interface LogEntry {
  timestamp: string;
  level: string;
  category?: string;
  message: string;
  [key: string]: unknown;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARN]: 2,
  [LogLevel.ERROR]: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[debugConfig.logLevel];
}

const serialize = (value: unknown) => {
  try {
    return JSON.stringify(
      value,
      (_key, val) => {
        if (val instanceof Error) {
          return { name: val.name, message: val.message, stack: val.stack };
        }
        return val;
      },
      2
    );
  } catch (error) {
    return `[unserializable: ${(error as Error).message}]`;
  }
};

function formatPretty(entry: LogEntry): string {
  const { timestamp, level, category, message, ...rest } = entry;
  const categoryStr = category ? `[memory:${category}]` : '[memory]';
  const levelStr = `[${level.toUpperCase()}]`;

  const base = `${timestamp} ${levelStr} ${categoryStr} ${message}`;

  const hasAdditionalData = Object.keys(rest).length > 0;
  if (!hasAdditionalData) {
    return base;
  }

  return `${base}\n${serialize(rest)}`;
}

function formatJson(entry: LogEntry): string {
  try {
    return JSON.stringify(entry, (_key, val) => {
      if (val instanceof Error) {
        return { name: val.name, message: val.message, stack: val.stack };
      }
      return val;
    });
  } catch (error) {
    return JSON.stringify({
      ...entry,
      _serializationError: `Failed to serialize: ${(error as Error).message}`,
    });
  }
}

function emit(entry: LogEntry): void {
  const output = debugConfig.logFormat === 'json' ? formatJson(entry) : formatPretty(entry);
  console.error(output);
}

class Logger {
  private createEntry(
    level: LogLevel,
    category: string | undefined,
    message: string,
    payload?: unknown
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };

    if (category) {
      entry.category = category;
    }

    if (payload !== undefined) {
      // Handle Error objects specially - extract enumerable fields
      if (payload instanceof Error) {
        const errorEntry: Record<string, unknown> = {
          name: payload.name,
          message: payload.message,
          stack: payload.stack,
        };
        if (payload.cause) {
          errorEntry.cause = payload.cause;
        }
        entry.error = errorEntry;
      } else if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
        // For plain objects, check if any values are Errors and serialize them
        const serialized: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(payload)) {
          if (val instanceof Error) {
            const errorEntry: Record<string, unknown> = {
              name: val.name,
              message: val.message,
              stack: val.stack,
            };
            if (val.cause) {
              errorEntry.cause = val.cause;
            }
            serialized[key] = errorEntry;
          } else {
            serialized[key] = val;
          }
        }
        Object.assign(entry, serialized);
      } else {
        entry.data = payload;
      }
    }

    return entry;
  }

  debug(category: DebugCategory, message: string, payload?: unknown): void {
    if (!categoryEnabled(category) || !shouldLog(LogLevel.DEBUG)) {
      return;
    }

    const entry = this.createEntry(LogLevel.DEBUG, category, message, payload);
    emit(entry);
  }

  info(message: string, payload?: unknown): void {
    if (!shouldLog(LogLevel.INFO)) {
      return;
    }

    const entry = this.createEntry(LogLevel.INFO, undefined, message, payload);
    emit(entry);
  }

  warn(message: string, payload?: unknown): void {
    if (!shouldLog(LogLevel.WARN)) {
      return;
    }

    const entry = this.createEntry(LogLevel.WARN, undefined, message, payload);
    emit(entry);
  }

  error(message: string, payload?: unknown): void {
    if (!shouldLog(LogLevel.ERROR)) {
      return;
    }

    const entry = this.createEntry(LogLevel.ERROR, undefined, message, payload);
    emit(entry);
  }

  metric(metricName: string, payload: unknown): void {
    if (!shouldLog(LogLevel.INFO)) {
      return;
    }

    const entry = this.createEntry(LogLevel.INFO, undefined, metricName, payload);
    entry.type = 'metric';
    emit(entry);
  }

  withTimer<T>(
    spanName: string,
    metadata?: Record<string, unknown>,
    fn?: () => T | Promise<T>
  ): T | Promise<T> | ((result?: T) => void) {
    const start = Date.now();

    // If no function provided, return a callback for manual timing (backwards compat with trackOperation)
    if (fn === undefined) {
      return (result?: T) => {
        const durationMs = Date.now() - start;
        this.metric(spanName, {
          ...metadata,
          durationMs,
          result,
        });
      };
    }

    // Otherwise, auto-time the function
    const finishTiming = (result?: T, error?: Error) => {
      const durationMs = Date.now() - start;
      if (error) {
        this.error(`${spanName} failed`, {
          ...metadata,
          durationMs,
          error: { name: error.name, message: error.message },
        });
      } else {
        this.metric(spanName, {
          ...metadata,
          durationMs,
          result,
        });
      }
    };

    try {
      const result = fn();

      // Handle async functions
      if (result instanceof Promise) {
        return result
          .then((res) => {
            finishTiming(res);
            return res;
          })
          .catch((err) => {
            finishTiming(undefined, err);
            throw err;
          }) as T | Promise<T>;
      }

      // Handle sync functions
      finishTiming(result);
      return result;
    } catch (error) {
      finishTiming(undefined, error as Error);
      throw error;
    }
  }
}

// Singleton instance
export const logger = new Logger();

// Backwards-compatible exports
export function debugLog(category: DebugCategory, message: string, payload?: unknown) {
  logger.debug(category, message, payload);
}

export function trackOperation<T>(label: string, meta?: unknown) {
  debugLog('operation', `${label} START`, meta);
  const start = Date.now();
  return (result?: T) => {
    debugLog('operation', `${label} END`, {
      durationMs: Date.now() - start,
      result,
    });
  };
}

export const debugLogOperation = trackOperation;
