import { loadDebugConfig } from '../config/debug.js';
import { loadLoggingConfig, shouldLog, type LogLevel } from '../config/logging.js';

const debugConfig = loadDebugConfig();
const loggingConfig = loadLoggingConfig();

export type DebugCategory =
  | 'operation'
  | 'validation'
  | 'access'
  | 'repository'
  | 'query-expansion'
  | 'reconsolidation';

// Structured log entry interface
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  event: string;
  message?: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

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
    case 'reconsolidation':
      return debugConfig.logOperations; // Wire to operations flag
    default:
      return false;
  }
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

// Format log entry based on configured format
function formatLogEntry(entry: LogEntry): string {
  if (loggingConfig.format === 'json') {
    return JSON.stringify(entry);
  }

  // Pretty format
  const parts = [
    `[${entry.timestamp}]`,
    `[${entry.level.toUpperCase()}]`,
    `[${entry.component}]`,
    entry.event,
  ];

  if (entry.message) {
    parts.push(`- ${entry.message}`);
  }

  if (entry.durationMs !== undefined) {
    parts.push(`(${entry.durationMs}ms)`);
  }

  let output = parts.join(' ');

  if (entry.meta && Object.keys(entry.meta).length > 0) {
    output += '\n' + serialize(entry.meta);
  }

  return output;
}

// Core structured logging function
export function log(
  level: LogLevel,
  component: string,
  event: string,
  options?: {
    message?: string;
    durationMs?: number;
    meta?: Record<string, unknown>;
  }
) {
  if (!shouldLog(loggingConfig.level, level)) {
    return;
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    event,
    message: options?.message,
    durationMs: options?.durationMs,
    meta: options?.meta,
  };

  const formatted = formatLogEntry(entry);
  console.error(formatted);
}

// Convenience logging functions
export function logDebug(
  component: string,
  event: string,
  options?: { message?: string; meta?: Record<string, unknown> }
) {
  log('debug', component, event, options);
}

export function logInfo(
  component: string,
  event: string,
  options?: { message?: string; meta?: Record<string, unknown> }
) {
  log('info', component, event, options);
}

export function logWarn(
  component: string,
  event: string,
  options?: { message?: string; meta?: Record<string, unknown> }
) {
  log('warn', component, event, options);
}

export function logError(
  component: string,
  event: string,
  options?: { message?: string; meta?: Record<string, unknown>; error?: Error }
) {
  const meta = options?.meta || {};
  if (options?.error) {
    meta.error = {
      name: options.error.name,
      message: options.error.message,
      stack: options.error.stack,
    };
  }

  log('error', component, event, {
    message: options?.message,
    meta,
  });
}

// Timer helper for measuring operation duration
export interface Timer {
  end: (options?: { message?: string; meta?: Record<string, unknown> }) => void;
}

export function startTimer(component: string, event: string, level: LogLevel = 'debug'): Timer {
  const start = Date.now();

  log(level, component, `${event}:start`);

  return {
    end: (options?: { message?: string; meta?: Record<string, unknown> }) => {
      const durationMs = Date.now() - start;
      log(level, component, `${event}:end`, {
        message: options?.message,
        durationMs,
        meta: options?.meta,
      });
    },
  };
}

// Backward compatibility wrappers
export function debugLog(category: DebugCategory, message: string, payload?: unknown) {
  if (!categoryEnabled(category)) {
    return;
  }

  // Bypass shouldLog check to preserve legacy debug behavior
  // Legacy debug categories are controlled by MEMORY_DEBUG_* flags, not MEMORY_LOG_LEVEL
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level: 'debug',
    component: `legacy:${category}`,
    event: message,
    meta: payload ? { payload } : undefined,
  };

  const formatted = formatLogEntry(entry);
  console.error(formatted);
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
