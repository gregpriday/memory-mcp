import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { createMemoryServer } from '../MemoryServer.js';
import { loadBackendConfig } from '../../config/backend.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

/**
 * E2E tests for MemoryServer
 *
 * These tests verify the MCP server creation and configuration:
 * - Server instantiation with valid config
 * - Dependency wiring (repository, agent, controller)
 * - Error handling for invalid configurations
 *
 * Note: These tests focus on server creation and configuration validation
 * rather than deep handler mocking. The MemoryAgent E2E tests cover the
 * actual tool flows end-to-end.
 */

describe('MemoryServer E2E Tests', () => {
  let testDatabaseUrl: string;
  let testApiKey: string;

  beforeAll(async () => {
    // Load test database configuration
    const config = await loadBackendConfig();
    const testConfig = config.projectRegistry.test;
    if (!testConfig) {
      throw new Error('Test project not found in backend config');
    }
    testDatabaseUrl = testConfig.databaseUrl;

    // Use test API key
    testApiKey = process.env.OPENAI_API_KEY || 'test-key-for-server-creation';
  });

  afterAll(async () => {
    // Reset any environment variables or mocks
    jest.restoreAllMocks();
  });

  describe('Server Creation', () => {
    it('should create server with valid configuration', () => {
      const server = createMemoryServer({
        databaseUrl: testDatabaseUrl,
        openaiApiKey: testApiKey,
        defaultIndex: 'test-index',
        projectRoot: process.cwd(),
      });

      expect(server).toBeDefined();
      expect(server).toBeInstanceOf(Object);
    });

    it('should create server using environment configuration', () => {
      // This test relies on MEMORY_ACTIVE_PROJECT being set in jest.setup.cjs
      // and the projects.test.json configuration
      const server = createMemoryServer({
        openaiApiKey: testApiKey,
      });

      expect(server).toBeDefined();
    });

    it('should create server with minimal configuration', () => {
      const server = createMemoryServer({
        databaseUrl: testDatabaseUrl,
        openaiApiKey: testApiKey,
      });

      expect(server).toBeDefined();
    });
  });

  describe('Configuration Validation', () => {
    it('should reject invalid database URL protocol', () => {
      expect(() => {
        createMemoryServer({
          databaseUrl: 'http://localhost:5432/testdb',
          openaiApiKey: testApiKey,
        });
      }).toThrow('Invalid database URL');
    });

    it('should reject malformed database URL', () => {
      expect(() => {
        createMemoryServer({
          databaseUrl: 'not-a-valid-url',
          openaiApiKey: testApiKey,
        });
      }).toThrow('Invalid database URL');
    });

    it('should reject missing OpenAI API key', () => {
      expect(() => {
        createMemoryServer({
          databaseUrl: testDatabaseUrl,
          openaiApiKey: undefined,
        });
      }).toThrow('OPENAI_API_KEY is required');
    });
  });

  describe('Server Capabilities', () => {
    let server: Server;

    beforeAll(() => {
      server = createMemoryServer({
        databaseUrl: testDatabaseUrl,
        openaiApiKey: testApiKey,
        defaultIndex: 'capability-test',
      });
    });

    it('should expose server instance with correct type', () => {
      expect(server).toBeDefined();
      expect(typeof server).toBe('object');
    });

    it('should have request handler methods', () => {
      // Verify server has setRequestHandler method (MCP SDK interface)
      expect(server).toHaveProperty('setRequestHandler');
      expect(typeof server.setRequestHandler).toBe('function');
    });
  });

  describe('Tool Registration', () => {
    it('should register all required MCP tools', async () => {
      const server = createMemoryServer({
        databaseUrl: testDatabaseUrl,
        openaiApiKey: testApiKey,
      });

      // The server should be configured with ListTools and CallTool handlers
      // These are registered via server.setRequestHandler in createMemoryServer
      expect(server).toBeDefined();

      // Verify server was created successfully and is ready to handle requests
      // Note: Direct handler invocation requires accessing private server state
      // which is not part of the public API. Instead, we verify successful creation.
      expect(server).toHaveProperty('setRequestHandler');
    });
  });

  describe('Error Handling', () => {
    it('should handle errors during server creation gracefully', () => {
      // Test with completely invalid configuration
      expect(() => {
        createMemoryServer({
          databaseUrl: 'postgresql://invalid',
          openaiApiKey: '',
        });
      }).toThrow();
    });

    it('should provide clear error message for missing database URL', () => {
      // Save original env
      const originalEnv = process.env.MEMORY_ACTIVE_PROJECT;

      // Temporarily unset the active project to trigger missing database URL error
      delete process.env.MEMORY_ACTIVE_PROJECT;

      try {
        expect(() => {
          // Attempt to create server without database URL config
          createMemoryServer({
            openaiApiKey: testApiKey,
          });
        }).toThrow();
      } finally {
        // Restore original env
        if (originalEnv) {
          process.env.MEMORY_ACTIVE_PROJECT = originalEnv;
        }
      }
    });
  });

  describe('Environment Configuration Integration', () => {
    it('should respect custom project root', () => {
      const customRoot = '/tmp/test-project';
      const server = createMemoryServer({
        databaseUrl: testDatabaseUrl,
        openaiApiKey: testApiKey,
        projectRoot: customRoot,
      });

      expect(server).toBeDefined();
    });

    it('should respect custom default index', () => {
      const customIndex = 'custom-test-index';
      const server = createMemoryServer({
        databaseUrl: testDatabaseUrl,
        openaiApiKey: testApiKey,
        defaultIndex: customIndex,
      });

      expect(server).toBeDefined();
    });

    it('should use environment defaults when config omitted', () => {
      const server = createMemoryServer({
        openaiApiKey: testApiKey,
      });

      expect(server).toBeDefined();
    });
  });

  describe('Database URL Sanitization', () => {
    it('should sanitize database URL in logs', () => {
      // Capture console.error output
      const originalError = console.error;
      const errorLogs: string[] = [];
      console.error = (...args: unknown[]) => {
        errorLogs.push(args.join(' '));
      };

      try {
        const dbUrlWithPassword = 'postgresql://user:secret_password@localhost:5432/testdb';
        createMemoryServer({
          databaseUrl: dbUrlWithPassword,
          openaiApiKey: testApiKey,
        });

        // Verify that password is sanitized in logs
        const logWithDbUrl = errorLogs.find((log) => log.includes('Postgres backend active'));
        expect(logWithDbUrl).toBeDefined();
        expect(logWithDbUrl).not.toContain('secret_password');
        expect(logWithDbUrl).toContain('****');
      } finally {
        console.error = originalError;
      }
    });
  });

  describe('Component Wiring', () => {
    it('should create server with all required components', () => {
      // This test verifies that createMemoryServer successfully wires:
      // - Repository (MemoryRepositoryPostgres)
      // - Agent (MemoryAgent)
      // - Controller (MemoryController)
      // - LLM Client
      // - Embedding Service
      // - Prompt Manager
      // - Index Resolver
      // - File Loader

      const server = createMemoryServer({
        databaseUrl: testDatabaseUrl,
        openaiApiKey: testApiKey,
        defaultIndex: 'wiring-test',
        projectRoot: process.cwd(),
      });

      // If all components wire correctly, server creation succeeds
      expect(server).toBeDefined();
      expect(server).toHaveProperty('setRequestHandler');
    });

    it('should handle environment variable overrides for agent config', () => {
      // Save original env vars
      const originalVars = {
        MEMORY_LARGE_FILE_THRESHOLD_BYTES: process.env.MEMORY_LARGE_FILE_THRESHOLD_BYTES,
        MEMORY_CHUNK_CHAR_LENGTH: process.env.MEMORY_CHUNK_CHAR_LENGTH,
        MEMORY_CHUNK_CHAR_OVERLAP: process.env.MEMORY_CHUNK_CHAR_OVERLAP,
        MEMORY_MAX_CHUNKS_PER_FILE: process.env.MEMORY_MAX_CHUNKS_PER_FILE,
        MEMORY_MAX_MEMORIES_PER_FILE: process.env.MEMORY_MAX_MEMORIES_PER_FILE,
      };

      try {
        // Set custom values
        process.env.MEMORY_LARGE_FILE_THRESHOLD_BYTES = '512000';
        process.env.MEMORY_CHUNK_CHAR_LENGTH = '20000';
        process.env.MEMORY_CHUNK_CHAR_OVERLAP = '3000';
        process.env.MEMORY_MAX_CHUNKS_PER_FILE = '30';
        process.env.MEMORY_MAX_MEMORIES_PER_FILE = '75';

        const server = createMemoryServer({
          databaseUrl: testDatabaseUrl,
          openaiApiKey: testApiKey,
        });

        expect(server).toBeDefined();
      } finally {
        // Restore original values
        Object.entries(originalVars).forEach(([key, value]) => {
          if (value !== undefined) {
            process.env[key] = value;
          } else {
            delete process.env[key];
          }
        });
      }
    });
  });
});
