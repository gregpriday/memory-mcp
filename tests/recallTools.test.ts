import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import { config } from 'dotenv';
import { TestServerHarness } from './helpers/TestServerHarness.js';
import { FakeEmbeddingService } from './helpers/FakeEmbeddingService.js';
import { FakeRecallLLMClient } from './helpers/FakeRecallLLMClient.js';

// Load environment variables
config();

describe('Recall Tools Integration Tests', () => {
  let harness: TestServerHarness;
  let fakeRecallLLMClient: FakeRecallLLMClient;
  let fakeEmbeddingService: FakeEmbeddingService;
  const testProjectId = 'recall-tools-test';
  const testIndexPrefix = 'recall-test-';

  before(async () => {
    // Get database URL from environment
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL not set in test environment');
    }

    // Create fake services
    fakeEmbeddingService = new FakeEmbeddingService(1536);
    fakeRecallLLMClient = new FakeRecallLLMClient();

    // Create harness with both fakes for agent-level tests
    harness = new TestServerHarness(databaseUrl, testProjectId, {
      embeddingService: fakeEmbeddingService,
      llmClient: fakeRecallLLMClient,
    });

    // Clean up any existing test data from previous runs
    await harness.cleanupTestMemories(testIndexPrefix);
    await harness.cleanupTestIndexes(testIndexPrefix);
  });

  afterEach(async () => {
    // Reset the fake LLM client after each test
    fakeRecallLLMClient.reset();

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

  describe('Semantic search with pgvector', () => {
    // Note: These are integration tests that exercise the full recall flow:
    // MCP tool → MemoryAgent → ToolRuntime → MemoryRepository → PostgreSQL
    // We use FakeRecallLLMClient to simulate the LLM decision-making,
    // but all other components (including pgvector) are real.

    it('should recall relevant memories with similarity scores', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-happy-path`;

      // Store test memories directly via repository
      const memories = [
        {
          text: 'PostgreSQL is a powerful open-source relational database',
          metadata: { topic: 'database', source: 'test' },
        },
        {
          text: 'pgvector enables semantic search with vector similarity',
          metadata: { topic: 'database', source: 'test' },
        },
      ];

      await harness.repository.upsertMemories(indexName, memories, {
        timestamp: new Date().toISOString(),
      });

      // Reset fake client and call recall
      fakeRecallLLMClient.reset();

      const result = await harness.callRecall({
        query: 'How does vector search work in PostgreSQL?',
        index: indexName,
        limit: 10,
        responseMode: 'memories',
      });

      // Verify result structure
      assert.strictEqual(result.status, 'ok', 'Recall should succeed');
      assert.ok(Array.isArray(result.memories), 'Memories should be an array');
      assert.ok(result.memories!.length > 0, 'Should return relevant memories');

      // Verify memories have required fields
      const firstMemory = result.memories![0];
      assert.ok(firstMemory.id, 'Memory should have ID');
      assert.ok(firstMemory.text, 'Memory should have text');
      assert.ok(typeof firstMemory.score === 'number', 'Memory should have score');

      // Verify search status
      assert.strictEqual(
        result.searchStatus,
        'results',
        'Search status should be "results" for successful search'
      );
    });

    it('should return memories ordered by relevance (descending score)', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-ordering`;

      // Store three memories with different relevance to our query
      const memories = [
        {
          text: 'The weather is sunny today',
          metadata: { topic: 'weather', source: 'test' },
        },
        {
          text: 'PostgreSQL supports vector similarity search with pgvector extension',
          metadata: { topic: 'database', source: 'test' },
        },
        {
          text: 'Vector embeddings enable semantic search in databases',
          metadata: { topic: 'database', source: 'test' },
        },
      ];

      await harness.repository.upsertMemories(indexName, memories, {
        timestamp: new Date().toISOString(),
      });

      // Query for database-related content
      fakeRecallLLMClient.reset();

      const result = await harness.callRecall({
        query: 'vector search in PostgreSQL databases',
        index: indexName,
        limit: 10,
        responseMode: 'memories',
      });

      // Verify we got results
      assert.ok(result.memories && result.memories.length > 0, 'Should return memories');

      // Verify scores are in descending order
      for (let i = 1; i < result.memories!.length; i++) {
        const prevScore = result.memories![i - 1].score ?? 0;
        const currScore = result.memories![i].score ?? 0;
        assert.ok(
          prevScore >= currScore,
          `Scores should be in descending order: ${prevScore} >= ${currScore}`
        );
      }

      // Verify the most relevant memories are database-related, not weather
      const topTwoMemories = result.memories!.slice(0, 2);
      for (const memory of topTwoMemories) {
        assert.ok(
          memory.text.toLowerCase().includes('vector') ||
            memory.text.toLowerCase().includes('database') ||
            memory.text.toLowerCase().includes('postgresql'),
          'Top results should be database-related, not weather'
        );
      }

      // The weather memory should be ranked lower (if returned at all)
      const weatherIndex = result.memories!.findIndex((m) => m.text.includes('weather'));
      if (weatherIndex !== -1) {
        assert.ok(
          weatherIndex >= 2,
          'Weather memory should be ranked lower than database memories'
        );
      }
    });

    it('should filter memories using filter expressions', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-filters`;

      // Store memories with different tags
      const memories = [
        {
          text: 'Production database configuration',
          metadata: { tags: ['production', 'database'], source: 'test' },
        },
        {
          text: 'Test database setup',
          metadata: { tags: ['test', 'database'], source: 'test' },
        },
        {
          text: 'Development environment notes',
          metadata: { tags: ['development'], source: 'test' },
        },
      ];

      await harness.repository.upsertMemories(indexName, memories, {
        timestamp: new Date().toISOString(),
      });

      // Query with filter expression for test tag
      fakeRecallLLMClient.reset();

      const result = await harness.callRecall({
        query: 'database',
        index: indexName,
        limit: 10,
        filterExpression: '@metadata.tags CONTAINS "test"',
        responseMode: 'memories',
      });

      // Verify we got results
      assert.ok(result.memories && result.memories.length > 0, 'Should return filtered memories');

      // Verify exact count - only one memory should match the filter
      assert.strictEqual(
        result.memories!.length,
        1,
        'Should return exactly 1 memory with "test" tag'
      );

      // Verify the returned memory has the "test" tag
      const memory = result.memories![0];
      const tags = memory.metadata?.tags as string[] | undefined;
      assert.ok(
        Array.isArray(tags) && tags.includes('test'),
        `Memory should have "test" tag: ${memory.text}`
      );

      // Verify it's the correct memory (test database setup, not production)
      assert.ok(memory.text.includes('Test database'), 'Should return the test-tagged memory');
    });

    it('should verify cosine distance calculation matches database', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-cosine`;

      // Store a single memory
      const memoryText = 'Testing cosine similarity calculation with pgvector';
      const [memoryId] = await harness.repository.upsertMemories(
        indexName,
        [{ text: memoryText, metadata: { source: 'test' } }],
        { timestamp: new Date().toISOString() }
      );

      // Get the query embedding using the same fake embedding service
      const queryText = 'pgvector similarity testing';
      const queryVector = await fakeEmbeddingService.embedText(queryText);

      // Query the memory
      fakeRecallLLMClient.reset();

      const result = await harness.callRecall({
        query: queryText,
        index: indexName,
        limit: 10,
        responseMode: 'memories',
      });

      // Verify we got the memory
      assert.ok(result.memories && result.memories.length > 0, 'Should return the memory');
      const returnedMemory = result.memories!.find((m) => m.id === memoryId);
      assert.ok(returnedMemory, 'Should return the specific memory we stored');

      // Compute the expected score directly from database
      const dbScore = await harness.computeCosineScore(memoryId, queryVector);
      assert.ok(dbScore !== null, 'Should compute cosine score from database');

      // Verify the score matches (within small epsilon for floating point)
      const epsilon = 0.001;
      assert.ok(
        returnedMemory!.score !== undefined && Math.abs(returnedMemory!.score - dbScore!) < epsilon,
        `Returned score (${returnedMemory!.score}) should match DB score (${dbScore}) within ${epsilon}`
      );
    });

    it('should handle empty result set gracefully', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-empty`;

      // Create index but don't store any memories
      await harness.repository.ensureIndex(indexName, 'Empty test index');

      // Query the empty index
      fakeRecallLLMClient.reset();

      const result = await harness.callRecall({
        query: 'this will not match anything',
        index: indexName,
        limit: 10,
        responseMode: 'memories',
      });

      // Verify empty result
      assert.strictEqual(result.status, 'ok', 'Status should be ok even with no results');
      assert.ok(Array.isArray(result.memories), 'Memories should be an array');
      assert.strictEqual(result.memories!.length, 0, 'Should return empty array');

      // Verify search status indicates no results
      assert.strictEqual(
        result.searchStatus,
        'no_results',
        'Search status should be "no_results" for empty index'
      );

      // Verify diagnostics are present
      assert.ok(Array.isArray(result.searchDiagnostics), 'Should include search diagnostics');
    });

    it('should handle filter that excludes all results', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-filter-empty`;

      // Store memories with specific tags
      const memories = [
        {
          text: 'Memory with production tag',
          metadata: { tags: ['production'], source: 'test' },
        },
        {
          text: 'Memory with development tag',
          metadata: { tags: ['development'], source: 'test' },
        },
      ];

      await harness.repository.upsertMemories(indexName, memories, {
        timestamp: new Date().toISOString(),
      });

      // Query with filter that matches nothing
      fakeRecallLLMClient.reset();

      const result = await harness.callRecall({
        query: 'memory',
        index: indexName,
        limit: 10,
        filterExpression: '@metadata.tags CONTAINS "nonexistent"',
        responseMode: 'memories',
      });

      // Verify empty result due to filter
      assert.strictEqual(result.status, 'ok', 'Status should be ok');
      assert.strictEqual(result.memories!.length, 0, 'Should return no memories after filtering');
      assert.strictEqual(result.searchStatus, 'no_results', 'Search status should be "no_results"');
    });
  });

  describe('Response modes', () => {
    it('should support "memories" response mode', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-mode-memories`;

      await harness.repository.upsertMemories(
        indexName,
        [{ text: 'Test memory for response mode', metadata: { source: 'test' } }],
        { timestamp: new Date().toISOString() }
      );

      fakeRecallLLMClient.reset();

      const result = await harness.callRecall({
        query: 'test memory',
        index: indexName,
        responseMode: 'memories',
      });

      // In memories mode, we should get memories array
      assert.ok(result.memories && result.memories.length > 0, 'Should return memories array');
    });

    it('should support "answer" response mode', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-mode-answer`;

      await harness.repository.upsertMemories(
        indexName,
        [{ text: 'Test memory for answer mode', metadata: { source: 'test' } }],
        { timestamp: new Date().toISOString() }
      );

      fakeRecallLLMClient.reset();

      const result = await harness.callRecall({
        query: 'test memory',
        index: indexName,
        responseMode: 'answer',
      });

      // In answer mode, we should get an answer string
      assert.ok(result.answer, 'Should return answer');
      assert.ok(typeof result.answer === 'string', 'Answer should be a string');
    });
  });
});
