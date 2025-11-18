/**
 * Health Check Utilities
 *
 * Provides reusable health check functions for validating environment,
 * configuration, database connectivity, and schema integrity.
 */

import { existsSync } from 'fs';
import pg from 'pg';
import { loadEmbeddingConfig } from '../config/embedding.js';

export type HealthStatus = 'ok' | 'warn' | 'error';

export interface HealthCheckResult {
  checkId: string;
  label: string;
  status: HealthStatus;
  details?: string;
  hint?: string;
}

/**
 * Helper functions to create health check results
 */
export function ok(checkId: string, label: string, details?: string): HealthCheckResult {
  return { checkId, label, status: 'ok', details };
}

export function warn(
  checkId: string,
  label: string,
  details?: string,
  hint?: string
): HealthCheckResult {
  return { checkId, label, status: 'warn', details, hint };
}

export function error(
  checkId: string,
  label: string,
  details?: string,
  hint?: string
): HealthCheckResult {
  return { checkId, label, status: 'error', details, hint };
}

/**
 * Check if .env file exists and required environment variables are set
 */
export function checkEnv(projectRoot: string): HealthCheckResult[] {
  const results: HealthCheckResult[] = [];
  const envPath = `${projectRoot}/.env`;

  // Check .env existence (warn if missing, as env vars can be set elsewhere)
  if (!existsSync(envPath)) {
    results.push(
      warn(
        'env:file',
        '.env file',
        'Not found',
        'Create .env or ensure variables are set in your shell'
      )
    );
  } else {
    results.push(ok('env:file', '.env file', 'Found'));
  }

  // Check DATABASE_URL
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    results.push(
      error(
        'env:database-url',
        'DATABASE_URL',
        'Not set',
        'Set DATABASE_URL to a PostgreSQL connection string (postgresql://user:pass@host:port/database)'
      )
    );
  } else if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
    results.push(
      error(
        'env:database-url',
        'DATABASE_URL',
        'Invalid protocol',
        'DATABASE_URL must start with postgres:// or postgresql://'
      )
    );
  } else {
    // Censor password for display
    const censoredUrl = censorPassword(databaseUrl);
    results.push(ok('env:database-url', 'DATABASE_URL', censoredUrl));
  }

  // Check OpenAI API key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    results.push(
      warn(
        'env:openai-key',
        'OPENAI_API_KEY',
        'Not set',
        'Set OPENAI_API_KEY for LLM operations (DB-only operations will work)'
      )
    );
  } else {
    results.push(ok('env:openai-key', 'OPENAI_API_KEY', 'Set'));
  }

  // Check embedding dimensions if set
  const embeddingDims = process.env.MEMORY_EMBEDDING_DIMENSIONS?.trim();
  if (embeddingDims) {
    const parsed = Number(embeddingDims);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      results.push(
        error(
          'env:embedding-dims',
          'MEMORY_EMBEDDING_DIMENSIONS',
          `Invalid value: "${embeddingDims}"`,
          'Set MEMORY_EMBEDDING_DIMENSIONS to a positive integer or unset it'
        )
      );
    } else {
      results.push(ok('env:embedding-dims', 'MEMORY_EMBEDDING_DIMENSIONS', `${parsed}`));
    }
  }

  return results;
}

/**
 * Safely censor password in database URL
 */
function censorPassword(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) {
      url.password = '****';
    }
    return url.toString();
  } catch {
    // Fallback to regex if URL parsing fails
    return databaseUrl.replace(/:[^:]*@/, ':****@');
  }
}

/**
 * Check database connectivity
 */
export async function checkDbConnection(client: pg.Client): Promise<HealthCheckResult> {
  try {
    await client.connect();
    await client.query('SELECT 1 AS ok');

    // Extract user and database from client config
    const dbName = client.database;
    const user = client.user;

    return ok('db:connection', 'Database connection', `Connected as ${user} to ${dbName}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes('connect ECONNREFUSED')) {
      return error(
        'db:connection',
        'Database connection',
        'Connection refused',
        'PostgreSQL server is not running. Start it with: brew services start postgresql or docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16'
      );
    }

    if (message.includes('authentication failed') || message.includes('password')) {
      return error(
        'db:connection',
        'Database connection',
        'Authentication failed',
        'Check username/password in config/projects.json and database permissions'
      );
    }

    if (message.includes('database') && message.includes('does not exist')) {
      return error(
        'db:connection',
        'Database connection',
        'Database does not exist',
        'Run database setup: npm run db:setup'
      );
    }

    return error('db:connection', 'Database connection', message);
  }
}

/**
 * Check required PostgreSQL extensions
 */
export async function checkExtensions(client: pg.Client): Promise<HealthCheckResult> {
  try {
    const result = await client.query(`
      SELECT extname, extversion
      FROM pg_extension
      WHERE extname IN ('vector', 'pgcrypto')
      ORDER BY extname
    `);

    const foundExtensions = new Set(result.rows.map((row) => row.extname));
    const requiredExtensions = ['vector', 'pgcrypto'];
    const missingExtensions = requiredExtensions.filter((name) => !foundExtensions.has(name));

    if (missingExtensions.length > 0) {
      return error(
        'db:extensions',
        'Required extensions',
        `Missing: ${missingExtensions.join(', ')}`,
        'Run migrations to install extensions: npm run migrate'
      );
    }

    const versions = result.rows.map((row) => `${row.extname} (v${row.extversion})`).join(', ');
    return ok('db:extensions', 'Required extensions', versions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(
      'db:extensions',
      'Required extensions',
      `Query failed: ${message}`,
      'Check database permissions or schema access'
    );
  }
}

/**
 * Check core database tables
 */
export async function checkTables(client: pg.Client): Promise<HealthCheckResult> {
  try {
    const result = await client.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename IN ('memory_indexes', 'memories', 'memory_relationships', 'memory_usage_log')
      ORDER BY tablename
    `);

    const expectedTables = [
      'memory_indexes',
      'memories',
      'memory_relationships',
      'memory_usage_log',
    ];
    const foundTables = result.rows.map((r) => r.tablename);
    const missingTables = expectedTables.filter((name) => !foundTables.includes(name));

    if (missingTables.length > 0) {
      return error(
        'db:tables',
        'Core tables',
        `Missing: ${missingTables.join(', ')}`,
        'Run migrations: npm run migrate'
      );
    }

    return ok('db:tables', 'Core tables', foundTables.join(', '));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(
      'db:tables',
      'Core tables',
      `Query failed: ${message}`,
      'Check database permissions or schema access'
    );
  }
}

/**
 * Check embedding column and verify dimensions match config
 */
export async function checkEmbeddingColumn(client: pg.Client): Promise<HealthCheckResult> {
  try {
    // Check column exists
    const columnResult = await client.query(`
      SELECT column_name, udt_name
      FROM information_schema.columns
      WHERE table_name = 'memories'
      AND column_name = 'embedding'
    `);

    if (columnResult.rows.length === 0) {
      return error(
        'db:embedding-column',
        'Embedding column',
        'memories.embedding column not found',
        'Run migrations: npm run migrate'
      );
    }

    // Get full vector type with dimensions
    const typeResult = await client.query(`
      SELECT format_type(atttypid, atttypmod) as full_type
      FROM pg_type t
      JOIN pg_attribute a ON a.atttypid = t.oid
      WHERE a.attrelid = 'memories'::regclass
      AND a.attname = 'embedding'
    `);

    if (typeResult.rows.length === 0) {
      return error(
        'db:embedding-column',
        'Embedding column',
        'Could not determine column type',
        'Run migrations: npm run migrate'
      );
    }

    const fullType = typeResult.rows[0].full_type;
    const match = fullType.match(/vector\((\d+)\)/);

    if (!match) {
      return error(
        'db:embedding-column',
        'Embedding column',
        `Type is "${fullType}", expected vector(N)`,
        'Run migrations to create proper vector column'
      );
    }

    const dbDimensions = parseInt(match[1], 10);

    // Load and validate embedding config
    let configDimensions: number;
    try {
      const embeddingConfig = loadEmbeddingConfig();
      configDimensions = embeddingConfig.dimensions;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return error('db:embedding-column', 'Embedding dimensions', `Config error: ${message}`);
    }

    // Compare dimensions
    if (dbDimensions !== configDimensions) {
      return error(
        'db:embedding-column',
        'Embedding dimensions',
        `Database has vector(${dbDimensions}), config expects ${configDimensions}`,
        `Either set MEMORY_EMBEDDING_DIMENSIONS=${dbDimensions} or rerun migrations with desired dimension`
      );
    }

    return ok(
      'db:embedding-column',
      'Embedding dimensions',
      `Database vector(${dbDimensions}) matches config (${configDimensions})`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(
      'db:embedding-column',
      'Embedding column',
      `Query failed: ${message}`,
      'Check database permissions or schema access'
    );
  }
}

/**
 * Run all health checks
 */
export async function runHealthChecks(projectRoot: string): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  // Environment checks
  results.push(...checkEnv(projectRoot));

  // Get DATABASE_URL from environment
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    // Can't proceed without database URL - error already added by checkEnv
    return results;
  }

  // Validate URL format
  if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
    // Error already added by checkEnv
    return results;
  }

  // Database checks
  const client = new pg.Client({
    connectionString: databaseUrl,
  });

  try {
    // Connection check
    const connectionCheck = await checkDbConnection(client);
    results.push(connectionCheck);

    if (connectionCheck.status === 'error') {
      // Can't proceed without connection
      return results;
    }

    // Extensions check
    results.push(await checkExtensions(client));

    // Tables check
    results.push(await checkTables(client));

    // Embedding column and dimensions check
    results.push(await checkEmbeddingColumn(client));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push(error('db:unknown', 'Database health', `Unexpected error: ${message}`));
  } finally {
    try {
      await client.end();
    } catch {
      // Ignore cleanup errors
    }
  }

  return results;
}
