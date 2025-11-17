import { loadDebugConfig } from '../config/debug.js';

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
      return debugConfig.logQueryExpansion; // Now uses dedicated MEMORY_DEBUG_QUERY_EXPANSION flag
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

export function debugLog(category: DebugCategory, message: string, payload?: unknown) {
  if (!categoryEnabled(category)) {
    return;
  }

  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] [memory:${category}] ${message}`;
  if (payload === undefined) {
    console.error(base);
    return;
  }

  console.error(`${base}\n${serialize(payload)}`);
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
