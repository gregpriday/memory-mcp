import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { loadBackendConfig } from '../backend.js';

describe('loadBackendConfig', () => {
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

  it('should load valid DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/memory_test';
    delete process.env.MEMORY_PROJECT_ID;

    const config = loadBackendConfig();

    expect(config.databaseUrl).toBe('postgresql://postgres:postgres@localhost:5433/memory_test');
    expect(config.projectId).toBe('default');
  });

  it('should use custom MEMORY_PROJECT_ID when provided', () => {
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/memory_test';
    process.env.MEMORY_PROJECT_ID = 'test';

    const config = loadBackendConfig();

    expect(config.databaseUrl).toBe('postgresql://postgres:postgres@localhost:5433/memory_test');
    expect(config.projectId).toBe('test');
  });

  it('should handle whitespace in DATABASE_URL', () => {
    process.env.DATABASE_URL = '  postgresql://postgres:postgres@localhost:5433/memory_test  ';

    const config = loadBackendConfig();

    expect(config.databaseUrl).toBe('postgresql://postgres:postgres@localhost:5433/memory_test');
  });

  it('should handle whitespace in MEMORY_PROJECT_ID', () => {
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/memory_test';
    process.env.MEMORY_PROJECT_ID = '  custom-project  ';

    const config = loadBackendConfig();

    expect(config.projectId).toBe('custom-project');
  });

  it('should accept postgres:// protocol', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@host:5432/db';

    const config = loadBackendConfig();

    expect(config.databaseUrl).toBe('postgres://user:pass@host:5432/db');
  });

  it('should accept postgresql:// protocol', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/db';

    const config = loadBackendConfig();

    expect(config.databaseUrl).toBe('postgresql://user:pass@host:5432/db');
  });

  it('should throw when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;

    expect(() => loadBackendConfig()).toThrow('DATABASE_URL is required');
  });

  it('should throw when DATABASE_URL is empty', () => {
    process.env.DATABASE_URL = '';

    expect(() => loadBackendConfig()).toThrow('DATABASE_URL is required');
  });

  it('should throw when DATABASE_URL is whitespace only', () => {
    process.env.DATABASE_URL = '   ';

    expect(() => loadBackendConfig()).toThrow('DATABASE_URL is required');
  });

  it('should throw when DATABASE_URL has invalid protocol', () => {
    process.env.DATABASE_URL = 'mysql://localhost/db';

    expect(() => loadBackendConfig()).toThrow(
      'DATABASE_URL must be a PostgreSQL connection string (postgres:// or postgresql://)'
    );
  });

  it('should throw when DATABASE_URL has no protocol', () => {
    process.env.DATABASE_URL = 'localhost:5432/db';

    expect(() => loadBackendConfig()).toThrow(
      'DATABASE_URL must be a PostgreSQL connection string (postgres:// or postgresql://)'
    );
  });
});
