import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { resolve } from 'path';
import { MemoryAgent } from '../MemoryAgent.js';
import { PromptManager } from '../PromptManager.js';
import { ProjectFileLoader } from '../../memory/ProjectFileLoader.js';
import { TestServerHarness } from '../../../tests/helpers/TestServerHarness.js';
import { FakeLLMClient } from '../../../tests/helpers/FakeLLMClient.js';
import { FakeRecallLLMClient } from '../../../tests/helpers/FakeRecallLLMClient.js';
import { FakeForgetLLMClient } from '../../../tests/helpers/FakeForgetLLMClient.js';
import { ScriptedLLMClient } from '../../../tests/helpers/ScriptedLLMClient.js';
import { FakeEmbeddingService } from '../../../tests/helpers/FakeEmbeddingService.js';
import { loadBackendConfig } from '../../config/backend.js';

/**
 * E2E tests for MemoryAgent with full tool flows
 *
 * These tests exercise complete MCP tool flows (memorize → recall → forget, refine_memories,
 * create_index → list_indexes → scan) with mocked LLM responses but real Postgres operations.
 *
 * Tests use:
 * - Real PostgreSQL database (via TestServerHarness)
 * - Fake LLM clients for deterministic responses
 * - Fake embedding service for deterministic vectors
 * - Real repository operations (upsert, search, delete, etc.)
 */

const TEST_PROJECT_ID = 'agent-e2e-test';
const TEST_INDEX_PREFIX = 'e2e-test-';

describe('MemoryAgent E2E Tests', () => {
  let harness: TestServerHarness;
  let agent: MemoryAgent;
  let promptManager: PromptManager;
  let fileLoader: ProjectFileLoader;
  let embeddingService: FakeEmbeddingService;
  let databaseUrl: string;

  beforeAll(async () => {
    // Load test database configuration
    const config = await loadBackendConfig();
    const testConfig = config.projectRegistry.test;
    if (!testConfig) {
      throw new Error('Test project not found in backend config');
    }
    databaseUrl = testConfig.databaseUrl;

    // Create deterministic embedding service
    embeddingService = new FakeEmbeddingService(1536, 'test-embedding-model');

    // Create test harness with fake embedding service
    harness = new TestServerHarness(databaseUrl, TEST_PROJECT_ID, {
      embeddingService: embeddingService as never,
    });

    // Create prompt manager (Jest runs from project root, so process.cwd() works)
    const promptsDir = resolve(process.cwd(), 'prompts');
    promptManager = new PromptManager(promptsDir);

    // Create file loader
    fileLoader = new ProjectFileLoader(process.cwd());

    // Initial cleanup
    await harness.cleanupTestMemories(TEST_INDEX_PREFIX);
    await harness.cleanupTestIndexes(TEST_INDEX_PREFIX);
  });

  afterAll(async () => {
    // Final cleanup
    await harness.cleanupTestMemories(TEST_INDEX_PREFIX);
    await harness.cleanupTestIndexes(TEST_INDEX_PREFIX);
    await harness.close();
  });

  beforeEach(async () => {
    // Clean state before each test
    await harness.cleanupTestMemories(TEST_INDEX_PREFIX);
    await harness.cleanupTestIndexes(TEST_INDEX_PREFIX);
  });

  describe('Memorize → Recall → Forget Flow', () => {
    it('should complete full flow: memorize → recall → forget', async () => {
      const testIndex = `${TEST_INDEX_PREFIX}full-flow`;
      const testContent = 'Important project deadline on Friday';

      // Create index
      await harness.repository.ensureIndex(testIndex, 'Test index for full flow');

      // Step 1: Memorize
      const fakeLLM = new FakeLLMClient();
      agent = new MemoryAgent(fakeLLM as never, promptManager, harness.repository, fileLoader, {
        largeFileThresholdBytes: 256 * 1024,
        chunkSizeChars: 16_000,
        chunkOverlapChars: 2_000,
        maxChunksPerFile: 24,
        maxMemoriesPerFile: 50,
        projectId: TEST_PROJECT_ID,
      });

      const memorizeResult = await agent.memorize({ input: testContent }, testIndex);
      expect(memorizeResult.status).toBe('ok');
      expect(memorizeResult.storedCount).toBeGreaterThan(0);
      expect(memorizeResult.memoryIds).toBeDefined();
      expect(memorizeResult.memoryIds!.length).toBeGreaterThan(0);

      const memoryId = memorizeResult.memoryIds![0];

      // Verify memory exists in database
      const memoryRow = await harness.getMemoryRow(memoryId);
      expect(memoryRow).not.toBeNull();
      expect(memoryRow!.content).toContain('Friday');

      // Step 2: Recall
      const recallLLM = new FakeRecallLLMClient();
      agent = new MemoryAgent(recallLLM as never, promptManager, harness.repository, fileLoader, {
        largeFileThresholdBytes: 256 * 1024,
        chunkSizeChars: 16_000,
        chunkOverlapChars: 2_000,
        maxChunksPerFile: 24,
        maxMemoriesPerFile: 50,
        projectId: TEST_PROJECT_ID,
      });

      const recallResult = await agent.recall(
        { query: 'What is the project deadline?' },
        testIndex
      );
      expect(recallResult.status).toBe('ok');
      expect(recallResult.answer).toBeDefined();
      expect(recallResult.memories).toBeDefined();
      expect(recallResult.memories!.length).toBeGreaterThan(0);
      expect(recallResult.memories![0].id).toBe(memoryId);

      // Step 3: Forget (dry-run first)
      const forgetLLM = new FakeForgetLLMClient();
      agent = new MemoryAgent(forgetLLM as never, promptManager, harness.repository, fileLoader, {
        largeFileThresholdBytes: 256 * 1024,
        chunkSizeChars: 16_000,
        chunkOverlapChars: 2_000,
        maxChunksPerFile: 24,
        maxMemoriesPerFile: 50,
        projectId: TEST_PROJECT_ID,
      });

      const dryRunResult = await agent.forget(
        {
          input: 'project deadline',
          dryRun: true,
          explicitMemoryIds: [memoryId],
        },
        testIndex
      );
      expect(dryRunResult.status).toBe('ok');
      expect(dryRunResult.deletedCount).toBe(0);
      expect(dryRunResult.plan).toBeDefined();
      expect(dryRunResult.plan!.length).toBeGreaterThan(0);

      // Step 4: Forget (actual deletion)
      forgetLLM.reset();
      const forgetResult = await agent.forget(
        {
          input: 'project deadline',
          dryRun: false,
          explicitMemoryIds: [memoryId],
        },
        testIndex
      );
      expect(forgetResult.status).toBe('ok');
      expect(forgetResult.deletedCount).toBeGreaterThan(0);
      expect(forgetResult.deletedIds).toBeDefined();

      // Verify memory is deleted
      const deletedMemory = await harness.getMemoryRow(memoryId);
      expect(deletedMemory).toBeNull();
    });

    it('should handle multiple memories in memorize operation', async () => {
      const testIndex = `${TEST_INDEX_PREFIX}multi-memorize`;
      const testContent = 'First fact: API key is abc123. Second fact: Server runs on port 8080.';

      await harness.repository.ensureIndex(testIndex, 'Test index for multiple memories');

      const fakeLLM = new FakeLLMClient();
      agent = new MemoryAgent(fakeLLM as never, promptManager, harness.repository, fileLoader, {
        largeFileThresholdBytes: 256 * 1024,
        chunkSizeChars: 16_000,
        chunkOverlapChars: 2_000,
        maxChunksPerFile: 24,
        maxMemoriesPerFile: 50,
        projectId: TEST_PROJECT_ID,
      });

      const result = await agent.memorize({ input: testContent }, testIndex);
      expect(result.status).toBe('ok');
      expect(result.storedCount).toBeGreaterThan(0);
    });
  });

  describe('Refine Memories Flow', () => {
    it('should execute refine_memories with plan-only mode (dry-run)', async () => {
      const testIndex = `${TEST_INDEX_PREFIX}refine-dry`;

      // Create index and seed some memories
      await harness.repository.ensureIndex(testIndex, 'Test index for refine dry-run');

      const fakeLLM = new FakeLLMClient();
      agent = new MemoryAgent(fakeLLM as never, promptManager, harness.repository, fileLoader, {
        largeFileThresholdBytes: 256 * 1024,
        chunkSizeChars: 16_000,
        chunkOverlapChars: 2_000,
        maxChunksPerFile: 24,
        maxMemoriesPerFile: 50,
        projectId: TEST_PROJECT_ID,
      });

      // Memorize some test data
      await agent.memorize({ input: 'Test memory for refinement' }, testIndex);

      // Run refine_memories in plan-only mode with scripted LLM
      const scriptedLLM = new ScriptedLLMClient();

      // Queue a response that returns an empty plan (no actions needed)
      scriptedLLM.queueChatResponse({
        content: JSON.stringify({
          plan: [],
          reasoning: 'No refinement actions needed at this time',
          estimatedBudget: { upserts: 0, deletes: 0, searches: 0 },
        }),
        finishReason: 'stop',
        toolCalls: [],
      });

      agent = new MemoryAgent(scriptedLLM as never, promptManager, harness.repository, fileLoader, {
        largeFileThresholdBytes: 256 * 1024,
        chunkSizeChars: 16_000,
        chunkOverlapChars: 2_000,
        maxChunksPerFile: 24,
        maxMemoriesPerFile: 50,
        projectId: TEST_PROJECT_ID,
      });

      const result = await agent.refineMemories(
        {
          dryRun: true,
        },
        testIndex
      );

      expect(result.status).toBe('ok');
      expect(result.actions).toBeDefined();
      expect(Array.isArray(result.actions)).toBe(true);
    });

    it('should execute refine_memories with actual consolidation', async () => {
      const testIndex = `${TEST_INDEX_PREFIX}refine-exec`;

      // Create index and seed memories
      await harness.repository.ensureIndex(testIndex, 'Test index for refine execution');

      const fakeLLM = new FakeLLMClient();
      agent = new MemoryAgent(fakeLLM as never, promptManager, harness.repository, fileLoader, {
        largeFileThresholdBytes: 256 * 1024,
        chunkSizeChars: 16_000,
        chunkOverlapChars: 2_000,
        maxChunksPerFile: 24,
        maxMemoriesPerFile: 50,
        projectId: TEST_PROJECT_ID,
      });

      // Memorize some test data
      const memorizeResult = await agent.memorize(
        { input: 'Duplicate fact about testing' },
        testIndex
      );
      const memoryId = memorizeResult.memoryIds![0];

      // Run refine_memories with scripted responses
      const scriptedLLM = new ScriptedLLMClient();

      // Queue planning response
      scriptedLLM.queueChatResponse({
        content: JSON.stringify({
          plan: [
            {
              action: 'UPDATE',
              memoryId: memoryId,
              updates: {
                metadata: {
                  refined: true,
                },
              },
              reason: 'Mark as refined',
            },
          ],
          reasoning: 'Update metadata to mark memory as refined',
          estimatedBudget: { upserts: 1, deletes: 0, searches: 0 },
        }),
        finishReason: 'stop',
        toolCalls: [],
      });

      // Queue execution confirmation response
      scriptedLLM.queueChatResponse({
        content: JSON.stringify({
          executionSummary: 'Successfully updated 1 memory',
          newMemoryIds: [],
        }),
        finishReason: 'stop',
        toolCalls: [],
      });

      agent = new MemoryAgent(scriptedLLM as never, promptManager, harness.repository, fileLoader, {
        largeFileThresholdBytes: 256 * 1024,
        chunkSizeChars: 16_000,
        chunkOverlapChars: 2_000,
        maxChunksPerFile: 24,
        maxMemoriesPerFile: 50,
        projectId: TEST_PROJECT_ID,
      });

      const result = await agent.refineMemories(
        {
          dryRun: false,
        },
        testIndex
      );

      expect(result.status).toBe('ok');
      expect(result.actions).toBeDefined();

      const updatedRow = await harness.getMemoryRow(memoryId);
      expect(updatedRow).not.toBeNull();
      expect(updatedRow!.metadata.refined).toBe(true);
    });
  });

  describe('Index Lifecycle Flow', () => {
    it('should create index, list indexes, and scan memories', async () => {
      const testIndex = `${TEST_INDEX_PREFIX}lifecycle`;

      // Create a fake LLM for memorize operation
      const fakeLLM = new FakeLLMClient();
      agent = new MemoryAgent(fakeLLM as never, promptManager, harness.repository, fileLoader, {
        largeFileThresholdBytes: 256 * 1024,
        chunkSizeChars: 16_000,
        chunkOverlapChars: 2_000,
        maxChunksPerFile: 24,
        maxMemoriesPerFile: 50,
        projectId: TEST_PROJECT_ID,
      });

      // Step 1: Create index via agent
      const createResult = await agent.createIndex({
        name: testIndex,
        description: 'Test index for lifecycle',
      });
      expect(createResult.status).toBe('ok');

      // Step 2: Verify index exists
      const indexExists = await harness.verifyIndexInDatabase(testIndex);
      expect(indexExists).toBe(true);

      // Step 3: List indexes
      const listResult = await agent.listIndexes();
      expect(listResult.status).toBe('ok');
      expect(listResult.indexes).toBeDefined();
      const foundIndex = listResult.indexes!.find((idx) => idx.name === testIndex);
      expect(foundIndex).toBeDefined();
      expect(foundIndex!.description).toBe('Test index for lifecycle');

      // Step 4: Memorize some content
      await agent.memorize({ input: 'Test content for scanning' }, testIndex);

      // Step 5: Scan memories
      const scanResult = await agent.scanMemories({ query: 'test' }, testIndex);
      expect(scanResult.status).toBe('ok');
      expect(scanResult.results).toBeDefined();
      expect(scanResult.results!.length).toBeGreaterThan(0);
    });

    it('should handle scan with limit parameter', async () => {
      const testIndex = `${TEST_INDEX_PREFIX}scan-limit`;

      await harness.repository.ensureIndex(testIndex, 'Test index for scan with limit');

      const fakeLLM = new FakeLLMClient();
      agent = new MemoryAgent(fakeLLM as never, promptManager, harness.repository, fileLoader, {
        largeFileThresholdBytes: 256 * 1024,
        chunkSizeChars: 16_000,
        chunkOverlapChars: 2_000,
        maxChunksPerFile: 24,
        maxMemoriesPerFile: 50,
        projectId: TEST_PROJECT_ID,
      });

      // Memorize multiple entries
      await agent.memorize({ input: 'First entry' }, testIndex);
      fakeLLM.reset();
      await agent.memorize({ input: 'Second entry' }, testIndex);

      // Scan with limit
      const scanResult = await agent.scanMemories({ query: 'entry', limit: 1 }, testIndex);
      expect(scanResult.status).toBe('ok');
      expect(scanResult.results).toBeDefined();
      expect(scanResult.results!.length).toBeLessThanOrEqual(1);
    });
  });

  describe('Error Scenarios', () => {
    it('should handle LLM error gracefully in memorize', async () => {
      const testIndex = `${TEST_INDEX_PREFIX}error-llm`;

      await harness.repository.ensureIndex(testIndex, 'Test index for LLM error');

      // Create scripted LLM that throws an error
      const scriptedLLM = new ScriptedLLMClient();
      agent = new MemoryAgent(scriptedLLM as never, promptManager, harness.repository, fileLoader, {
        largeFileThresholdBytes: 256 * 1024,
        chunkSizeChars: 16_000,
        chunkOverlapChars: 2_000,
        maxChunksPerFile: 24,
        maxMemoriesPerFile: 50,
        projectId: TEST_PROJECT_ID,
      });

      // Don't queue any responses - this will cause chatWithTools to throw
      await expect(agent.memorize({ input: 'This should fail' }, testIndex)).rejects.toThrow();
    });

    it('should handle invalid index name', async () => {
      const fakeLLM = new FakeLLMClient();
      agent = new MemoryAgent(fakeLLM as never, promptManager, harness.repository, fileLoader, {
        largeFileThresholdBytes: 256 * 1024,
        chunkSizeChars: 16_000,
        chunkOverlapChars: 2_000,
        maxChunksPerFile: 24,
        maxMemoriesPerFile: 50,
        projectId: TEST_PROJECT_ID,
      });

      // Attempt to create index with empty name
      const result = await agent.createIndex({ name: '', description: 'Invalid index' });
      expect(result.status).toBe('error');
    });

    it('should handle recall on empty index', async () => {
      const testIndex = `${TEST_INDEX_PREFIX}empty-recall`;

      await harness.repository.ensureIndex(testIndex, 'Empty index for recall test');

      const recallLLM = new FakeRecallLLMClient();
      agent = new MemoryAgent(recallLLM as never, promptManager, harness.repository, fileLoader, {
        largeFileThresholdBytes: 256 * 1024,
        chunkSizeChars: 16_000,
        chunkOverlapChars: 2_000,
        maxChunksPerFile: 24,
        maxMemoriesPerFile: 50,
        projectId: TEST_PROJECT_ID,
      });

      const result = await agent.recall({ query: 'Find something' }, testIndex);
      expect(result.status).toBe('ok');
      expect(result.memories).toBeDefined();
      expect(result.memories!.length).toBe(0);
    });

    it('should handle forget with non-existent memory ID', async () => {
      const testIndex = `${TEST_INDEX_PREFIX}forget-missing`;

      await harness.repository.ensureIndex(testIndex, 'Test index for forget with missing ID');

      const forgetLLM = new FakeForgetLLMClient();
      agent = new MemoryAgent(forgetLLM as never, promptManager, harness.repository, fileLoader, {
        largeFileThresholdBytes: 256 * 1024,
        chunkSizeChars: 16_000,
        chunkOverlapChars: 2_000,
        maxChunksPerFile: 24,
        maxMemoriesPerFile: 50,
        projectId: TEST_PROJECT_ID,
      });

      const result = await agent.forget(
        {
          input: 'non-existent',
          dryRun: false,
          explicitMemoryIds: ['non-existent-id-12345'],
        },
        testIndex
      );

      expect(result.status).toBe('ok');
      expect(result.deletedCount).toBe(0);
    });
  });
});
