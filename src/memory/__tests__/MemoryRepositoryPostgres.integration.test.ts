import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { Pool } from 'pg';
import { MemoryRepositoryPostgres } from '../MemoryRepositoryPostgres.js';
import { PoolManager } from '../PoolManager.js';
import { loadBackendConfig } from '../../config/backend.js';
import { FakeEmbeddingService } from '../../../tests/helpers/FakeEmbeddingService.js';
import type { MemoryToUpsert, MemoryMetadata, Importance } from '../types.js';

/**
 * Integration tests for MemoryRepositoryPostgres
 *
 * These tests run against a real Postgres database configured in config/projects.test.json.
 * Database must be running on localhost:5433 with pgvector extension installed.
 *
 * Tests are isolated via the 'test' projectId and clean up after themselves.
 */

const TEST_PROJECT_ID = 'postgres-repo-int';
const TEST_INDEX = 'integration-test-index';

describe('MemoryRepositoryPostgres Integration Tests', () => {
  let repository: MemoryRepositoryPostgres;
  let testPool: Pool;
  let databaseUrl: string;
  let embeddingService: FakeEmbeddingService;

  /**
   * Reset test database by deleting all test data
   */
  async function resetDatabase(): Promise<void> {
    await testPool.query('DELETE FROM memory_relationships WHERE project = $1', [TEST_PROJECT_ID]);
    await testPool.query('DELETE FROM memories WHERE project = $1', [TEST_PROJECT_ID]);
    await testPool.query('DELETE FROM memory_indexes WHERE project = $1', [TEST_PROJECT_ID]);
  }

  /**
   * Helper to create a memory for upserting
   */
  function makeMemory(text: string, metadata?: Partial<MemoryMetadata>): MemoryToUpsert {
    return {
      text,
      metadata,
    };
  }

  /**
   * Helper to query memories directly from the database
   */
  async function getMemoryFromDb(id: string): Promise<unknown> {
    const result = await testPool.query('SELECT * FROM memories WHERE id = $1 AND project = $2', [
      id,
      TEST_PROJECT_ID,
    ]);
    return result.rows[0] || null;
  }

  /**
   * Helper to count relationships in database
   */
  async function countRelationships(sourceId: string): Promise<number> {
    const result = await testPool.query(
      'SELECT COUNT(*) FROM memory_relationships WHERE source_id = $1 AND project = $2',
      [sourceId, TEST_PROJECT_ID]
    );
    return parseInt(result.rows[0].count, 10);
  }

  beforeAll(async () => {
    // Load test database configuration
    const config = await loadBackendConfig();
    const testConfig = config.projectRegistry.test;
    if (!testConfig) {
      throw new Error('Test project not found in backend config');
    }
    databaseUrl = testConfig.databaseUrl;

    // Create dedicated pool for direct SQL queries
    testPool = new Pool({ connectionString: databaseUrl });

    // Readiness check: verify database is accessible
    try {
      await testPool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Integration tests require a Postgres database with pgvector extension.\n\n` +
          `Expected database at: ${databaseUrl}\n\n` +
          `To run integration tests:\n` +
          `1. Ensure test database is configured in config/projects.test.json\n` +
          `2. Run database setup script (if available) or manually create database\n` +
          `3. Apply migrations from migrations/ directory\n` +
          `4. Re-run tests\n\n` +
          `Original error: ${(error as Error).message}`
      );
    }

    // Create deterministic embedding service
    embeddingService = new FakeEmbeddingService(1536, 'test-embedding-model');

    // Initialize repository (cast FakeEmbeddingService to compatible type)
    repository = new MemoryRepositoryPostgres(
      databaseUrl,
      TEST_PROJECT_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      embeddingService as any
    );

    // Initial cleanup
    await resetDatabase();
  });

  afterAll(async () => {
    // Final cleanup
    await resetDatabase();

    // Close pools
    await testPool.end();
    await PoolManager.closePool(databaseUrl);
  });

  beforeEach(async () => {
    // Clean database before each test
    await resetDatabase();
  });

  describe('Index Lifecycle', () => {
    it('should create a new index with ensureIndex', async () => {
      await repository.ensureIndex(TEST_INDEX, 'Test index for integration testing');

      const exists = await repository.testIndex(TEST_INDEX);
      expect(exists).toBe(true);
    });

    it('should be idempotent when calling ensureIndex multiple times', async () => {
      await repository.ensureIndex(TEST_INDEX, 'First description');
      await repository.ensureIndex(TEST_INDEX, 'Second description');

      const exists = await repository.testIndex(TEST_INDEX);
      expect(exists).toBe(true);
    });

    it('should return false for non-existent index with testIndex', async () => {
      const exists = await repository.testIndex('non-existent-index');
      expect(exists).toBe(false);
    });

    it('should list indexes with document counts', async () => {
      await repository.ensureIndex(TEST_INDEX, 'Test index');
      await repository.ensureIndex('another-index', 'Another test index');

      const indexes = await repository.listIndexes();

      const testIndexInfo = indexes.find((idx) => idx.name === TEST_INDEX);
      expect(testIndexInfo).toBeDefined();
      expect(testIndexInfo?.description).toBe('Test index');
      expect(testIndexInfo?.documentCount).toBe(0);
      expect(testIndexInfo?.pendingDocumentCount).toBe(0);
    });

    it('should update document count in listIndexes after upserting memories', async () => {
      await repository.ensureIndex(TEST_INDEX);
      await repository.upsertMemories(TEST_INDEX, [makeMemory('Memory 1'), makeMemory('Memory 2')]);

      const indexes = await repository.listIndexes();
      const testIndexInfo = indexes.find((idx) => idx.name === TEST_INDEX);

      expect(testIndexInfo?.documentCount).toBe(2);
    });
  });

  describe('CRUD Operations', () => {
    beforeEach(async () => {
      await repository.ensureIndex(TEST_INDEX);
    });

    it('should upsert memories and return generated IDs', async () => {
      const ids = await repository.upsertMemories(TEST_INDEX, [
        makeMemory('First memory'),
        makeMemory('Second memory'),
      ]);

      expect(ids).toHaveLength(2);
      expect(ids[0]).toMatch(/^mem_/);
      expect(ids[1]).toMatch(/^mem_/);
      expect(ids[0]).not.toBe(ids[1]);
    });

    it('should merge default metadata when upserting', async () => {
      const ids = await repository.upsertMemories(
        TEST_INDEX,
        [makeMemory('Test memory', { tags: ['specific'] })],
        { source: 'system', tags: ['default'] }
      );

      const memory = await repository.getMemory(TEST_INDEX, ids[0]);
      expect(memory).not.toBeNull();
      expect(memory!.metadata!.source).toBe('system');
      // Memory metadata takes precedence
      expect(memory!.metadata!.tags).toEqual(['specific']);
    });

    it('should retrieve memory with getMemory', async () => {
      const [id] = await repository.upsertMemories(TEST_INDEX, [makeMemory('Test content')]);

      const memory = await repository.getMemory(TEST_INDEX, id);

      expect(memory).not.toBeNull();
      expect(memory?.id).toBe(id);
      expect(memory?.content.text).toBe('Test content');
    });

    it('should return null for non-existent memory ID', async () => {
      const memory = await repository.getMemory(TEST_INDEX, 'mem_non-existent-id');
      expect(memory).toBeNull();
    });

    it('should retrieve multiple memories with getMemories', async () => {
      const ids = await repository.upsertMemories(TEST_INDEX, [
        makeMemory('First'),
        makeMemory('Second'),
        makeMemory('Third'),
      ]);

      const memories = await repository.getMemories(TEST_INDEX, [ids[0], ids[2]]);

      expect(memories).toHaveLength(2);
      const texts = memories.map((m) => m.content.text).sort();
      expect(texts).toEqual(['First', 'Third']);
    });

    it('should update existing memory when upserting with ID', async () => {
      const [id] = await repository.upsertMemories(TEST_INDEX, [makeMemory('Original content')]);

      await repository.upsertMemories(TEST_INDEX, [
        {
          id,
          text: 'Updated content',
        },
      ]);

      const memory = await repository.getMemory(TEST_INDEX, id);
      expect(memory?.content.text).toBe('Updated content');
    });

    it('should delete memories and return count', async () => {
      const ids = await repository.upsertMemories(TEST_INDEX, [
        makeMemory('Memory 1'),
        makeMemory('Memory 2'),
        makeMemory('Memory 3'),
      ]);

      const deletedCount = await repository.deleteMemories(TEST_INDEX, [ids[0], ids[2]]);

      expect(deletedCount).toBe(2);

      const remaining = await repository.getMemory(TEST_INDEX, ids[1]);
      expect(remaining).not.toBeNull();
      expect(remaining?.content.text).toBe('Memory 2');
    });

    it('should ignore non-existent IDs when deleting', async () => {
      const [id] = await repository.upsertMemories(TEST_INDEX, [makeMemory('Test')]);

      const deletedCount = await repository.deleteMemories(TEST_INDEX, [id, 'mem_non-existent']);

      // Only one actual deletion
      expect(deletedCount).toBe(1);
    });

    it('should return 0 when deleting from non-existent index', async () => {
      const deletedCount = await repository.deleteMemories('non-existent-index', ['mem_some-id']);
      expect(deletedCount).toBe(0);
    });

    it('should return null when getting memory from non-existent index', async () => {
      const memory = await repository.getMemory('non-existent-index', 'mem_some-id');
      expect(memory).toBeNull();
    });

    it('should return empty array when getting multiple memories from non-existent index', async () => {
      const memories = await repository.getMemories('non-existent-index', ['mem_id1', 'mem_id2']);
      expect(memories).toHaveLength(0);
    });

    it('should handle empty batch upsert', async () => {
      const ids = await repository.upsertMemories(TEST_INDEX, []);
      expect(ids).toHaveLength(0);
    });

    it('should handle empty delete', async () => {
      const deletedCount = await repository.deleteMemories(TEST_INDEX, []);
      expect(deletedCount).toBe(0);
    });
  });

  describe('Relationship Management', () => {
    beforeEach(async () => {
      await repository.ensureIndex(TEST_INDEX);
    });

    it('should store and retrieve relationships', async () => {
      const [id1, id2, id3] = await repository.upsertMemories(TEST_INDEX, [
        makeMemory('Summary memory'),
        makeMemory('Detail memory 1'),
        makeMemory('Detail memory 2'),
      ]);

      // Update first memory with relationships
      await repository.upsertMemories(TEST_INDEX, [
        {
          id: id1,
          text: 'Summary memory',
          metadata: {
            relationships: [
              { targetId: id2, type: 'summarizes', weight: 0.9 },
              { targetId: id3, type: 'summarizes', weight: 0.8 },
            ],
          },
        },
      ]);

      const memory = await repository.getMemory(TEST_INDEX, id1);
      expect(memory!.metadata!.relationships).toHaveLength(2);
      expect(memory!.metadata!.relatedIds).toEqual(expect.arrayContaining([id2, id3]));

      const relationship = memory!.metadata!.relationships?.find((r) => r.targetId === id2);
      expect(relationship?.type).toBe('summarizes');
      expect(relationship?.weight).toBe(0.9);
    });

    it('should sync relationships to database table', async () => {
      const [id1, id2] = await repository.upsertMemories(TEST_INDEX, [
        makeMemory('Source'),
        makeMemory('Target'),
      ]);

      await repository.upsertMemories(TEST_INDEX, [
        {
          id: id1,
          text: 'Source',
          metadata: {
            relationships: [{ targetId: id2, type: 'example_of' }],
          },
        },
      ]);

      const count = await countRelationships(id1);
      expect(count).toBe(1);
    });

    it('should clear relationships when upserting with empty array', async () => {
      const [id1, id2] = await repository.upsertMemories(TEST_INDEX, [
        makeMemory('Source'),
        makeMemory('Target'),
      ]);

      // Add relationships
      await repository.upsertMemories(TEST_INDEX, [
        {
          id: id1,
          text: 'Source',
          metadata: {
            relationships: [{ targetId: id2, type: 'supports' }],
          },
        },
      ]);

      let count = await countRelationships(id1);
      expect(count).toBe(1);

      // Clear relationships
      await repository.upsertMemories(TEST_INDEX, [
        {
          id: id1,
          text: 'Source',
          metadata: {
            relationships: [],
          },
        },
      ]);

      count = await countRelationships(id1);
      expect(count).toBe(0);
    });

    it('should populate relationships when searching', async () => {
      const [id1, id2] = await repository.upsertMemories(TEST_INDEX, [
        makeMemory('Summary of important facts'),
        makeMemory('Detailed fact'),
      ]);

      await repository.upsertMemories(TEST_INDEX, [
        {
          id: id1,
          text: 'Summary of important facts',
          metadata: {
            relationships: [{ targetId: id2, type: 'summarizes' }],
          },
        },
      ]);

      const results = await repository.searchMemories(TEST_INDEX, 'summary facts', {
        limit: 1,
      });

      expect(results).toHaveLength(1);
      expect(results[0].metadata!.relationships).toHaveLength(1);
      expect(results[0].metadata!.relatedIds).toContain(id2);
    });

    it('should preserve relationships when updating without relationships field', async () => {
      const [id1, id2] = await repository.upsertMemories(TEST_INDEX, [
        makeMemory('Source'),
        makeMemory('Target'),
      ]);

      // Add relationships
      await repository.upsertMemories(TEST_INDEX, [
        {
          id: id1,
          text: 'Source',
          metadata: {
            relationships: [{ targetId: id2, type: 'supports' }],
          },
        },
      ]);

      let count = await countRelationships(id1);
      expect(count).toBe(1);

      // Update without relationships field
      await repository.upsertMemories(TEST_INDEX, [
        {
          id: id1,
          text: 'Updated source text',
        },
      ]);

      // Relationships should still exist
      count = await countRelationships(id1);
      expect(count).toBe(1);

      const memory = await repository.getMemory(TEST_INDEX, id1);
      expect(memory!.metadata!.relationships).toHaveLength(1);
    });

    it('should populate bidirectional relationships (target shows incoming links)', async () => {
      const [id1, id2, id3] = await repository.upsertMemories(TEST_INDEX, [
        makeMemory('Summary'),
        makeMemory('Detail 1'),
        makeMemory('Detail 2'),
      ]);

      // Add relationships from id1 to id2 and id3
      await repository.upsertMemories(TEST_INDEX, [
        {
          id: id1,
          text: 'Summary',
          metadata: {
            relationships: [
              { targetId: id2, type: 'summarizes' },
              { targetId: id3, type: 'summarizes' },
            ],
          },
        },
      ]);

      // Check that target memories show incoming links
      const detail1 = await repository.getMemory(TEST_INDEX, id2);
      const detail2 = await repository.getMemory(TEST_INDEX, id3);

      expect(detail1!.metadata!.relatedIds).toContain(id1);
      expect(detail2!.metadata!.relatedIds).toContain(id1);
    });
  });

  describe('Search and Filters', () => {
    beforeEach(async () => {
      await repository.ensureIndex(TEST_INDEX);
    });

    it('should search memories semantically', async () => {
      await repository.upsertMemories(TEST_INDEX, [
        makeMemory('The quick brown fox jumps'),
        makeMemory('Completely different topic about databases'),
        makeMemory('Another story about a jumping fox'),
      ]);

      const results = await repository.searchMemories(TEST_INDEX, 'fox jumping', {
        limit: 2,
      });

      expect(results).toHaveLength(2);
      // Because we use deterministic embeddings, same/similar text produces closer vectors
      expect(results[0].content.text).toContain('fox');
    });

    it('should filter by denormalized topic field', async () => {
      await repository.upsertMemories(TEST_INDEX, [
        makeMemory('Memory about work', { topic: 'work' }),
        makeMemory('Memory about hobbies', { topic: 'hobbies' }),
        makeMemory('Another work memory', { topic: 'work' }),
      ]);

      const results = await repository.searchMemories(TEST_INDEX, '', {
        filterExpression: '@metadata.topic = "work"',
        limit: 10,
      });

      expect(results).toHaveLength(2);
      results.forEach((r) => {
        expect(r.metadata!.topic).toBe('work');
      });
    });

    it('should filter by JSONB array field (tags)', async () => {
      await repository.upsertMemories(TEST_INDEX, [
        makeMemory('First', { tags: ['important', 'project-a'] }),
        makeMemory('Second', { tags: ['project-b'] }),
        makeMemory('Third', { tags: ['important', 'urgent'] }),
      ]);

      const results = await repository.searchMemories(TEST_INDEX, '', {
        filterExpression: '@metadata.tags CONTAINS "important"',
        limit: 10,
      });

      expect(results).toHaveLength(2);
      results.forEach((r) => {
        expect(r.metadata!.tags).toContain('important');
      });
    });

    it('should throw on invalid filter expression', async () => {
      await repository.upsertMemories(TEST_INDEX, [makeMemory('Test')]);

      await expect(
        repository.searchMemories(TEST_INDEX, '', {
          filterExpression: 'invalid syntax here',
        })
      ).rejects.toThrow();
    });

    it('should respect includeMetadata option', async () => {
      await repository.upsertMemories(TEST_INDEX, [
        makeMemory('Test memory', { source: 'system', tags: ['test'] }),
      ]);

      const resultsWithMetadata = await repository.searchMemories(TEST_INDEX, 'test', {
        includeMetadata: true,
      });
      expect(resultsWithMetadata[0].metadata!.source).toBe('system');

      const resultsWithoutMetadata = await repository.searchMemories(TEST_INDEX, 'test', {
        includeMetadata: false,
      });
      expect(resultsWithoutMetadata[0].metadata?.source).toBeUndefined();
      expect(resultsWithoutMetadata[0].metadata?.tags).toBeUndefined();
    });

    it('should return empty results for non-matching filter', async () => {
      await repository.upsertMemories(TEST_INDEX, [makeMemory('Test', { topic: 'programming' })]);

      const results = await repository.searchMemories(TEST_INDEX, '', {
        filterExpression: '@metadata.topic = "cooking"',
      });

      expect(results).toHaveLength(0);
    });

    it('should return empty results when searching non-existent index', async () => {
      const results = await repository.searchMemories('non-existent-index', 'query');
      expect(results).toHaveLength(0);
    });
  });

  describe('Access Tracking', () => {
    beforeEach(async () => {
      await repository.ensureIndex(TEST_INDEX);
    });

    it('should update access count and priority', async () => {
      const [id] = await repository.upsertMemories(TEST_INDEX, [makeMemory('Test memory')]);

      // Get initial state
      const initialDb = await getMemoryFromDb(id);
      expect(initialDb.access_count).toBe(0);

      // Update access stats
      await repository.updateAccessStats(TEST_INDEX, [id]);

      // Check updated state
      const updatedDb = await getMemoryFromDb(id);
      expect(updatedDb.access_count).toBe(1);
      expect(updatedDb.current_priority).toBeGreaterThan(initialDb.current_priority);
    });

    it('should limit updates to topN memories', async () => {
      const ids = await repository.upsertMemories(TEST_INDEX, [
        makeMemory('Memory 1'),
        makeMemory('Memory 2'),
        makeMemory('Memory 3'),
        makeMemory('Memory 4'),
        makeMemory('Memory 5'),
      ]);

      // Update with topN = 3
      await repository.updateAccessStats(TEST_INDEX, ids, { topN: 3 });

      // Check only first 3 were updated
      const mem1 = await getMemoryFromDb(ids[0]);
      const mem4 = await getMemoryFromDb(ids[3]);

      expect(mem1.access_count).toBe(1);
      expect(mem4.access_count).toBe(0);
    });

    it('should update metadata.dynamics fields', async () => {
      const [id] = await repository.upsertMemories(TEST_INDEX, [makeMemory('Test memory')]);

      await repository.updateAccessStats(TEST_INDEX, [id]);

      const memory = await repository.getMemory(TEST_INDEX, id);
      expect(memory!.metadata!.dynamics?.accessCount).toBe(1);
      expect(memory!.metadata!.dynamics?.currentPriority).toBeGreaterThan(0);
      expect(memory!.metadata!.dynamics?.lastAccessedAt).toBeDefined();
    });

    it('should handle empty ID array in updateAccessStats', async () => {
      // Should not throw
      await expect(repository.updateAccessStats(TEST_INDEX, [])).resolves.not.toThrow();
    });
  });

  describe('Database Diagnostics', () => {
    beforeEach(async () => {
      await repository.ensureIndex(TEST_INDEX);
    });

    it('should return database info with index statistics', async () => {
      await repository.upsertMemories(TEST_INDEX, [makeMemory('Memory 1'), makeMemory('Memory 2')]);

      const dbInfo = await repository.getDatabaseInfo();

      expect(dbInfo.documentCount).toBeGreaterThanOrEqual(2);
      expect(dbInfo.pendingDocumentCount).toBe(0);
      expect(dbInfo.indexes[TEST_INDEX]).toBeDefined();
      expect(dbInfo.indexes[TEST_INDEX].documentCount).toBe(2);
    });

    it('should reflect correct counts after deletions', async () => {
      const ids = await repository.upsertMemories(TEST_INDEX, [
        makeMemory('Memory 1'),
        makeMemory('Memory 2'),
        makeMemory('Memory 3'),
      ]);

      await repository.deleteMemories(TEST_INDEX, [ids[0]]);

      const dbInfo = await repository.getDatabaseInfo();
      expect(dbInfo.indexes[TEST_INDEX].documentCount).toBe(2);
    });

    it('should handle multiple indexes in getDatabaseInfo', async () => {
      await repository.ensureIndex('index-one');
      await repository.ensureIndex('index-two');

      await repository.upsertMemories('index-one', [makeMemory('One')]);
      await repository.upsertMemories('index-two', [makeMemory('Two A'), makeMemory('Two B')]);

      const dbInfo = await repository.getDatabaseInfo();

      expect(dbInfo.indexes['index-one'].documentCount).toBe(1);
      expect(dbInfo.indexes['index-two'].documentCount).toBe(2);
    });
  });

  describe('Edge Cases', () => {
    beforeEach(async () => {
      await repository.ensureIndex(TEST_INDEX);
    });

    it('should handle empty search query', async () => {
      await repository.upsertMemories(TEST_INDEX, [makeMemory('Memory 1'), makeMemory('Memory 2')]);

      const results = await repository.searchMemories(TEST_INDEX, '', { limit: 10 });
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle upsert with all metadata fields', async () => {
      const fullMetadata: Partial<MemoryMetadata> = {
        source: 'file',
        sourcePath: 'test/file.md',
        tags: ['test', 'integration'],
        topic: 'testing',
        importance: 'high' as Importance,
        memoryType: 'episodic',
        relationships: [],
      };

      const [id] = await repository.upsertMemories(TEST_INDEX, [
        makeMemory('Full metadata memory', fullMetadata),
      ]);

      const memory = await repository.getMemory(TEST_INDEX, id);
      expect(memory!.metadata!.source).toBe('file');
      expect(memory!.metadata!.sourcePath).toBe('test/file.md');
      expect(memory!.metadata!.tags).toEqual(['test', 'integration']);
      expect(memory!.metadata!.topic).toBe('testing');
      expect(memory!.metadata!.importance).toBe('high');
      expect(memory!.metadata!.memoryType).toBe('episodic');
    });

    it('should handle batch upsert with mixed new and update operations', async () => {
      const [existingId] = await repository.upsertMemories(TEST_INDEX, [
        makeMemory('Existing memory'),
      ]);

      const ids = await repository.upsertMemories(TEST_INDEX, [
        { id: existingId, text: 'Updated memory' },
        makeMemory('New memory'),
      ]);

      expect(ids).toHaveLength(2);
      expect(ids[0]).toBe(existingId);

      const updated = await repository.getMemory(TEST_INDEX, existingId);
      expect(updated?.content.text).toBe('Updated memory');
    });

    it('should handle searching with diagnostics listener', async () => {
      await repository.upsertMemories(TEST_INDEX, [makeMemory('Test')]);

      let diagnosticsCalled = false;
      await repository.searchMemories(TEST_INDEX, 'test', {
        diagnosticsListener: (diag) => {
          diagnosticsCalled = true;
          expect(diag.durationMs).toBeGreaterThan(0);
        },
      });

      expect(diagnosticsCalled).toBe(true);
    });
  });
});
