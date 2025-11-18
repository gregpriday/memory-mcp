import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import { config } from 'dotenv';
import { TestServerHarness } from './helpers/TestServerHarness.js';
import { FakeEmbeddingService } from './helpers/FakeEmbeddingService.js';

// Load environment variables
config();

describe('Scan Memories Integration Tests', () => {
  let harness: TestServerHarness;
  const testProjectId = 'scan-memories-test';
  const testIndexPrefix = 'scan-test-';

  before(async () => {
    // Get database URL from environment
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL not set in test environment');
    }

    // Create harness with fake embedding service for deterministic tests
    harness = new TestServerHarness(databaseUrl, testProjectId, {
      embeddingService: new FakeEmbeddingService(1536),
    });

    // Clean up any existing test data from previous runs
    await harness.cleanupTestMemories(testIndexPrefix);
    await harness.cleanupTestIndexes(testIndexPrefix);
  });

  afterEach(async () => {
    // Clean up after each test for better isolation
    if (harness) {
      await harness.cleanupTestMemories(testIndexPrefix);
      await harness.cleanupTestIndexes(testIndexPrefix);
    }
  });

  after(async () => {
    // Final cleanup and close connections
    if (harness) {
      await harness.cleanupTestMemories(testIndexPrefix);
      await harness.cleanupTestIndexes(testIndexPrefix);
      await harness.close();
    }
  });

  it('should return all stored memories with metadata', async () => {
    const indexName = `${testIndexPrefix}${Date.now()}-all-memories`;
    const timestamp = new Date().toISOString();

    // Create index first
    await harness.callCreateIndex(indexName, 'Test index for scanning all memories');

    // Seed multiple memories with varied metadata
    const memories = [
      {
        text: 'First memory about TypeScript development',
        metadata: {
          source: 'user',
          timestamp,
          topic: 'development',
          importance: 'high',
        },
      },
      {
        text: 'Second memory about testing strategies',
        metadata: {
          source: 'user',
          timestamp,
          topic: 'testing',
          importance: 'medium',
        },
      },
      {
        text: 'Third memory about database optimization',
        metadata: {
          source: 'system',
          timestamp,
          topic: 'database',
          importance: 'high',
        },
      },
    ];

    const memoryIds = await harness.repository.upsertMemories(indexName, memories, {});

    // Verify memories were inserted
    assert.strictEqual(memoryIds.length, 3, 'Should insert 3 memories');

    // Call scan operation
    const result = await harness.callScanMemories({
      query: 'development testing database',
      index: indexName,
    });

    // Verify result structure
    assert.strictEqual(result.status, 'ok', 'Scan should succeed');
    assert.strictEqual(result.index, indexName, 'Should return correct index name');
    assert.ok(Array.isArray(result.results), 'Results should be an array');
    assert.strictEqual(result.results!.length, 3, 'Should return all 3 memories');
    assert.strictEqual(result.searchStatus, 'results', 'Search status should be "results"');

    // Verify all inserted memory IDs are in results
    const resultIds = result.results!.map((r) => r.id);
    for (const memoryId of memoryIds) {
      assert.ok(resultIds.includes(memoryId), `Result should include memory ID ${memoryId}`);
    }

    // Verify metadata is included in results
    for (const memory of result.results!) {
      assert.ok(memory.metadata, 'Each result should include metadata');
      assert.ok(memory.metadata!.source, 'Metadata should include source field');
      assert.ok(memory.metadata!.timestamp, 'Metadata should include timestamp field');
      assert.ok(memory.metadata!.topic, 'Metadata should include topic field');
      assert.ok(memory.metadata!.importance, 'Metadata should include importance field');
    }

    // Verify content is included
    for (const memory of result.results!) {
      assert.ok(memory.content, 'Each result should include content');
    }

    // Verify diagnostics are present
    assert.ok(result.diagnostics, 'Result should include diagnostics');
    assert.ok(result.diagnostics!.length > 0, 'Should have at least one diagnostic entry');
  });

  it('should handle empty index gracefully', async () => {
    const indexName = `${testIndexPrefix}${Date.now()}-empty`;

    // Create index but don't add any memories
    await harness.callCreateIndex(indexName, 'Empty test index');

    // Call scan on empty index
    const result = await harness.callScanMemories({
      query: 'any query text',
      index: indexName,
    });

    // Verify result structure
    assert.strictEqual(result.status, 'ok', 'Scan should succeed on empty index');
    assert.strictEqual(result.index, indexName, 'Should return correct index name');
    assert.ok(Array.isArray(result.results), 'Results should be an array');
    assert.strictEqual(result.results!.length, 0, 'Should return empty results array');
    assert.strictEqual(
      result.searchStatus,
      'no_results',
      'Search status should be "no_results" for empty index'
    );

    // Verify diagnostics mention the query
    assert.ok(result.diagnostics, 'Should include diagnostics even for empty results');
  });

  it('should respect limit parameter for pagination', async () => {
    const indexName = `${testIndexPrefix}${Date.now()}-pagination`;
    const timestamp = new Date().toISOString();

    // Create index
    await harness.callCreateIndex(indexName, 'Test index for pagination');

    // NOTE: Current implementation uses limit-based pagination without offset/cursor support.
    // Clients can paginate by adjusting limit and re-running scans, but there's no cursor
    // to ensure consistent ordering across calls or to skip previously seen results.
    // This test validates that limit parameter works correctly for basic pagination needs.

    // Seed 5 memories
    const memories = [
      {
        text: 'Memory one about React',
        metadata: { source: 'user', timestamp, topic: 'react' },
      },
      {
        text: 'Memory two about Vue',
        metadata: { source: 'user', timestamp, topic: 'vue' },
      },
      {
        text: 'Memory three about Angular',
        metadata: { source: 'user', timestamp, topic: 'angular' },
      },
      {
        text: 'Memory four about Svelte',
        metadata: { source: 'user', timestamp, topic: 'svelte' },
      },
      {
        text: 'Memory five about Next.js',
        metadata: { source: 'user', timestamp, topic: 'nextjs' },
      },
    ];

    const memoryIds = await harness.repository.upsertMemories(indexName, memories, {});
    assert.strictEqual(memoryIds.length, 5, 'Should insert 5 memories');

    // Call scan with limit of 2
    const limitedResult = await harness.callScanMemories({
      query: 'React Vue Angular Svelte Next.js',
      index: indexName,
      limit: 2,
    });

    // Verify only 2 results returned
    assert.strictEqual(limitedResult.status, 'ok', 'Scan with limit should succeed');
    assert.strictEqual(
      limitedResult.results!.length,
      2,
      'Should return exactly 2 memories when limit is 2'
    );

    // Call scan with higher limit to get all results
    const fullResult = await harness.callScanMemories({
      query: 'React Vue Angular Svelte Next.js',
      index: indexName,
      limit: 10,
    });

    // Verify all 5 results returned
    assert.strictEqual(fullResult.status, 'ok', 'Scan with higher limit should succeed');
    assert.strictEqual(
      fullResult.results!.length,
      5,
      'Should return all 5 memories when limit is higher'
    );

    // Verify the IDs from limited results are subset of full results
    const limitedIds = limitedResult.results!.map((r) => r.id);
    const fullIds = fullResult.results!.map((r) => r.id);
    for (const limitedId of limitedIds) {
      assert.ok(fullIds.includes(limitedId), 'Limited result IDs should be subset of full results');
    }
  });

  it('should respect includeMetadata parameter', async () => {
    const indexName = `${testIndexPrefix}${Date.now()}-metadata-toggle`;
    const timestamp = new Date().toISOString();

    // Create index
    await harness.callCreateIndex(indexName, 'Test index for metadata toggle');

    // Seed memories with metadata
    const memories = [
      {
        text: 'Memory with metadata',
        metadata: {
          source: 'user',
          timestamp,
          topic: 'testing',
          importance: 'high',
        },
      },
      {
        text: 'Another memory with metadata',
        metadata: {
          source: 'system',
          timestamp,
          topic: 'validation',
          importance: 'medium',
        },
      },
    ];

    await harness.repository.upsertMemories(indexName, memories, {});

    // Call scan with includeMetadata: false
    const withoutMetadata = await harness.callScanMemories({
      query: 'metadata testing',
      index: indexName,
      includeMetadata: false,
    });

    // Verify results don't include metadata
    assert.strictEqual(withoutMetadata.status, 'ok', 'Scan should succeed');
    assert.ok(withoutMetadata.results!.length > 0, 'Should return results');
    for (const memory of withoutMetadata.results!) {
      assert.strictEqual(
        memory.metadata,
        undefined,
        'Results should not include metadata when includeMetadata is false'
      );
    }

    // Call scan with includeMetadata: true (explicit)
    const withMetadata = await harness.callScanMemories({
      query: 'metadata testing',
      index: indexName,
      includeMetadata: true,
    });

    // Verify results include metadata
    assert.strictEqual(withMetadata.status, 'ok', 'Scan should succeed');
    assert.ok(withMetadata.results!.length > 0, 'Should return results');
    for (const memory of withMetadata.results!) {
      assert.ok(memory.metadata, 'Results should include metadata when includeMetadata is true');
      assert.ok(memory.metadata!.source, 'Metadata should include source field');
      assert.ok(memory.metadata!.timestamp, 'Metadata should include timestamp field');
    }

    // Call scan with default (no includeMetadata parameter) - should include metadata by default
    const defaultBehavior = await harness.callScanMemories({
      query: 'metadata testing',
      index: indexName,
    });

    // Verify default behavior includes metadata
    assert.strictEqual(defaultBehavior.status, 'ok', 'Scan should succeed');
    assert.ok(defaultBehavior.results!.length > 0, 'Should return results');
    for (const memory of defaultBehavior.results!) {
      assert.ok(
        memory.metadata,
        'Results should include metadata by default (when parameter omitted)'
      );
    }
  });

  it('should provide diagnostics for scan operations', async () => {
    const indexName = `${testIndexPrefix}${Date.now()}-diagnostics`;
    const timestamp = new Date().toISOString();

    // Create index and add memories
    await harness.callCreateIndex(indexName, 'Test index for diagnostics');
    await harness.repository.upsertMemories(
      indexName,
      [
        {
          text: 'Test memory for diagnostics',
          metadata: { source: 'user', timestamp },
        },
      ],
      {}
    );

    // Call scan
    const result = await harness.callScanMemories({
      query: 'diagnostics test',
      index: indexName,
    });

    // Verify diagnostics are present and contain expected fields
    assert.ok(result.diagnostics, 'Result should include diagnostics');
    assert.ok(result.diagnostics!.length > 0, 'Should have at least one diagnostic entry');

    const diagnostic = result.diagnostics![0];
    assert.ok(diagnostic.query, 'Diagnostic should include query');
    assert.ok(typeof diagnostic.durationMs === 'number', 'Diagnostic should include duration');
    assert.ok(
      typeof diagnostic.semanticWeight === 'number',
      'Diagnostic should include semantic weight'
    );
    assert.ok(
      typeof diagnostic.reranking === 'boolean',
      'Diagnostic should include reranking flag'
    );
  });

  it('should handle multiple scans with consistent results', async () => {
    const indexName = `${testIndexPrefix}${Date.now()}-consistent`;
    const timestamp = new Date().toISOString();

    // Create index and seed memories
    await harness.callCreateIndex(indexName, 'Test index for consistency');
    const memories = [
      {
        text: 'Consistent memory one',
        metadata: { source: 'user', timestamp, topic: 'consistency' },
      },
      {
        text: 'Consistent memory two',
        metadata: { source: 'user', timestamp, topic: 'consistency' },
      },
    ];

    const memoryIds = await harness.repository.upsertMemories(indexName, memories, {});

    // Perform multiple scans with the same query
    const scan1 = await harness.callScanMemories({
      query: 'consistency test',
      index: indexName,
    });

    const scan2 = await harness.callScanMemories({
      query: 'consistency test',
      index: indexName,
    });

    // Verify both scans return the same memories
    assert.strictEqual(scan1.status, 'ok', 'First scan should succeed');
    assert.strictEqual(scan2.status, 'ok', 'Second scan should succeed');
    assert.strictEqual(
      scan1.results!.length,
      scan2.results!.length,
      'Both scans should return same number of results'
    );

    // Verify same IDs are returned (order may vary)
    const ids1 = scan1.results!.map((r) => r.id).sort();
    const ids2 = scan2.results!.map((r) => r.id).sort();
    assert.deepStrictEqual(ids1, ids2, 'Both scans should return the same memory IDs');

    // Verify returned IDs match inserted IDs
    const insertedIdsSorted = memoryIds.sort();
    assert.deepStrictEqual(
      ids1,
      insertedIdsSorted,
      'Scan results should match inserted memory IDs'
    );
  });

  it('should handle large number of memories with acceptable performance', async () => {
    const indexName = `${testIndexPrefix}${Date.now()}-performance`;
    const timestamp = new Date().toISOString();

    // Create index
    await harness.callCreateIndex(indexName, 'Performance test index');

    // Generate 100 memories to test performance with multiple memories
    const memories = Array.from({ length: 100 }, (_, i) => ({
      text: `Performance test memory ${i + 1} about topic ${i % 10}`,
      metadata: {
        source: 'user',
        timestamp,
        topic: `topic-${i % 10}`,
        index: i,
      },
    }));

    // Insert all memories
    const memoryIds = await harness.repository.upsertMemories(indexName, memories, {});
    assert.strictEqual(memoryIds.length, 100, 'Should insert 100 memories');

    // Scan all memories
    const startTime = Date.now();
    const result = await harness.callScanMemories({
      query: 'performance test topic',
      index: indexName,
      limit: 150, // Higher than count to get all
    });
    const duration = Date.now() - startTime;

    // Verify all memories returned
    assert.strictEqual(result.status, 'ok', 'Scan should succeed');
    assert.strictEqual(result.results!.length, 100, 'Should return all 100 memories');
    assert.strictEqual(result.searchStatus, 'results', 'Search status should be "results"');

    // Verify performance is acceptable (should complete in reasonable time)
    assert.ok(duration < 10000, `Scan should complete within 10 seconds (took ${duration}ms)`);

    // Verify all inserted IDs are in results
    const resultIds = result.results!.map((r) => r.id).sort();
    const insertedIdsSorted = memoryIds.sort();
    assert.deepStrictEqual(resultIds, insertedIdsSorted, 'All memory IDs should be returned');

    // Verify diagnostics don't report errors or retries
    assert.ok(result.diagnostics, 'Should include diagnostics');
    assert.strictEqual(result.diagnostics![0].retryCount, 0, 'Should not require retries');
  });

  it('should filter memories using filterExpression', async () => {
    const indexName = `${testIndexPrefix}${Date.now()}-filter`;
    const timestamp = new Date().toISOString();

    // Create index
    await harness.callCreateIndex(indexName, 'Filter test index');

    // Seed memories with varied metadata for filtering
    const memories = [
      {
        text: 'High priority development task',
        metadata: {
          source: 'user',
          timestamp,
          topic: 'development',
          importance: 'high',
          tags: ['urgent', 'backend'],
        },
      },
      {
        text: 'Low priority development task',
        metadata: {
          source: 'user',
          timestamp,
          topic: 'development',
          importance: 'low',
          tags: ['backend'],
        },
      },
      {
        text: 'High priority testing task',
        metadata: {
          source: 'system',
          timestamp,
          topic: 'testing',
          importance: 'high',
          tags: ['urgent', 'qa'],
        },
      },
    ];

    await harness.repository.upsertMemories(indexName, memories, {});

    // Scan with filter for high importance items
    const highImportanceResult = await harness.callScanMemories({
      query: 'task',
      index: indexName,
      filterExpression: '@metadata.importance == "high"',
    });

    // Verify only high importance memories returned
    assert.strictEqual(highImportanceResult.status, 'ok', 'Filtered scan should succeed');
    assert.strictEqual(
      highImportanceResult.results!.length,
      2,
      'Should return 2 high importance memories'
    );
    for (const memory of highImportanceResult.results!) {
      assert.strictEqual(
        memory.metadata!.importance,
        'high',
        'All results should have high importance'
      );
    }

    // Scan with filter for development topic
    const devTopicResult = await harness.callScanMemories({
      query: 'task',
      index: indexName,
      filterExpression: '@metadata.topic == "development"',
    });

    // Verify only development topic memories returned
    assert.strictEqual(devTopicResult.status, 'ok', 'Topic filtered scan should succeed');
    assert.strictEqual(
      devTopicResult.results!.length,
      2,
      'Should return 2 development topic memories'
    );
    for (const memory of devTopicResult.results!) {
      assert.strictEqual(
        memory.metadata!.topic,
        'development',
        'All results should have development topic'
      );
    }
  });

  it('should handle scan errors gracefully', async () => {
    const nonExistentIndex = `${testIndexPrefix}${Date.now()}-nonexistent`;

    // Attempt to scan a non-existent index
    const result = await harness.callScanMemories({
      query: 'test query',
      index: nonExistentIndex,
    });

    // Verify error handling
    // Note: The actual behavior depends on implementation - it may auto-create the index
    // or return an error. Either way, the call should not throw an exception.
    assert.ok(result.status, 'Should return a status');
    assert.ok(['ok', 'error'].includes(result.status), 'Status should be ok or error');

    // If it succeeds (auto-created), should have empty results
    if (result.status === 'ok') {
      assert.strictEqual(result.results!.length, 0, 'Non-existent index should have no results');
      assert.strictEqual(result.searchStatus, 'no_results', 'Search status should be "no_results"');
    }
  });

  it('should provide comprehensive diagnostics', async () => {
    const indexName = `${testIndexPrefix}${Date.now()}-diagnostics-full`;
    const timestamp = new Date().toISOString();

    // Create index and add memories
    await harness.callCreateIndex(indexName, 'Comprehensive diagnostics test');
    await harness.repository.upsertMemories(
      indexName,
      [
        {
          text: 'Diagnostic test memory one',
          metadata: { source: 'user', timestamp },
        },
        {
          text: 'Diagnostic test memory two',
          metadata: { source: 'user', timestamp },
        },
      ],
      {}
    );

    // Call scan with specific parameters
    const result = await harness.callScanMemories({
      query: 'diagnostic test',
      index: indexName,
      limit: 10,
      semanticWeight: 0.7,
      reranking: false,
    });

    // Verify comprehensive diagnostics
    assert.ok(result.diagnostics, 'Should include diagnostics');
    assert.ok(result.diagnostics!.length > 0, 'Should have at least one diagnostic entry');

    const diagnostic = result.diagnostics![0];

    // Verify all diagnostic fields
    assert.strictEqual(diagnostic.query, 'diagnostic test', 'Diagnostic should include query');
    assert.ok(typeof diagnostic.durationMs === 'number', 'Diagnostic should include duration');
    assert.ok(diagnostic.durationMs >= 0, 'Duration should be non-negative');
    assert.strictEqual(
      diagnostic.semanticWeight,
      0.7,
      'Diagnostic should reflect requested semantic weight'
    );
    assert.strictEqual(diagnostic.reranking, false, 'Diagnostic should reflect reranking setting');
    assert.strictEqual(diagnostic.retryCount, 0, 'Should not have retries for successful scan');

    // Verify result metadata matches diagnostics
    assert.strictEqual(result.searchStatus, 'results', 'Search status should be "results"');
    assert.strictEqual(result.results!.length, 2, 'Should return both memories');
  });
});
