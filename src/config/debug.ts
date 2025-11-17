export interface DebugConfig {
  enabled: boolean;
  logOperations: boolean;
  logValidation: boolean;
  logAccessTracking: boolean;
  logRepository: boolean;
  logQueryExpansion: boolean; // Controls query expansion diagnostics (independent of logOperations)
}

const toBool = (value: string | undefined, defaultValue: boolean) => {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  return value.trim().toLowerCase() === 'true';
};

export function loadDebugConfig(): DebugConfig {
  const enabled = toBool(process.env.MEMORY_DEBUG_MODE, false);

  if (!enabled) {
    return {
      enabled: false,
      logOperations: false,
      logValidation: false,
      logAccessTracking: false,
      logRepository: false,
      logQueryExpansion: false,
    };
  }

  return {
    enabled: true,
    logOperations: toBool(process.env.MEMORY_DEBUG_OPERATIONS, true),
    logValidation: toBool(process.env.MEMORY_DEBUG_VALIDATION, true),
    logAccessTracking: toBool(process.env.MEMORY_DEBUG_ACCESS_TRACKING, true),
    logRepository: toBool(process.env.MEMORY_DEBUG_REPOSITORY, true),
    logQueryExpansion: toBool(process.env.MEMORY_DEBUG_QUERY_EXPANSION, true),
  };
}
