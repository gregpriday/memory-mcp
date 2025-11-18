import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import { config } from 'dotenv';
import { loadBackendConfig } from '../src/config/backend.js';
import { TestServerHarness } from './helpers/TestServerHarness.js';
import { FakeEmbeddingService } from './helpers/FakeEmbeddingService.js';
import { FakeLLMClient } from './helpers/FakeLLMClient.js';

// Load environment variables
config();

describe('Memorize Tools Integration Tests', () => {
  let harness: TestServerHarness;
  let harnessWithFakes: TestServerHarness;
  let fakeLLMClient: FakeLLMClient;
  const testProjectId = 'memorize-tools-test';
  const testIndexPrefix = 'mem-test-';

  before(async () => {
    // Load database URL from backend config (projects.json)
    const backendConfig = loadBackendConfig();
    const databaseUrl = backendConfig.activeProject.databaseUrl;

    // Create harness with fake embedding service for DB-level tests
    harness = new TestServerHarness(databaseUrl, testProjectId, {
      embeddingService: new FakeEmbeddingService(1536),
    });

    // Create harness with both fakes for agent-level tests
    fakeLLMClient = new FakeLLMClient();
    harnessWithFakes = new TestServerHarness(databaseUrl, testProjectId, {
      embeddingService: new FakeEmbeddingService(1536),
      llmClient: fakeLLMClient,
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
    if (harnessWithFakes) {
      await harnessWithFakes.close();
    }
  });

  describe('DB-level memorization (repository layer)', () => {
    it('should store a single memory with 1536-dim embedding in Postgres', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-single`;
      const testText = 'Remember this single test memory';
      const metadata = {
        source: 'user',
        timestamp: new Date().toISOString(),
        topic: 'testing',
        importance: 'high',
      };

      // Call repository.upsertMemories directly
      const [memoryId] = await harness.repository.upsertMemories(
        indexName,
        [{ text: testText, metadata }],
        {}
      );

      // Verify memory ID was returned
      assert.ok(memoryId, 'Memory ID should be returned');
      assert.strictEqual(typeof memoryId, 'string', 'Memory ID should be a string');

      // Query database for the memory row
      const row = await harness.getMemoryRow(memoryId);
      assert.ok(row, 'Memory row should exist in database');

      // Verify content
      assert.strictEqual(row!.content, testText, 'Content should match input text');

      // Verify embedding dimensions using pgvector's vector_dims function
      const dims = await harness.getEmbeddingDimensions(memoryId);
      assert.strictEqual(dims, 1536, 'Embedding should have 1536 dimensions');

      // Verify metadata includes source and timestamp
      assert.strictEqual(row!.metadata.source, 'user', 'Metadata should include source field');
      assert.ok(row!.metadata.timestamp, 'Metadata should include timestamp field');
      assert.strictEqual(row!.metadata.topic, 'testing', 'Metadata should include topic field');
      assert.strictEqual(
        row!.metadata.importance,
        'high',
        'Metadata should include importance field'
      );

      // Verify source field at top level
      assert.strictEqual(row!.source, 'user', 'Source field should be populated');

      // Verify priority values are in [0.0, 1.0] range
      assert.ok(
        row!.initial_priority >= 0.0 && row!.initial_priority <= 1.0,
        `Initial priority ${row!.initial_priority} should be in [0.0, 1.0] range`
      );
      assert.ok(
        row!.current_priority >= 0.0 && row!.current_priority <= 1.0,
        `Current priority ${row!.current_priority} should be in [0.0, 1.0] range`
      );

      // Verify priorities are equal for new memory
      assert.strictEqual(
        row!.initial_priority,
        row!.current_priority,
        'Initial and current priority should match for new memory'
      );

      // Verify timestamps are populated
      assert.ok(row!.created_at, 'Created timestamp should be populated');
      assert.ok(row!.updated_at, 'Updated timestamp should be populated');
    });

    it('should generate different embeddings for different texts', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-multi`;
      const text1 = 'First test memory';
      const text2 = 'Second test memory';
      const metadata = {
        source: 'user',
        timestamp: new Date().toISOString(),
      };

      // Store two different memories
      const [memoryId1] = await harness.repository.upsertMemories(
        indexName,
        [{ text: text1, metadata }],
        {}
      );
      const [memoryId2] = await harness.repository.upsertMemories(
        indexName,
        [{ text: text2, metadata }],
        {}
      );

      // Get both memory rows
      const row1 = await harness.getMemoryRow(memoryId1);
      const row2 = await harness.getMemoryRow(memoryId2);

      assert.ok(row1, 'First memory should exist');
      assert.ok(row2, 'Second memory should exist');

      // Verify embeddings are different (FakeEmbeddingService generates deterministic but text-specific vectors)
      assert.notDeepStrictEqual(
        row1!.embedding,
        row2!.embedding,
        'Different texts should produce different embeddings'
      );

      // But both should have correct dimensions
      const dims1 = await harness.getEmbeddingDimensions(memoryId1);
      const dims2 = await harness.getEmbeddingDimensions(memoryId2);
      assert.strictEqual(dims1, 1536, 'First embedding should have 1536 dimensions');
      assert.strictEqual(dims2, 1536, 'Second embedding should have 1536 dimensions');
    });

    it('should handle batch upsert of multiple memories', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-batch`;
      const memories = [
        { text: 'Memory one', metadata: { topic: 'first' } },
        { text: 'Memory two', metadata: { topic: 'second' } },
        { text: 'Memory three', metadata: { topic: 'third' } },
      ];

      const defaultMetadata = {
        source: 'user',
        timestamp: new Date().toISOString(),
      };

      // Upsert batch
      const memoryIds = await harness.repository.upsertMemories(
        indexName,
        memories,
        defaultMetadata
      );

      // Verify correct number of IDs returned
      assert.strictEqual(memoryIds.length, 3, 'Should return 3 memory IDs');

      // Verify all memories exist in database
      for (let i = 0; i < memoryIds.length; i++) {
        const row = await harness.getMemoryRow(memoryIds[i]);
        assert.ok(row, `Memory ${i + 1} should exist in database`);
        assert.strictEqual(
          row!.content,
          memories[i].text,
          `Content should match for memory ${i + 1}`
        );
        assert.strictEqual(
          row!.metadata.topic,
          memories[i].metadata.topic,
          `Topic should match for memory ${i + 1}`
        );
        assert.strictEqual(
          row!.metadata.source,
          'user',
          `Source should be from defaultMetadata for memory ${i + 1}`
        );

        // Verify embedding dimensions
        const dims = await harness.getEmbeddingDimensions(memoryIds[i]);
        assert.strictEqual(dims, 1536, `Memory ${i + 1} should have 1536-dim embedding`);

        // Verify priorities
        assert.ok(
          row!.initial_priority >= 0.0 && row!.initial_priority <= 1.0,
          `Memory ${i + 1} priority should be in valid range`
        );
      }
    });
  });

  describe('Agent-level memorization (full tool integration)', () => {
    it('should call memorize tool with simple text input', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-tool`;
      const inputText = 'Remember this via the memorize tool';

      // Reset the fake LLM client's call counter
      fakeLLMClient.reset();

      // Call memorize tool through controller
      const result = await harnessWithFakes.callMemorize({
        input: inputText,
        index: indexName,
        metadata: {
          source: 'user',
          timestamp: new Date().toISOString(),
          topic: 'testing',
        },
        force: true, // Bypass deduplication
      });

      // Verify result structure
      assert.strictEqual(result.status, 'ok', 'Memorize should succeed');
      assert.strictEqual(result.storedCount, 1, 'Should store exactly 1 memory');
      assert.ok(Array.isArray(result.memoryIds), 'Should return array of memory IDs');
      assert.strictEqual(result.memoryIds.length, 1, 'Should return 1 memory ID');

      // Verify decision
      assert.ok(result.decision, 'Should include decision');
      assert.strictEqual(result.decision!.action, 'STORED', 'Decision action should be STORED');

      // Get the stored memory from database
      const memoryId = result.memoryIds[0];
      const row = await harnessWithFakes.getMemoryRow(memoryId);
      assert.ok(row, 'Memory should exist in database');

      // Verify embedding dimensions
      const dims = await harnessWithFakes.getEmbeddingDimensions(memoryId);
      assert.strictEqual(dims, 1536, 'Embedding should have 1536 dimensions');

      // Verify metadata
      assert.ok(row!.metadata.source, 'Metadata should include source');
      assert.ok(row!.metadata.timestamp, 'Metadata should include timestamp');

      // Verify priorities
      assert.ok(
        row!.initial_priority >= 0.0 && row!.initial_priority <= 1.0,
        'Priority should be in [0.0, 1.0] range'
      );
    });

    it('should complete full memorize tool loop with agent decision', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-loop`;
      const inputText = 'Test the complete tool loop execution';

      // Reset the fake LLM client
      fakeLLMClient.reset();

      // Call memorize
      const result = await harnessWithFakes.callMemorize({
        input: inputText,
        index: indexName,
        metadata: {
          source: 'user',
          timestamp: new Date().toISOString(),
        },
        force: true,
      });

      // Verify complete result structure for all acceptance criteria
      assert.strictEqual(result.status, 'ok', 'Status should be ok');
      assert.ok(result.memoryIds.length > 0, 'Should return memory IDs');
      assert.strictEqual(
        result.storedCount,
        result.memoryIds.length,
        'Stored count should match IDs'
      );
      assert.ok(result.decision, 'Should include decision');
      assert.strictEqual(result.decision!.action, 'STORED', 'Should have STORED action');

      // Verify in database
      const memoryId = result.memoryIds[0];
      const row = await harnessWithFakes.getMemoryRow(memoryId);

      // All acceptance criteria checks
      assert.ok(memoryId, '✓ Memory ID returned successfully');
      assert.ok(row, 'Memory row should exist in database');

      const dims = await harnessWithFakes.getEmbeddingDimensions(memoryId);
      assert.strictEqual(dims, 1536, '✓ SQL query shows memory with correct embedding dimensions');

      assert.ok(row.metadata, 'Metadata object should exist');
      assert.ok(row.metadata.source || row.source, '✓ Metadata includes source');
      assert.ok(row.metadata.timestamp || row.created_at, '✓ Metadata includes timestamp');

      assert.ok(
        row!.initial_priority >= 0.0 && row!.initial_priority <= 1.0,
        '✓ Priority values in [0.0, 1.0] range (initial)'
      );
      assert.ok(
        row!.current_priority >= 0.0 && row!.current_priority <= 1.0,
        '✓ Priority values in [0.0, 1.0] range (current)'
      );
    });

    it('should pass previousResponseId between tool loop iterations (CoT persistence)', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-cot`;
      const inputText = 'Test CoT persistence';

      // Reset the fake LLM client
      fakeLLMClient.reset();

      // Call memorize tool through controller
      await harnessWithFakes.callMemorize({
        input: inputText,
        index: indexName,
        metadata: {
          source: 'test',
        },
        force: true,
      });

      // Verify that previousResponseId was passed on the second call
      // First call returns fake-response-1, second call should receive it as previousResponseId
      assert.strictEqual(
        fakeLLMClient.lastPreviousResponseId,
        'fake-response-1',
        'Second LLM call should receive previousResponseId from first call'
      );
    });
  });
});
