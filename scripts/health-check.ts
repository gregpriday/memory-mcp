#!/usr/bin/env tsx
/**
 * Health Check and Diagnostic Tool
 *
 * Validates environment configuration, database connectivity, and schema integrity.
 * Provides clear error messages and hints for common setup issues.
 *
 * Usage:
 *   npm run health
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runHealthChecks, type HealthCheckResult } from '../src/utils/healthCheck.js';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

/**
 * Print a single health check result
 */
function printResult(result: HealthCheckResult): void {
  const icon = result.status === 'ok' ? '✅' : result.status === 'warn' ? '⚠️ ' : '❌';
  const statusLabel = result.status.toUpperCase().padEnd(5);

  console.log(`${icon} [${statusLabel}] ${result.label}`);

  if (result.details) {
    console.log(`   ${result.details}`);
  }

  if (result.hint) {
    console.log(`   💡 ${result.hint}`);
  }
}

/**
 * Print summary statistics
 */
function printSummary(results: HealthCheckResult[]): void {
  const counts = {
    ok: results.filter((r) => r.status === 'ok').length,
    warn: results.filter((r) => r.status === 'warn').length,
    error: results.filter((r) => r.status === 'error').length,
  };

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 Summary');
  console.log(`   ✅ ${counts.ok} OK`);
  console.log(`   ⚠️  ${counts.warn} Warning(s)`);
  console.log(`   ❌ ${counts.error} Error(s)`);

  if (counts.error > 0) {
    console.log('\n❌ Health check FAILED');
    console.log('   Fix the errors above to ensure the system can run properly.');
  } else if (counts.warn > 0) {
    console.log('\n⚠️  Health check passed with warnings');
    console.log('   System may run, but some features might not work.');
  } else {
    console.log('\n✅ All health checks passed!');
    console.log('   System is ready to use.');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

/**
 * Main execution
 */
async function main() {
  console.log('🏥 Memory MCP Health Check\n');
  console.log('Running diagnostics...\n');

  const results = await runHealthChecks(projectRoot);

  // Print results
  for (const result of results) {
    printResult(result);
  }

  // Print summary
  printSummary(results);

  // Exit with appropriate code
  const hasErrors = results.some((r) => r.status === 'error');
  process.exit(hasErrors ? 1 : 0);
}

// Run if executed directly
main().catch((err) => {
  console.error('\n❌ Health check failed:');

  if (err instanceof Error) {
    console.error('Message:', err.message);

    // Provide helpful hints for common errors
    if (err.message.includes('connect ECONNREFUSED')) {
      console.error('\n💡 Hint: PostgreSQL server is not running or not accessible.');
      console.error('   Please ensure PostgreSQL is installed and running.');
      console.error('\n   On macOS:');
      console.error('   - Using Homebrew: brew services start postgresql');
      console.error('   - Using Postgres.app: Start the app');
      console.error(
        '   - Using Docker: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16'
      );
    } else if (err.message.includes('authentication failed') || err.message.includes('password')) {
      console.error('\n💡 Hint: Authentication failed.');
      console.error('   Check username and password in DATABASE_URL environment variable');
    } else if (err.message.includes('vector')) {
      console.error('\n💡 Hint: pgvector extension may not be installed.');
      console.error(
        '   Install it according to: https://github.com/pgvector/pgvector#installation'
      );
    } else if (err.message.includes('database') && err.message.includes('does not exist')) {
      console.error('\n💡 Hint: The database does not exist yet.');
      console.error('   Run: npm run db:setup');
    }
  } else {
    console.error(err);
  }

  process.exit(1);
});
