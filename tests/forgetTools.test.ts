import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import { config } from 'dotenv';
import { TestServerHarness } from './helpers/TestServerHarness.js';
import { FakeEmbeddingService } from './helpers/FakeEmbeddingService.js';
import { FakeForgetLLMClient } from './helpers/FakeForgetLLMClient.js';

// Load environment variables
config();

describe('Forget Tools Integration Tests', () => {
  let harness: TestServerHarness;
  let fakeLLMClient: FakeForgetLLMClient;
  const testProjectId = 'forget-tools-test';
  const testIndexPrefix = 'forget-test-';

  before(async () => {
    // Get database URL from environment
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL not set in test environment');
    }

    // Create harness with fake embedding service and fake LLM client
    fakeLLMClient = new FakeForgetLLMClient();
    harness = new TestServerHarness(databaseUrl, testProjectId, {
      embeddingService: new FakeEmbeddingService(1536),
      llmClient: fakeLLMClient,
    });

    // Clean up any existing test data from previous runs
    await harness.cleanupTestMemories(testIndexPrefix);
    await harness.cleanupTestIndexes(testIndexPrefix);
  });

  afterEach(async () => {
    // Reset LLM client call counter between tests
    fakeLLMClient.reset();

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

  describe('Memory deletion via forget tool', () => {
    it('should delete a regular memory and verify deletion in database', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-delete`;
      const testText = 'This is a test memory to be deleted';
      const metadata = {
        source: 'user',
        timestamp: new Date().toISOString(),
        topic: 'testing',
      };

      // Create a memory directly via repository
      const [memoryId] = await harness.repository.upsertMemories(
        indexName,
        [{ text: testText, metadata }],
        {}
      );

      // Verify memory exists before deletion
      const memoryBefore = await harness.getMemoryRow(memoryId);
      assert.ok(memoryBefore, 'Memory should exist before deletion');
      assert.strictEqual(memoryBefore!.content, testText, 'Memory content should match');

      // Call forget tool with explicit memory ID
      const result = await harness.callForget({
        input: 'Delete this test memory',
        index: indexName,
        dryRun: false,
        explicitMemoryIds: [memoryId],
      });

      // Verify result status
      assert.strictEqual(result.status, 'ok', 'Forget should succeed');
      assert.strictEqual(result.deletedCount, 1, 'Should delete 1 memory');
      assert.ok(result.deletedIds, 'Should return deleted IDs');
      assert.strictEqual(result.deletedIds!.length, 1, 'Should have 1 deleted ID');
      assert.strictEqual(result.deletedIds![0], memoryId, 'Deleted ID should match');

      // Verify memory no longer exists in database
      const memoryAfter = await harness.getMemoryRow(memoryId);
      assert.strictEqual(memoryAfter, null, 'Memory should be deleted from database');

      // Verify index still exists
      const indexExists = await harness.verifyIndexInDatabase(indexName);
      assert.ok(indexExists, 'Index should still exist after memory deletion');
    });
  });

  describe('System memory protection', () => {
    it('should protect system memories from deletion', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-protect`;
      const systemMemoryId = 'sys_protected_memory';
      const testText = 'This is a system memory that should be protected';
      const metadata = {
        source: 'system',
        timestamp: new Date().toISOString(),
        topic: 'system',
      };

      // Ensure index exists first
      await harness.repository.ensureIndex(indexName, 'Test index for system memory protection');

      // Create a system memory directly via repository with sys_ prefix
      // Note: We use a custom ID generator for this test to ensure sys_ prefix
      await harness.pool.query(
        `INSERT INTO memories (project, id, index_id, content, embedding, source, metadata, initial_priority, current_priority, memory_type)
         SELECT $1, $2, id, $3, $4, $5, $6, 0.5, 0.5, $8
         FROM memory_indexes
         WHERE project = $1 AND name = $7`,
        [
          testProjectId,
          systemMemoryId,
          testText,
          JSON.stringify(new Array(1536).fill(0.1)), // Fake embedding
          'system',
          JSON.stringify(metadata),
          indexName,
          'semantic', // memory_type (required field)
        ]
      );

      // Verify memory exists before deletion attempt
      const memoryBefore = await harness.getMemoryRow(systemMemoryId);
      assert.ok(memoryBefore, 'System memory should exist before deletion attempt');

      // Try to delete the system memory
      const result = await harness.callForget({
        input: 'Delete this system memory',
        index: indexName,
        dryRun: false,
        explicitMemoryIds: [systemMemoryId],
      });

      // Verify deletion was blocked
      assert.strictEqual(result.status, 'ok', 'Forget should succeed (but not delete)');
      assert.strictEqual(result.deletedCount, 0, 'Should delete 0 memories (protected)');

      // Verify memory still exists in database
      const memoryAfter = await harness.getMemoryRow(systemMemoryId);
      assert.ok(memoryAfter, 'System memory should still exist after deletion attempt');
      assert.strictEqual(memoryAfter!.content, testText, 'Memory content should be unchanged');
    });
  });

  describe('Relationship cascade deletion', () => {
    it('should cascade delete relationships when source memory is deleted', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-cascade`;
      const sourceText = 'Source memory with relationship';
      const targetText = 'Target memory that should remain';

      // Create target memory first (FK constraint requires it to exist)
      const [targetId] = await harness.repository.upsertMemories(
        indexName,
        [
          {
            text: targetText,
            metadata: {
              source: 'user',
              timestamp: new Date().toISOString(),
              topic: 'testing',
            },
          },
        ],
        {}
      );

      // Create source memory with relationship to target
      const [sourceId] = await harness.repository.upsertMemories(
        indexName,
        [
          {
            text: sourceText,
            metadata: {
              source: 'user',
              timestamp: new Date().toISOString(),
              topic: 'testing',
              relationships: [
                {
                  targetId: targetId,
                  type: 'similar_to',
                  confidence: 0.9,
                },
              ],
            },
          },
        ],
        {}
      );

      // Verify both memories exist
      const sourceBefore = await harness.getMemoryRow(sourceId);
      const targetBefore = await harness.getMemoryRow(targetId);
      assert.ok(sourceBefore, 'Source memory should exist');
      assert.ok(targetBefore, 'Target memory should exist');

      // Verify relationship exists
      const relationshipsBefore = await harness.getRelationshipsForMemory(sourceId);
      assert.strictEqual(
        relationshipsBefore.length,
        1,
        'Should have 1 relationship before deletion'
      );
      assert.strictEqual(
        relationshipsBefore[0].source_id,
        sourceId,
        'Relationship source should match'
      );
      assert.strictEqual(
        relationshipsBefore[0].target_id,
        targetId,
        'Relationship target should match'
      );

      // Delete the source memory
      const result = await harness.callForget({
        input: 'Delete the source memory',
        index: indexName,
        dryRun: false,
        explicitMemoryIds: [sourceId],
      });

      // Verify deletion succeeded
      assert.strictEqual(result.status, 'ok', 'Forget should succeed');
      assert.strictEqual(result.deletedCount, 1, 'Should delete 1 memory');

      // Verify source memory is deleted
      const sourceAfter = await harness.getMemoryRow(sourceId);
      assert.strictEqual(sourceAfter, null, 'Source memory should be deleted');

      // Verify target memory still exists
      const targetAfter = await harness.getMemoryRow(targetId);
      assert.ok(targetAfter, 'Target memory should still exist');
      assert.strictEqual(targetAfter!.content, targetText, 'Target content should be unchanged');

      // Verify relationship is cascade deleted
      const relationshipsAfter = await harness.getRelationshipsForMemory(sourceId);
      assert.strictEqual(relationshipsAfter.length, 0, 'Relationships should be cascade deleted');

      // Double-check using relationship count helper
      const relationshipCount = await harness.getRelationshipCount(sourceId);
      assert.strictEqual(relationshipCount, 0, 'Relationship count should be 0');
    });
  });
});
