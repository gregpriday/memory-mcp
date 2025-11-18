import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { loadDebugConfig } from '../debug.js';

describe('loadDebugConfig', () => {
  // Capture original env at module load to avoid mutation issues
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Reset process.env to a clean state
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    // Restore original environment
    process.env = ORIGINAL_ENV;
  });

  it('should default to debug disabled when env is not set', () => {
    delete process.env.MEMORY_DEBUG_MODE;
    delete process.env.MEMORY_DEBUG_OPERATIONS;
    delete process.env.MEMORY_DEBUG_VALIDATION;
    delete process.env.MEMORY_DEBUG_ACCESS_TRACKING;
    delete process.env.MEMORY_DEBUG_REPOSITORY;
    delete process.env.MEMORY_DEBUG_QUERY_EXPANSION;

    const config = loadDebugConfig();

    expect(config.enabled).toBe(false);
    expect(config.logOperations).toBe(false);
    expect(config.logValidation).toBe(false);
    expect(config.logAccessTracking).toBe(false);
    expect(config.logRepository).toBe(false);
    expect(config.logQueryExpansion).toBe(false);
  });

  it('should enable debug with all flags defaulting to true', () => {
    process.env.MEMORY_DEBUG_MODE = 'true';
    delete process.env.MEMORY_DEBUG_OPERATIONS;
    delete process.env.MEMORY_DEBUG_VALIDATION;
    delete process.env.MEMORY_DEBUG_ACCESS_TRACKING;
    delete process.env.MEMORY_DEBUG_REPOSITORY;
    delete process.env.MEMORY_DEBUG_QUERY_EXPANSION;

    const config = loadDebugConfig();

    expect(config.enabled).toBe(true);
    expect(config.logOperations).toBe(true);
    expect(config.logValidation).toBe(true);
    expect(config.logAccessTracking).toBe(true);
    expect(config.logRepository).toBe(true);
    expect(config.logQueryExpansion).toBe(true);
  });

  it('should allow explicit false flags when debug is enabled', () => {
    process.env.MEMORY_DEBUG_MODE = 'true';
    process.env.MEMORY_DEBUG_OPERATIONS = 'false';
    process.env.MEMORY_DEBUG_QUERY_EXPANSION = 'false';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(true);
    expect(config.logOperations).toBe(false);
    expect(config.logQueryExpansion).toBe(false);
    // Unset flags should default to true
    expect(config.logValidation).toBe(true);
    expect(config.logAccessTracking).toBe(true);
    expect(config.logRepository).toBe(true);
  });

  it('should handle case-insensitive debug mode TRUE', () => {
    process.env.MEMORY_DEBUG_MODE = 'TRUE';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(true);
  });

  it('should handle case-insensitive debug mode True', () => {
    process.env.MEMORY_DEBUG_MODE = 'True';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(true);
  });

  it('should handle case-insensitive debug mode false', () => {
    process.env.MEMORY_DEBUG_MODE = 'FALSE';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(false);
  });

  it('should ignore flag values when debug is disabled', () => {
    process.env.MEMORY_DEBUG_MODE = 'false';
    process.env.MEMORY_DEBUG_OPERATIONS = 'true';
    process.env.MEMORY_DEBUG_VALIDATION = 'true';
    process.env.MEMORY_DEBUG_ACCESS_TRACKING = 'true';
    process.env.MEMORY_DEBUG_REPOSITORY = 'true';
    process.env.MEMORY_DEBUG_QUERY_EXPANSION = 'true';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(false);
    expect(config.logOperations).toBe(false);
    expect(config.logValidation).toBe(false);
    expect(config.logAccessTracking).toBe(false);
    expect(config.logRepository).toBe(false);
    expect(config.logQueryExpansion).toBe(false);
  });

  it('should treat empty string as default when debug mode is empty', () => {
    process.env.MEMORY_DEBUG_MODE = '';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(false);
  });

  it('should handle whitespace in debug mode value', () => {
    process.env.MEMORY_DEBUG_MODE = '  true  ';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(true);
  });

  it('should handle whitespace in flag values', () => {
    process.env.MEMORY_DEBUG_MODE = 'true';
    process.env.MEMORY_DEBUG_OPERATIONS = '  false  ';
    process.env.MEMORY_DEBUG_VALIDATION = '  true  ';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(true);
    expect(config.logOperations).toBe(false);
    expect(config.logValidation).toBe(true);
  });

  it('should treat non-true values as false', () => {
    process.env.MEMORY_DEBUG_MODE = 'yes';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(false);
  });

  it('should allow selective flag enabling', () => {
    process.env.MEMORY_DEBUG_MODE = 'true';
    process.env.MEMORY_DEBUG_OPERATIONS = 'true';
    process.env.MEMORY_DEBUG_VALIDATION = 'false';
    process.env.MEMORY_DEBUG_ACCESS_TRACKING = 'true';
    process.env.MEMORY_DEBUG_REPOSITORY = 'false';
    process.env.MEMORY_DEBUG_QUERY_EXPANSION = 'true';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(true);
    expect(config.logOperations).toBe(true);
    expect(config.logValidation).toBe(false);
    expect(config.logAccessTracking).toBe(true);
    expect(config.logRepository).toBe(false);
    expect(config.logQueryExpansion).toBe(true);
  });

  it('should handle empty string flag values as defaults', () => {
    process.env.MEMORY_DEBUG_MODE = 'true';
    process.env.MEMORY_DEBUG_OPERATIONS = '';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(true);
    // Empty string should use default (true when debug is enabled)
    expect(config.logOperations).toBe(true);
  });

  it('should handle mixed case in flag values', () => {
    process.env.MEMORY_DEBUG_MODE = 'true';
    process.env.MEMORY_DEBUG_OPERATIONS = 'TrUe';
    process.env.MEMORY_DEBUG_VALIDATION = 'FaLsE';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(true);
    expect(config.logOperations).toBe(true);
    expect(config.logValidation).toBe(false);
  });

  it('should ignore per-flag env vars when debug mode is unset', () => {
    delete process.env.MEMORY_DEBUG_MODE;
    process.env.MEMORY_DEBUG_OPERATIONS = 'true';
    process.env.MEMORY_DEBUG_VALIDATION = 'true';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(false);
    expect(config.logOperations).toBe(false);
    expect(config.logValidation).toBe(false);
  });

  it('should treat whitespace-only debug mode as disabled', () => {
    process.env.MEMORY_DEBUG_MODE = '   ';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(false);
  });

  it('should treat whitespace-only flag value as false when debug enabled', () => {
    process.env.MEMORY_DEBUG_MODE = 'true';
    process.env.MEMORY_DEBUG_OPERATIONS = '   ';

    const config = loadDebugConfig();

    expect(config.enabled).toBe(true);
    // Whitespace-only is trimmed to empty string, which becomes false
    expect(config.logOperations).toBe(false);
  });
});
