import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { loadBackendConfig } from '../backend.js';
import { resolve } from 'path';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('loadBackendConfig', () => {
  // Capture original env at module load to avoid mutation issues
  const ORIGINAL_ENV = { ...process.env };
  let tempDir: string;

  beforeEach(() => {
    // Reset process.env to a clean state
    process.env = { ...ORIGINAL_ENV };

    // Create a temporary directory for test files
    tempDir = mkdtempSync(join(tmpdir(), 'backend-config-test-'));
  });

  afterEach(() => {
    // Clean up temporary directory after each test
    try {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  afterAll(() => {
    // Restore original environment
    process.env = ORIGINAL_ENV;
  });

  it('should load valid test configuration', () => {
    process.env.MEMORY_POSTGRES_PROJECT_REGISTRY = resolve(
      __dirname,
      '../../../config/projects.test.json'
    );
    process.env.MEMORY_ACTIVE_PROJECT = 'test';

    const config = loadBackendConfig();

    expect(config.activeProject.projectId).toBe('test');
    expect(config.activeProject.databaseUrl).toBe(
      'postgresql://postgres:postgres@localhost:5433/memory_test'
    );
    expect(config.projectRegistry).toHaveProperty('test');
    expect(config.projectRegistry.test.databaseUrl).toBe(config.activeProject.databaseUrl);
  });

  it('should throw when MEMORY_POSTGRES_PROJECT_REGISTRY is missing', () => {
    delete process.env.MEMORY_POSTGRES_PROJECT_REGISTRY;

    expect(() => loadBackendConfig()).toThrow('MEMORY_POSTGRES_PROJECT_REGISTRY is required');
  });

  it('should throw when registry file does not exist', () => {
    process.env.MEMORY_POSTGRES_PROJECT_REGISTRY = 'config/does-not-exist.json';

    expect(() => loadBackendConfig()).toThrow('Project registry not found at');
  });

  it('should throw when registry JSON is not an object', () => {
    const registryPath = join(tempDir, 'array-registry.json');
    writeFileSync(registryPath, '[]');
    process.env.MEMORY_POSTGRES_PROJECT_REGISTRY = registryPath;

    expect(() => loadBackendConfig()).toThrow(
      'Project registry must be an object of { projectId: { databaseUrl } } entries.'
    );
  });

  it('should throw when registry JSON is null', () => {
    const registryPath = join(tempDir, 'null-registry.json');
    writeFileSync(registryPath, 'null');
    process.env.MEMORY_POSTGRES_PROJECT_REGISTRY = registryPath;

    expect(() => loadBackendConfig()).toThrow(
      'Project registry must be an object of { projectId: { databaseUrl } } entries.'
    );
  });

  it('should throw when project entry is missing databaseUrl', () => {
    const registryPath = join(tempDir, 'missing-url.json');
    writeFileSync(registryPath, JSON.stringify({ proj: {} }));
    process.env.MEMORY_POSTGRES_PROJECT_REGISTRY = registryPath;

    expect(() => loadBackendConfig()).toThrow('Project proj is missing a valid databaseUrl.');
  });

  it('should throw when project entry is not an object', () => {
    const registryPath = join(tempDir, 'invalid-entry.json');
    writeFileSync(registryPath, JSON.stringify({ proj: 'not-an-object' }));
    process.env.MEMORY_POSTGRES_PROJECT_REGISTRY = registryPath;

    expect(() => loadBackendConfig()).toThrow('Invalid configuration for project proj');
  });

  it('should throw when project entry is an array', () => {
    const registryPath = join(tempDir, 'array-entry.json');
    writeFileSync(registryPath, JSON.stringify({ proj: [] }));
    process.env.MEMORY_POSTGRES_PROJECT_REGISTRY = registryPath;

    expect(() => loadBackendConfig()).toThrow('Invalid configuration for project proj');
  });

  it('should throw when active project not found in registry', () => {
    const registryPath = join(tempDir, 'other-project.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        other: { databaseUrl: 'postgresql://localhost/other' },
      })
    );
    process.env.MEMORY_POSTGRES_PROJECT_REGISTRY = registryPath;
    process.env.MEMORY_ACTIVE_PROJECT = 'missing';

    expect(() => loadBackendConfig()).toThrow('Project "missing" not found in registry (other)');
  });

  it('should throw when registry is empty and no default project', () => {
    const registryPath = join(tempDir, 'empty-registry.json');
    writeFileSync(registryPath, JSON.stringify({}));
    process.env.MEMORY_POSTGRES_PROJECT_REGISTRY = registryPath;
    delete process.env.MEMORY_ACTIVE_PROJECT;

    expect(() => loadBackendConfig()).toThrow(
      'Project "default" not found in registry (no projects defined)'
    );
  });

  it('should use default project when MEMORY_ACTIVE_PROJECT is not set', () => {
    const registryPath = join(tempDir, 'default-project.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        default: { databaseUrl: 'postgresql://localhost/default_db' },
      })
    );
    process.env.MEMORY_POSTGRES_PROJECT_REGISTRY = registryPath;
    delete process.env.MEMORY_ACTIVE_PROJECT;

    const config = loadBackendConfig();

    expect(config.activeProject.projectId).toBe('default');
    expect(config.activeProject.databaseUrl).toBe('postgresql://localhost/default_db');
  });

  it('should handle whitespace in environment variables', () => {
    const registryPath = join(tempDir, 'whitespace-test.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        myproject: { databaseUrl: 'postgresql://localhost/mydb' },
      })
    );
    process.env.MEMORY_POSTGRES_PROJECT_REGISTRY = `  ${registryPath}  `;
    process.env.MEMORY_ACTIVE_PROJECT = '  myproject  ';

    const config = loadBackendConfig();

    expect(config.activeProject.projectId).toBe('myproject');
    expect(config.activeProject.databaseUrl).toBe('postgresql://localhost/mydb');
  });

  it('should throw when databaseUrl is not a string', () => {
    const registryPath = join(tempDir, 'invalid-url-type.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        proj: { databaseUrl: 123 },
      })
    );
    process.env.MEMORY_POSTGRES_PROJECT_REGISTRY = registryPath;

    expect(() => loadBackendConfig()).toThrow('Project proj is missing a valid databaseUrl.');
  });
});
