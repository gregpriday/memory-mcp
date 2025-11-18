#!/usr/bin/env tsx
/**
 * Database Migration Runner
 *
 * Runs PostgreSQL migrations programmatically using node-postgres.
 * This script provides an alternative to psql for running migrations.
 *
 * Usage:
 *   npm run migrate          - Run main schema migration
 *   npm run migrate:seed     - Run optional seed data (run migrate first)
 *   npm run migrate:verify   - Verify schema was created correctly
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

// Get database URL from environment
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('❌ DATABASE_URL environment variable is not set');
  console.error('   Set DATABASE_URL to a PostgreSQL connection string like:');
  console.error('   postgresql://user:password@host:port/database');
  process.exit(1);
}

if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
  console.error('❌ DATABASE_URL must be a PostgreSQL connection string');
  console.error('   It should start with postgres:// or postgresql://');
  process.exit(1);
}

/**
 * Run a SQL file against the database
 */
async function runSqlFile(client: pg.Client, filePath: string): Promise<void> {
  const absolutePath = join(projectRoot, filePath);
  console.log(`📄 Reading: ${filePath}`);

  const sql = readFileSync(absolutePath, 'utf-8');

  console.log(`🔄 Executing SQL...`);
  await client.query(sql);
  console.log(`✅ Successfully executed: ${filePath}`);
}

/**
 * Verify the schema was created correctly
 */
async function verifySchema(client: pg.Client): Promise<void> {
  console.log('\n🔍 Verifying schema...\n');

  // Check extensions
  console.log('📦 Extensions:');
  const extensions = await client.query(`
    SELECT extname, extversion
    FROM pg_extension
    WHERE extname IN ('vector', 'pgcrypto')
    ORDER BY extname
  `);

  const foundExtensions = new Set(extensions.rows.map((row) => row.extname));
  const missingExtensions = ['vector', 'pgcrypto'].filter((name) => !foundExtensions.has(name));
  if (missingExtensions.length > 0) {
    throw new Error(`❌ Missing required extensions: ${missingExtensions.join(', ')}`);
  }

  extensions.rows.forEach((row) => {
    console.log(`   ✓ ${row.extname} (v${row.extversion})`);
  });

  // Check tables
  console.log('\n📊 Tables:');
  const tables = await client.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    AND tablename IN ('memory_indexes', 'memories', 'memory_relationships', 'memory_usage_log')
    ORDER BY tablename
  `);

  const expectedTables = ['memory_indexes', 'memories', 'memory_relationships', 'memory_usage_log'];
  const foundTables = tables.rows.map((r) => r.tablename);

  expectedTables.forEach((table) => {
    if (foundTables.includes(table)) {
      console.log(`   ✓ ${table}`);
    } else {
      console.log(`   ✗ ${table} (MISSING)`);
    }
  });

  if (foundTables.length !== expectedTables.length) {
    throw new Error(`❌ Expected ${expectedTables.length} tables, found ${foundTables.length}`);
  }

  // Check vector column on memories
  console.log('\n🔢 Vector column:');
  const vectorColumn = await client.query(`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_name = 'memories'
    AND column_name = 'embedding'
  `);

  if (vectorColumn.rows.length === 0) {
    throw new Error('❌ embedding column not found on memories table');
  }

  const col = vectorColumn.rows[0];
  console.log(`   ✓ memories.embedding type: ${col.udt_name}`);

  // Verify it's vector(1536)
  const vectorDim = await client.query(`
    SELECT
      typname,
      format_type(atttypid, atttypmod) as full_type
    FROM pg_type t
    JOIN pg_attribute a ON a.atttypid = t.oid
    WHERE a.attrelid = 'memories'::regclass
    AND a.attname = 'embedding'
  `);

  if (vectorDim.rows.length === 0) {
    throw new Error('❌ Could not verify vector dimension');
  }

  const vecType = vectorDim.rows[0];
  if (vecType.typname !== 'vector') {
    throw new Error(`❌ embedding column is not a vector type (found: ${vecType.typname})`);
  }

  if (!vecType.full_type.includes('1536')) {
    throw new Error(`❌ embedding vector dimension is not 1536 (found: ${vecType.full_type})`);
  }

  console.log(`   ✓ Dimension: vector(1536)`);

  // Check indexes
  console.log('\n🗂️  Indexes:');
  const indexes = await client.query(`
    SELECT
      indexname,
      indexdef
    FROM pg_indexes
    WHERE tablename = 'memories'
    ORDER BY indexname
  `);

  const foundIndexes = new Set(indexes.rows.map((r) => r.indexname));

  // Required indexes from migration
  const requiredIndexes = [
    'idx_memories_embedding_ivfflat',
    'idx_memories_index',
    'idx_memories_type_topic',
    'idx_memories_importance_priority',
    'idx_memories_recency',
    'idx_memories_last_accessed',
    'idx_memories_active_priority',
    'idx_memories_tags',
    'idx_memories_priority_recency',
  ];

  const missingIndexes = requiredIndexes.filter((idx) => !foundIndexes.has(idx));

  if (missingIndexes.length > 0) {
    throw new Error(`❌ Missing required indexes: ${missingIndexes.join(', ')}`);
  }

  // Verify IVFFlat index specifically
  const ivfFlatIndex = indexes.rows.find((r) => r.indexname === 'idx_memories_embedding_ivfflat');
  if (ivfFlatIndex && ivfFlatIndex.indexdef.includes('ivfflat')) {
    console.log(`   ✓ ${ivfFlatIndex.indexname} (IVFFlat index)`);
    console.log(`     Method: ivfflat ✓`);
  } else {
    throw new Error('❌ IVFFlat index configuration incorrect');
  }

  // Show other critical indexes
  const criticalIndexes = [
    'idx_memories_tags',
    'idx_memories_active_priority',
    'idx_memories_priority_recency',
  ];
  criticalIndexes.forEach((idxName) => {
    if (foundIndexes.has(idxName)) {
      console.log(`   ✓ ${idxName}`);
    }
  });

  // Check trigger
  console.log('\n⚡ Triggers:');
  const triggers = await client.query(`
    SELECT trigger_name, event_manipulation, action_statement
    FROM information_schema.triggers
    WHERE event_object_table = 'memories'
    AND trigger_name = 'memories_updated_at'
  `);

  if (triggers.rows.length > 0) {
    console.log(`   ✓ memories_updated_at trigger exists`);
  } else {
    throw new Error(
      `❌ memories_updated_at trigger NOT FOUND - trigger is required for automatic updated_at maintenance`
    );
  }

  // Check default data
  console.log('\n📝 Default data:');
  const defaultIndex = await client.query(`
    SELECT project, name, description
    FROM memory_indexes
    WHERE project = 'default' AND name = 'memory'
  `);

  if (defaultIndex.rows.length === 0) {
    throw new Error(`❌ Default 'memory' index not found - migration may have failed`);
  }

  console.log(`   ✓ Default 'memory' index created`);
  console.log(`     Project: ${defaultIndex.rows[0].project}`);
  console.log(`     Name: ${defaultIndex.rows[0].name}`);

  console.log('\n✅ Schema verification complete!\n');
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'migrate';

  console.log(`🚀 Database Migration Runner`);
  console.log(`   Database: ${databaseUrl.replace(/:[^:]*@/, ':****@')}\n`); // Hide password

  const client = new Client({
    connectionString: databaseUrl,
  });

  try {
    console.log('🔌 Connecting to database...');
    await client.connect();
    console.log('✅ Connected!\n');

    switch (command) {
      case 'migrate':
        await runSqlFile(client, 'migrations/20250117000001_init_postgres_schema.sql');
        await verifySchema(client);
        break;

      case 'seed':
        // Only run seed data (assumes migration already ran)
        await runSqlFile(client, 'migrations/seeds/01_test_data.sql');
        console.log('✅ Seed data loaded!');
        break;

      case 'verify':
        await verifySchema(client);
        break;

      default:
        console.error(`❌ Unknown command: ${command}`);
        console.log('\nAvailable commands:');
        console.log('  migrate  - Run main schema migration');
        console.log('  seed     - Run seed data (migration must be run first)');
        console.log('  verify   - Verify schema');
        process.exit(1);
    }

    console.log('🎉 All done!\n');
  } catch (error) {
    console.error('\n❌ Migration failed:', error);

    if (error instanceof Error) {
      console.error('Message:', error.message);

      // Provide helpful hints for common errors
      if (error.message.includes('connect ECONNREFUSED')) {
        console.error('\n💡 Hint: PostgreSQL server is not running or not accessible.');
        console.error('   Please ensure PostgreSQL is installed and running.');
      } else if (error.message.includes('database') && error.message.includes('does not exist')) {
        console.error('\n💡 Hint: The database does not exist yet.');
        console.error('   Create it with: createdb memory_local');
      } else if (error.message.includes('vector')) {
        console.error('\n💡 Hint: pgvector extension may not be installed.');
        console.error(
          '   Install it according to: https://github.com/pgvector/pgvector#installation'
        );
      }
    }

    process.exit(1);
  } finally {
    await client.end();
  }
}

// Run if executed directly
main();
