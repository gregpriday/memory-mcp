#!/usr/bin/env tsx
/**
 * Performance Benchmark Script
 *
 * Establishes performance baseline for vector search operations across various memory counts.
 * Tests with/without filters and provides IVFFlat tuning guidance.
 *
 * Usage:
 *   npm run benchmark:search
 *   npm run benchmark:search -- --sizes 100,1000,10000
 *   npm run benchmark:search -- --iterations 20
 *   npm run benchmark:search -- --no-filters
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { MemoryRepositoryPostgres } from '../src/memory/MemoryRepositoryPostgres.js';
import { FakeEmbeddingService } from '../tests/helpers/FakeEmbeddingService.js';
import type { MemoryToUpsert } from '../src/memory/types.js';
import type { ProjectRegistry } from '../src/config/backend.js';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

/**
 * CLI configuration
 */
interface BenchmarkConfig {
  sizes: number[];
  iterations: number;
  warmupRuns: number;
  useFilters: boolean;
  indexName: string;
}

/**
 * Benchmark results for a single configuration
 */
interface BenchmarkResult {
  size: number;
  withFilter: boolean;
  timings: number[];
  resultCounts: number[];
  mean: number;
  median: number;
  p95: number;
}

/**
 * Parse CLI arguments
 */
function parseArgs(): BenchmarkConfig {
  const args = process.argv.slice(2);
  const config: BenchmarkConfig = {
    sizes: [100, 1000, 10000, 100000],
    iterations: 10,
    warmupRuns: 2,
    useFilters: true,
    indexName: 'benchmark-search',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--sizes' && i + 1 < args.length) {
      config.sizes = args[++i].split(',').map((s) => parseInt(s.trim(), 10));
    } else if (arg === '--iterations' && i + 1 < args.length) {
      config.iterations = parseInt(args[++i], 10);
    } else if (arg === '--warmup' && i + 1 < args.length) {
      config.warmupRuns = parseInt(args[++i], 10);
    } else if (arg === '--no-filters') {
      config.useFilters = false;
    } else if (arg === '--index' && i + 1 < args.length) {
      config.indexName = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  return config;
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
Performance Benchmark for Vector Search

Usage:
  npm run benchmark:search [options]

Options:
  --sizes <list>       Comma-separated list of dataset sizes (default: 100,1000,10000,100000)
  --iterations <n>     Number of measured iterations per configuration (default: 10)
  --warmup <n>         Number of warmup runs before measuring (default: 2)
  --no-filters         Skip filter benchmark (only run unfiltered searches)
  --index <name>       Index name to use (default: benchmark-search)
  --help, -h           Show this help message

Examples:
  npm run benchmark:search
  npm run benchmark:search -- --sizes 100,1000
  npm run benchmark:search -- --iterations 20 --warmup 5
  npm run benchmark:search -- --no-filters
  `);
}

/**
 * Load database configuration
 */
function loadDatabaseUrl(): string {
  const registryPath =
    process.env.MEMORY_POSTGRES_PROJECT_REGISTRY?.trim() ||
    join(projectRoot, 'config', 'projects.json');

  if (!existsSync(registryPath)) {
    throw new Error(
      `Project registry not found at ${registryPath}. Set MEMORY_POSTGRES_PROJECT_REGISTRY or create config/projects.json`
    );
  }

  let registry: ProjectRegistry;
  try {
    const content = readFileSync(registryPath, 'utf8');
    registry = JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(
        `Failed to parse project registry at ${registryPath}: ${err.message}. Please ensure the file contains valid JSON.`
      );
    }
    throw err;
  }

  const projectId = process.env.MEMORY_ACTIVE_PROJECT?.trim() || 'local';
  const config = registry[projectId];

  if (!config?.databaseUrl) {
    const projects = Object.keys(registry);
    throw new Error(
      `Project "${projectId}" not found in registry (available: ${projects.join(', ')}). Update MEMORY_ACTIVE_PROJECT or config/projects.json`
    );
  }

  return config.databaseUrl;
}

/**
 * Generate synthetic memories with metadata distribution
 */
function generateSyntheticMemories(count: number): MemoryToUpsert[] {
  const topics = ['technology', 'science', 'finance', 'health', 'education'];
  const importanceValues: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
  const types: Array<'self' | 'belief' | 'pattern' | 'episodic' | 'semantic'> = [
    'self',
    'belief',
    'pattern',
    'episodic',
    'semantic',
  ];

  const memories: MemoryToUpsert[] = [];

  for (let i = 0; i < count; i++) {
    const topic = topics[i % topics.length];
    const importance = importanceValues[i % importanceValues.length];
    const memoryType = types[i % types.length];

    memories.push({
      text: `Synthetic memory ${i + 1}: This is a ${memoryType} memory about ${topic} with ${importance} importance. ${generateLoremIpsum(20)}`,
      metadata: {
        topic,
        importance,
        memoryType,
        tags: [`tag-${i % 10}`, `category-${Math.floor(i / 100)}`],
      },
    });
  }

  return memories;
}

/**
 * Generate lorem ipsum filler text
 */
function generateLoremIpsum(wordCount: number): string {
  const words = [
    'lorem',
    'ipsum',
    'dolor',
    'sit',
    'amet',
    'consectetur',
    'adipiscing',
    'elit',
    'sed',
    'do',
    'eiusmod',
    'tempor',
    'incididunt',
    'ut',
    'labore',
    'et',
    'dolore',
    'magna',
    'aliqua',
  ];
  const result: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    result.push(words[i % words.length]);
  }
  return result.join(' ');
}

/**
 * Clear all memories from the benchmark index
 */
async function clearBenchmarkIndex(
  repo: MemoryRepositoryPostgres,
  indexName: string
): Promise<void> {
  // Get database info to find all memory IDs in this index
  const dbInfo = await repo.getDatabaseInfo();
  const indexInfo = dbInfo.indexes[indexName];

  if (indexInfo && indexInfo.documentCount > 0) {
    // Fetch all IDs and delete them (without metadata for efficiency)
    const memories = await repo.searchMemories(indexName, '', {
      limit: indexInfo.documentCount,
      includeMetadata: false,
    });
    const ids = memories.map((m) => m.id);

    if (ids.length > 0) {
      // Delete in chunks to avoid overwhelming PostgreSQL
      const chunkSize = 1000;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        await repo.deleteMemories(indexName, chunk);
      }
    }
  }
}

/**
 * Calculate statistics from timing array
 */
function calculateStats(timings: number[]): { mean: number; median: number; p95: number } {
  if (timings.length === 0) {
    return { mean: 0, median: 0, p95: 0 };
  }

  const sorted = [...timings].sort((a, b) => a - b);
  const mean = timings.reduce((sum, t) => sum + t, 0) / timings.length;

  // Proper median calculation for even and odd length arrays
  const median =
    sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];

  // P95 calculation with bounds checking
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  const p95 = sorted[Math.max(0, p95Index)];

  return { mean, median, p95 };
}

/**
 * Run benchmark for a specific configuration
 */
async function runBenchmark(
  repo: MemoryRepositoryPostgres,
  indexName: string,
  config: BenchmarkConfig,
  withFilter: boolean
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  for (const size of config.sizes) {
    console.log(`\n📊 Benchmarking with ${size.toLocaleString()} memories...`);

    // Clear and seed data
    console.log(`   Clearing existing data...`);
    await clearBenchmarkIndex(repo, indexName);

    console.log(`   Generating ${size.toLocaleString()} synthetic memories...`);
    const memories = generateSyntheticMemories(size);

    console.log(`   Upserting memories...`);
    const startUpsert = Date.now();
    // Batch upserts to avoid PostgreSQL parameter limit (65,535 parameters)
    // Each memory uses ~23 parameters, so limit to 2000 memories per batch
    const batchSize = 2000;
    for (let i = 0; i < memories.length; i += batchSize) {
      const batch = memories.slice(i, i + batchSize);
      await repo.upsertMemories(indexName, batch);
    }
    const upsertTime = Date.now() - startUpsert;
    console.log(`   ✓ Upsert completed in ${upsertTime}ms`);

    // Verify count
    const dbInfo = await repo.getDatabaseInfo();
    const indexInfo = dbInfo.indexes[indexName];
    console.log(`   ✓ Verified ${indexInfo?.documentCount || 0} memories in index`);

    // Warmup runs
    console.log(`   Running ${config.warmupRuns} warmup queries...`);
    const searchQuery = 'technology and science information';
    const filterExpression = withFilter ? '@metadata.topic = "technology"' : undefined;

    for (let i = 0; i < config.warmupRuns; i++) {
      await repo.searchMemories(indexName, searchQuery, {
        limit: 10,
        filterExpression,
      });
    }

    // Measured runs
    console.log(
      `   Running ${config.iterations} measured queries ${withFilter ? 'WITH filter' : 'WITHOUT filter'}...`
    );
    const timings: number[] = [];
    const resultCounts: number[] = [];

    for (let i = 0; i < config.iterations; i++) {
      const start = Date.now();
      const searchResults = await repo.searchMemories(indexName, searchQuery, {
        limit: 10,
        filterExpression,
      });
      const elapsed = Date.now() - start;

      timings.push(elapsed);
      resultCounts.push(searchResults.length);
    }

    const stats = calculateStats(timings);
    results.push({
      size,
      withFilter,
      timings,
      resultCounts,
      ...stats,
    });

    console.log(`   ✓ Mean: ${stats.mean.toFixed(2)}ms`);
    console.log(`   ✓ Median: ${stats.median.toFixed(2)}ms`);
    console.log(`   ✓ P95: ${stats.p95.toFixed(2)}ms`);
    const avgResults = resultCounts.reduce((sum, count) => sum + count, 0) / resultCounts.length;
    console.log(`   ✓ Results returned: ${avgResults.toFixed(1)} (avg)`);
  }

  return results;
}

/**
 * Print results table
 */
function printResultsTable(
  unfilteredResults: BenchmarkResult[],
  filteredResults: BenchmarkResult[]
): void {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📈 Benchmark Results');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  console.log('\nUnfiltered Search Performance:');
  console.log('┌─────────────┬──────────────┬──────────────┬──────────────┐');
  console.log('│ Dataset     │ Mean (ms)    │ Median (ms)  │ P95 (ms)     │');
  console.log('├─────────────┼──────────────┼──────────────┼──────────────┤');

  for (const result of unfilteredResults) {
    console.log(
      `│ ${result.size.toLocaleString().padEnd(11)} │ ${result.mean.toFixed(2).padStart(12)} │ ${result.median.toFixed(2).padStart(12)} │ ${result.p95.toFixed(2).padStart(12)} │`
    );
  }
  console.log('└─────────────┴──────────────┴──────────────┴──────────────┘');

  if (filteredResults.length > 0) {
    console.log('\nFiltered Search Performance:');
    console.log('┌─────────────┬──────────────┬──────────────┬──────────────┐');
    console.log('│ Dataset     │ Mean (ms)    │ Median (ms)  │ P95 (ms)     │');
    console.log('├─────────────┼──────────────┼──────────────┼──────────────┤');

    for (const result of filteredResults) {
      console.log(
        `│ ${result.size.toLocaleString().padEnd(11)} │ ${result.mean.toFixed(2).padStart(12)} │ ${result.median.toFixed(2).padStart(12)} │ ${result.p95.toFixed(2).padStart(12)} │`
      );
    }
    console.log('└─────────────┴──────────────┴──────────────┴──────────────┘');

    console.log('\nFilter Overhead:');
    console.log('┌─────────────┬──────────────┬──────────────┐');
    console.log('│ Dataset     │ Overhead (%) │ Overhead (ms)│');
    console.log('├─────────────┼──────────────┼──────────────┤');

    // Map filtered results by size for safe lookup
    const filteredBySize = new Map(filteredResults.map((r) => [r.size, r]));

    for (const unfiltered of unfilteredResults) {
      const filtered = filteredBySize.get(unfiltered.size);
      if (filtered) {
        const overheadMs = filtered.mean - unfiltered.mean;
        const overheadPercent = ((overheadMs / unfiltered.mean) * 100).toFixed(1);

        console.log(
          `│ ${unfiltered.size.toLocaleString().padEnd(11)} │ ${overheadPercent.padStart(12)} │ ${overheadMs.toFixed(2).padStart(12)} │`
        );
      }
    }
    console.log('└─────────────┴──────────────┴──────────────┘');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

/**
 * Print IVFFlat tuning recommendations
 */
function printTuningRecommendations(results: BenchmarkResult[]): void {
  console.log('\n💡 IVFFlat Tuning Recommendations\n');

  const maxSize = Math.max(...results.map((r) => r.size));

  console.log('Current index parameters:');
  console.log('  - lists: Determined by pgvector based on table size');
  console.log('  - probes: Defaults to 1 (number of lists searched)');

  console.log('\nRecommended tuning based on dataset size:');

  if (maxSize >= 100000) {
    console.log('  - For 100K+ memories: Consider lists=1000, probes=10');
    console.log('  - Large datasets benefit from more granular partitioning');
  } else if (maxSize >= 10000) {
    console.log('  - For 10K-100K memories: Consider lists=100, probes=5');
    console.log('  - Balanced trade-off between index build time and query speed');
  } else {
    console.log('  - For <10K memories: Default settings are sufficient');
    console.log('  - Index overhead is minimal at this scale');
  }

  console.log('\nTo manually tune IVFFlat parameters:');
  console.log('  1. Drop existing index: DROP INDEX IF EXISTS idx_memories_embedding_ivfflat;');
  console.log(
    '  2. Create with parameters: CREATE INDEX idx_memories_embedding_ivfflat ON memories'
  );
  console.log('     USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);');
  console.log('  3. Set probes at query time: SET ivfflat.probes = 5;');

  console.log('\nPerformance tips:');
  console.log('  - Higher lists = longer index build time, faster queries (diminishing returns)');
  console.log('  - Higher probes = slower queries, better recall accuracy');
  console.log('  - Run VACUUM ANALYZE after large data changes');
  console.log('  - Consider REINDEX if performance degrades over time');
}

/**
 * Main execution
 */
async function main() {
  console.log('🚀 Memory Search Performance Benchmark\n');

  const config = parseArgs();

  console.log('Configuration:');
  console.log(`  - Dataset sizes: ${config.sizes.map((s) => s.toLocaleString()).join(', ')}`);
  console.log(`  - Iterations per size: ${config.iterations}`);
  console.log(`  - Warmup runs: ${config.warmupRuns}`);
  console.log(`  - Filter benchmark: ${config.useFilters ? 'enabled' : 'disabled'}`);
  console.log(`  - Index name: ${config.indexName}`);

  // Load database configuration
  console.log('\n🔧 Loading database configuration...');
  const databaseUrl = loadDatabaseUrl();
  console.log(`   ✓ Database URL loaded`);

  // Initialize repository with fake embedding service
  const embeddingService = new FakeEmbeddingService(1536, 'fake-embedding-model');
  const repo = new MemoryRepositoryPostgres(databaseUrl, 'benchmark', embeddingService);
  console.log(`   ✓ Repository initialized with FakeEmbeddingService (deterministic)`);

  // Ensure index exists
  await repo.ensureIndex(config.indexName, 'Performance benchmark index');
  console.log(`   ✓ Index "${config.indexName}" ready`);

  // Run unfiltered benchmarks
  console.log('\n📍 Phase 1: Unfiltered Search Benchmarks');
  const unfilteredResults = await runBenchmark(repo, config.indexName, config, false);

  // Run filtered benchmarks
  let filteredResults: BenchmarkResult[] = [];
  if (config.useFilters) {
    console.log('\n📍 Phase 2: Filtered Search Benchmarks');
    filteredResults = await runBenchmark(repo, config.indexName, config, true);
  }

  // Print results
  printResultsTable(unfilteredResults, filteredResults);

  // Print tuning recommendations
  printTuningRecommendations(unfilteredResults);

  console.log('\n✅ Benchmark complete!\n');
}

// Run if executed directly
main().catch((err) => {
  console.error('\n❌ Benchmark failed:');

  if (err instanceof Error) {
    console.error('Message:', err.message);

    // Provide helpful hints for common errors
    if (err.message.includes('connect ECONNREFUSED')) {
      console.error('\n💡 Hint: PostgreSQL server is not running or not accessible.');
      console.error('   Please ensure PostgreSQL is installed and running.');
    } else if (err.message.includes('authentication failed') || err.message.includes('password')) {
      console.error('\n💡 Hint: Authentication failed.');
      console.error('   Check username and password in config/projects.json');
    } else if (err.message.includes('vector')) {
      console.error('\n💡 Hint: pgvector extension may not be installed.');
      console.error(
        '   Install it according to: https://github.com/pgvector/pgvector#installation'
      );
    } else if (err.message.includes('Project registry not found')) {
      console.error('\n💡 Hint: Configuration file missing.');
      console.error('   Create config/projects.json or set MEMORY_POSTGRES_PROJECT_REGISTRY');
    }
  } else {
    console.error(err);
  }

  process.exit(1);
});
