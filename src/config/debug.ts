export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

export type LogFormat = 'json' | 'pretty';

export interface DebugConfig {
  enabled: boolean;
  logOperations: boolean;
  logValidation: boolean;
  logAccessTracking: boolean;
  logRepository: boolean;
  logQueryExpansion: boolean; // Controls query expansion diagnostics (independent of logOperations)
  logLevel: LogLevel;
  logFormat: LogFormat;
  enableRequestTiming: boolean;
  enableTokenTracking: boolean;
  enableQueryPerformance: boolean;
  slowQueryThresholdMs: number;
}

const toBool = (value: string | undefined, defaultValue: boolean) => {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  return value.trim().toLowerCase() === 'true';
};

const toLogLevel = (value: string | undefined, defaultValue: LogLevel): LogLevel => {
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'debug':
      return LogLevel.DEBUG;
    case 'info':
      return LogLevel.INFO;
    case 'warn':
      return LogLevel.WARN;
    case 'error':
      return LogLevel.ERROR;
    default:
      return defaultValue;
  }
};

const toLogFormat = (value: string | undefined, defaultValue: LogFormat): LogFormat => {
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === 'json' ? 'json' : defaultValue;
};

const toNumber = (value: string | undefined, defaultValue: number): number => {
  if (!value) {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
};

export function loadDebugConfig(): DebugConfig {
  const enabled = toBool(process.env.MEMORY_DEBUG_MODE, false);

  // New observability settings (independent of MEMORY_DEBUG_MODE)
  const logLevel = toLogLevel(process.env.MEMORY_LOG_LEVEL, LogLevel.INFO);
  const logFormat = toLogFormat(process.env.MEMORY_LOG_FORMAT, 'pretty');
  const enableRequestTiming = toBool(process.env.MEMORY_ENABLE_REQUEST_TIMING, true);
  const enableTokenTracking = toBool(process.env.MEMORY_ENABLE_TOKEN_TRACKING, true);
  const enableQueryPerformance = toBool(process.env.MEMORY_ENABLE_QUERY_PERFORMANCE, true);
  const slowQueryThresholdMs = toNumber(process.env.MEMORY_SLOW_QUERY_THRESHOLD_MS, 100);

  if (!enabled) {
    return {
      enabled: false,
      logOperations: false,
      logValidation: false,
      logAccessTracking: false,
      logRepository: false,
      logQueryExpansion: false,
      logLevel,
      logFormat,
      enableRequestTiming,
      enableTokenTracking,
      enableQueryPerformance,
      slowQueryThresholdMs,
    };
  }

  return {
    enabled: true,
    logOperations: toBool(process.env.MEMORY_DEBUG_OPERATIONS, true),
    logValidation: toBool(process.env.MEMORY_DEBUG_VALIDATION, true),
    logAccessTracking: toBool(process.env.MEMORY_DEBUG_ACCESS_TRACKING, true),
    logRepository: toBool(process.env.MEMORY_DEBUG_REPOSITORY, true),
    logQueryExpansion: toBool(process.env.MEMORY_DEBUG_QUERY_EXPANSION, true),
    logLevel,
    logFormat,
    enableRequestTiming,
    enableTokenTracking,
    enableQueryPerformance,
    slowQueryThresholdMs,
  };
}
