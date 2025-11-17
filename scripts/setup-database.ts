#!/usr/bin/env tsx
/**
 * Database Setup Script
 *
 * Creates the PostgreSQL database if it doesn't exist.
 * This script connects to the 'postgres' maintenance database to create the target database.
 *
 * Usage:
 *   npm run db:setup
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Client } = pg;

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Load config
const configPath = join(projectRoot, 'config', 'projects.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

// Get database URL from config (default to 'local' project)
const projectId = process.env.MEMORY_ACTIVE_PROJECT || 'local';
const databaseUrl = config[projectId]?.databaseUrl;

if (!databaseUrl) {
  console.error(`❌ No database URL found for project "${projectId}" in config/projects.json`);
  process.exit(1);
}

/**
 * Parse database URL to extract components
 */
function parseDatabaseUrl(url: string) {
  const urlObj = new URL(url);
  return {
    host: urlObj.hostname,
    port: urlObj.port || '5432',
    user: urlObj.username,
    password: urlObj.password,
    database: urlObj.pathname.slice(1), // Remove leading '/'
  };
}

/**
 * Main execution
 */
async function main() {
  console.log(`🚀 Database Setup Script`);
  console.log(`   Project: ${projectId}\n`);

  const dbConfig = parseDatabaseUrl(databaseUrl);
  console.log(`📋 Database configuration:`);
  console.log(`   Host: ${dbConfig.host}`);
  console.log(`   Port: ${dbConfig.port}`);
  console.log(`   User: ${dbConfig.user}`);
  console.log(`   Database: ${dbConfig.database}\n`);

  // Connect to 'postgres' maintenance database
  const maintenanceUrl = `postgresql://${encodeURIComponent(dbConfig.user)}:${encodeURIComponent(
    dbConfig.password
  )}@${dbConfig.host}:${dbConfig.port}/postgres`;
  const client = new Client({
    connectionString: maintenanceUrl,
  });

  try {
    console.log('🔌 Connecting to PostgreSQL server...');
    await client.connect();
    console.log('✅ Connected!\n');

    // Check if database already exists
    const checkResult = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
      dbConfig.database,
    ]);

    if (checkResult.rows.length > 0) {
      console.log(`ℹ️  Database "${dbConfig.database}" already exists.`);
      console.log('   No action needed.\n');
    } else {
      console.log(`📝 Creating database "${dbConfig.database}"...`);
      const databaseIdentifier = `"${dbConfig.database.replace(/"/g, '""')}"`;
      await client.query(`CREATE DATABASE ${databaseIdentifier}`);
      console.log(`✅ Database "${dbConfig.database}" created successfully!\n`);
    }

    console.log('🎉 Database setup complete!\n');
    console.log('Next steps:');
    console.log('  1. Run migrations: npm run migrate');
    console.log('  2. (Optional) Load seed data: npm run migrate:seed');
    console.log('  3. Verify schema: npm run migrate:verify\n');
  } catch (error) {
    console.error('\n❌ Database setup failed:', error);

    if (error instanceof Error) {
      console.error('Message:', error.message);

      // Provide helpful hints for common errors
      if (error.message.includes('connect ECONNREFUSED')) {
        console.error('\n💡 Hint: PostgreSQL server is not running or not accessible.');
        console.error('   Please ensure PostgreSQL is installed and running.');
        console.error('\n   On macOS:');
        console.error('   - Using Homebrew: brew services start postgresql');
        console.error('   - Using Postgres.app: Start the app');
        console.error(
          '   - Using Docker: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16'
        );
      } else if (
        error.message.includes('authentication failed') ||
        error.message.includes('password')
      ) {
        console.error('\n💡 Hint: Authentication failed.');
        console.error('   Check username and password in config/projects.json');
      } else if (error.message.includes('permission denied to create database')) {
        console.error('\n💡 Hint: User does not have permission to create databases.');
        console.error('   Grant the user createdb permission or use a superuser account.');
      }
    }

    process.exit(1);
  } finally {
    await client.end();
  }
}

// Run if executed directly
main();
