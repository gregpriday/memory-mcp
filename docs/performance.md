# Performance Benchmarks and Optimization Guide

This document describes the performance characteristics of the Memory MCP vector search system and provides guidance for optimizing large-scale deployments.

## Overview

The Memory MCP server uses PostgreSQL with the pgvector extension for semantic memory storage and retrieval. Performance characteristics vary significantly based on:

- **Dataset size**: Number of memories stored
- **Filter complexity**: Use of metadata filters in queries
- **Index configuration**: IVFFlat parameters (lists, probes)
- **Hardware resources**: CPU, memory, disk I/O

## Benchmarking Tool

### Quick Start

Run the benchmark script to establish performance baselines:

```bash
# Basic benchmark with default sizes (100, 1K, 10K, 100K)
npm run benchmark:search

# Custom dataset sizes
npm run benchmark:search -- --sizes 100,1000,5000

# More iterations for statistical stability
npm run benchmark:search -- --iterations 20

# Skip filter benchmarks (faster)
npm run benchmark:search -- --no-filters
```

### CLI Options

| Option             | Description                     | Default                 |
| ------------------ | ------------------------------- | ----------------------- |
| `--sizes <list>`   | Comma-separated dataset sizes   | `100,1000,10000,100000` |
| `--iterations <n>` | Measured iterations per size    | `10`                    |
| `--warmup <n>`     | Warmup runs before measuring    | `2`                     |
| `--no-filters`     | Skip filtered search benchmarks | `false`                 |
| `--index <name>`   | Custom index name               | `benchmark-search`      |
| `--help, -h`       | Show help message               | -                       |

### Methodology

The benchmark script:

1. **Seeds deterministic data**: Uses `FakeEmbeddingService` to generate consistent 1536-dimension embeddings without OpenAI API calls
2. **Distributes metadata**: Creates balanced distributions of topics, importance levels, and types for realistic filtering
3. **Warms up caches**: Runs warmup queries to eliminate cold-start effects
4. **Measures timings**: Executes multiple iterations and calculates mean, median, and P95 latencies
5. **Compares configurations**: Benchmarks both unfiltered searches and filtered searches (using `@metadata.topic = "technology"`)

### Sample Output

```
📈 Benchmark Results

Unfiltered Search Performance:
┌─────────────┬──────────────┬──────────────┬──────────────┐
│ Dataset     │ Mean (ms)    │ Median (ms)  │ P95 (ms)     │
├─────────────┼──────────────┼──────────────┼──────────────┤
│ 100         │        15.20 │        14.50 │        18.00 │
│ 1,000       │        22.40 │        21.00 │        28.00 │
│ 10,000      │        45.80 │        43.00 │        56.00 │
│ 100,000     │       125.60 │       120.00 │       145.00 │
└─────────────┴──────────────┴──────────────┴──────────────┘

Filtered Search Performance:
┌─────────────┬──────────────┬──────────────┬──────────────┐
│ Dataset     │ Mean (ms)    │ Median (ms)  │ P95 (ms)     │
├─────────────┼──────────────┼──────────────┼──────────────┤
│ 100         │        18.50 │        17.00 │        22.00 │
│ 1,000       │        28.10 │        26.50 │        35.00 │
│ 10,000      │        58.90 │        55.00 │        72.00 │
│ 100,000     │       152.30 │       145.00 │       175.00 │
└─────────────┴──────────────┴──────────────┴──────────────┘

Filter Overhead:
┌─────────────┬──────────────┬──────────────┐
│ Dataset     │ Overhead (%) │ Overhead (ms)│
├─────────────┼──────────────┼──────────────┤
│ 100         │         21.7 │         3.30 │
│ 1,000       │         25.4 │         5.70 │
│ 10,000      │         28.6 │        13.10 │
│ 100,000     │         21.2 │        26.70 │
└─────────────┴──────────────┴──────────────┘
```

**Note**: These are example results. Actual performance depends on hardware, PostgreSQL configuration, and system load.

## IVFFlat Index Tuning

### What is IVFFlat?

IVFFlat (Inverted File with Flat Compression) is a vector indexing method used by pgvector:

- **Lists**: Number of partitions (clusters) used to organize vectors
- **Probes**: Number of lists searched during queries (recall vs speed trade-off)

Higher `lists` → longer index build time, potentially faster queries
Higher `probes` → slower queries, better recall accuracy

### Current Configuration

The default schema creates an IVFFlat index on the `embedding` column:

```sql
CREATE INDEX idx_memories_embedding_ivfflat
ON memories
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 1);
```

The default configuration sets `lists = 1`. For larger datasets, you should increase `lists` to approximately 1-2% of your row count for optimal performance.

### Tuning Recommendations

| Dataset Size | Recommended Lists            | Recommended Probes | Rationale                                         |
| ------------ | ---------------------------- | ------------------ | ------------------------------------------------- |
| < 10,000     | 100 (1-2% of rows)           | 1 (default)        | Overhead minimal, modest lists value sufficient   |
| 10K - 100K   | 100-2,000 (1-2% of rows)     | 5                  | Balanced build time and query performance         |
| 100K+        | 1,000-10,000 (1-2% of rows)  | 10                 | Large datasets benefit from granular partitioning |
| 1M+          | 10,000-20,000 (1-2% of rows) | 20                 | Enterprise scale requires aggressive tuning       |

**Rule of thumb**: Set `lists` to roughly 1-2% of your expected row count. This heuristic balances index build time with query performance.

### Manual Index Configuration

#### 1. Drop Existing Index

```sql
DROP INDEX IF EXISTS idx_memories_embedding_ivfflat;
```

#### 2. Create Index with Custom Parameters

```sql
-- For 10K-100K memories
CREATE INDEX idx_memories_embedding_ivfflat
ON memories
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- For 100K+ memories
CREATE INDEX idx_memories_embedding_ivfflat
ON memories
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 1000);
```

**Alternative: Modify existing index without dropping**

```sql
-- Alter lists parameter on existing index
ALTER INDEX idx_memories_embedding_ivfflat SET (lists = 1000);
-- Note: Requires REINDEX to take effect
REINDEX INDEX idx_memories_embedding_ivfflat;
```

#### 3. Set Probes at Query Time

```sql
-- Balance speed and recall for 10K-100K
SET ivfflat.probes = 5;

-- Better recall for 100K+
SET ivfflat.probes = 10;

-- Maximum recall (slowest)
SET ivfflat.probes = 20;
```

**Note**: The `ivfflat.probes` setting is session-specific. Set it in your application connection initialization.

### Maintenance Operations

#### VACUUM ANALYZE

After large data changes, update statistics and reclaim space:

```sql
VACUUM ANALYZE memories;
```

Run this:

- After bulk inserts/deletes
- Weekly for active datasets
- Before running performance benchmarks

#### REINDEX

If query performance degrades over time, rebuild the index:

```sql
REINDEX INDEX idx_memories_embedding_ivfflat;
```

**Warning**: This operation locks the table and can take significant time on large datasets. Schedule during maintenance windows.

## Performance Optimization Strategies

### 1. Connection Pooling

The `PoolManager` (src/memory/PoolManager.ts) maintains connection pools per project database. Default pool size is 10 connections.

For high-throughput scenarios, adjust pool size by editing `src/memory/PoolManager.ts`:

```typescript
// In PoolManager.ts constructor
max: 20,  // Maximum connections (default: 10)
```

**Note**: Pool size configuration is currently code-based and requires editing the source file.

### 2. Batch Operations

Always use batch upserts instead of individual inserts:

```typescript
// Good: Batch upsert
await repo.upsertMemories(indexName, memories);

// Bad: Individual upserts
for (const memory of memories) {
  await repo.upsertMemories(indexName, [memory]);
}
```

Batch operations:

- Reduce round trips to database
- Optimize embedding generation
- Improve transaction efficiency

### 3. Filter Optimization

Use indexed metadata fields when possible:

```typescript
// Indexed fields (fast)
@metadata.memoryType = "episodic"  // Note: use memoryType, not type
@metadata.importance = "high"
@metadata.topic = "technology"

// JSONB queries (slower but flexible)
@metadata.custom_field = "value"
```

### 4. Query Result Limits

Limit result counts appropriately:

```typescript
// Good for UI display
await repo.searchMemories(indexName, query, 10);

// Expensive for large result sets
await repo.searchMemories(indexName, query, 1000);
```

Larger result sets incur:

- More vector comparisons
- Higher network transfer
- Increased serialization overhead

### 5. Embedding Service Selection

Use `FakeEmbeddingService` for testing/development:

```typescript
// Development: Fast, deterministic, no API costs
const embeddingService = new FakeEmbeddingService(1536);

// Production: Real embeddings from OpenAI
const embeddingService = new OpenAIEmbeddingService(...);
```

## Scalability Considerations

### Horizontal Partitioning

For datasets exceeding 1M memories, consider:

1. **Per-project databases**: Already implemented via `config/projects.json`
2. **Index-based partitioning**: Separate databases per memory index
3. **Time-based partitioning**: Archive old memories to separate tables

### Vertical Scaling

Hardware recommendations for large deployments:

| Dataset Size | CPU Cores | RAM    | Storage          |
| ------------ | --------- | ------ | ---------------- |
| 10K-100K     | 4 cores   | 8 GB   | 50 GB SSD        |
| 100K-1M      | 8 cores   | 16 GB  | 200 GB SSD       |
| 1M+          | 16+ cores | 32+ GB | 500 GB+ NVMe SSD |

PostgreSQL-specific:

- Use SSDs for WAL and data directories
- Allocate 25% of RAM to `shared_buffers`
- Enable `effective_cache_size` to ~75% of total RAM

### Read Replicas

For read-heavy workloads:

1. Set up PostgreSQL streaming replication
2. Direct searches to read replicas
3. Direct upserts/deletes to primary

This reduces lock contention and distributes query load.

## Monitoring and Diagnostics

### Query Performance

The `SearchDiagnostics` object (returned via diagnosticsListener callback in `searchMemories`) provides:

```typescript
interface SearchDiagnostics {
  index: string;
  query: string;
  limit: number;
  semanticWeight: number;
  status: SearchStatus;
  resultCount: number;
  timestamp: string;
}
```

Use the diagnosticsListener callback to capture search metadata:

```typescript
await repo.searchMemories('index-name', 'query', {
  limit: 10,
  diagnosticsListener: (diag) => {
    console.log(`Search completed: ${diag.resultCount} results from ${diag.index}`);
  },
});
```

For detailed timing information, measure externally by wrapping searchMemories calls.

### Database Metrics

Monitor PostgreSQL stats:

```sql
-- Query performance
SELECT * FROM pg_stat_statements
WHERE query LIKE '%memories%'
ORDER BY total_exec_time DESC;

-- Index usage
SELECT * FROM pg_stat_user_indexes
WHERE indexrelname = 'idx_memories_embedding_ivfflat';

-- Table bloat
SELECT schemaname, tablename,
       pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE tablename = 'memories';
```

## Reproducibility

The benchmark script uses deterministic embeddings to ensure reproducible results:

1. **Fixed seed**: `FakeEmbeddingService` generates consistent vectors based on text content
2. **Clean slate**: Each dataset size starts with a cleared index
3. **Controlled metadata**: Predictable distribution of topics and importance levels

Re-running the benchmark on the same hardware should yield similar results (±5% variance from system load).

## Troubleshooting

### Slow Queries

**Symptoms**: Query latency > 500ms for < 100K memories

**Solutions**:

1. Check `pg_stat_statements` for query plans
2. Increase `ivfflat.probes` if recall is low
3. Decrease `ivfflat.probes` if speed is critical
4. Run `VACUUM ANALYZE` to update statistics
5. Consider `REINDEX` if index is fragmented

### Memory Pressure

**Symptoms**: PostgreSQL using excessive RAM, OOM errors

**Solutions**:

1. Reduce `shared_buffers` (default: 25% of RAM)
2. Limit connection pool size
3. Implement pagination for large result sets
4. Archive old memories to reduce working set

### Index Build Timeouts

**Symptoms**: `CREATE INDEX` fails or takes hours

**Solutions**:

1. Reduce `lists` parameter (fewer clusters = faster build)
2. Increase PostgreSQL `maintenance_work_mem`
3. Build index in batches (create empty index, insert data in chunks)
4. Schedule during low-traffic periods

## References

- [pgvector Documentation](https://github.com/pgvector/pgvector)
- [PostgreSQL Performance Tuning](https://www.postgresql.org/docs/current/performance-tips.html)
- [IVFFlat Index Internals](https://github.com/pgvector/pgvector#ivfflat)
- Memory MCP Architecture: `docs/ARCHITECTURE.md`
- Filter DSL Reference: `src/memory/postgres/FilterParser.ts`
