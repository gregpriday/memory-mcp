import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import { config } from 'dotenv';
import { loadBackendConfig } from '../src/config/backend.js';
import { TestServerHarness } from './helpers/TestServerHarness.js';
import { FakeEmbeddingService } from './helpers/FakeEmbeddingService.js';
import { ScriptedLLMClient } from './helpers/ScriptedLLMClient.js';
import type { LLMClient, LLMResponse } from '../src/llm/LLMClient.js';

// Load environment variables
config();

describe('Refine Memories Tool Integration Tests', () => {
  let harness: TestServerHarness;
  let scriptedLLM: ScriptedLLMClient;
  const testProjectId = 'refine-tools-test';
  const testIndexPrefix = 'refine-test-';

  before(async () => {
    // Load database URL from backend config (projects.json)
    const backendConfig = loadBackendConfig();
    const databaseUrl = backendConfig.activeProject.databaseUrl;

    // Create harness with scripted LLM and fake embedding service
    scriptedLLM = new ScriptedLLMClient();
    harness = new TestServerHarness(databaseUrl, testProjectId, {
      embeddingService: new FakeEmbeddingService(1536),
      llmClient: scriptedLLM as LLMClient, // ScriptedLLMClient implements LLMClient interface
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
    // Reset scripted LLM for next test
    if (scriptedLLM) {
      scriptedLLM.reset();
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

  /**
   * Helper to seed test memories with explicit IDs
   */
  async function seedMemories(
    indexName: string,
    memories: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>
  ): Promise<void> {
    for (const mem of memories) {
      await harness.repository.upsertMemories(
        indexName,
        [
          {
            text: mem.text,
            metadata: {
              source: 'user',
              timestamp: new Date().toISOString(),
              ...mem.metadata,
            },
            id: mem.id,
          },
        ],
        {}
      );
    }
  }

  /**
   * Helper to get memory by ID from repository
   */
  async function getMemory(indexName: string, memoryId: string) {
    return await harness.repository.getMemory(indexName, memoryId);
  }

  /**
   * Helper to check if memory exists in database
   */
  async function memoryExists(memoryId: string): Promise<boolean> {
    const row = await harness.getMemoryRow(memoryId);
    return row !== null;
  }

  describe('Dry-run budget enforcement', () => {
    it('should enforce budget limit and report validator failures in dry-run mode', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-budget`;

      // Ensure DELETE operations are disabled to test validator rejection
      const originalDeleteFlag = process.env.MEMORY_REFINE_ALLOW_DELETE;
      process.env.MEMORY_REFINE_ALLOW_DELETE = 'false';

      try {
        // Seed test memories
        await seedMemories(indexName, [
          { id: 'mem_update_1', text: 'First memory to update', metadata: { topic: 'test' } },
          { id: 'mem_update_2', text: 'Second memory to update', metadata: { topic: 'test' } },
          { id: 'mem_merge_target', text: 'Merge target memory', metadata: { topic: 'merge' } },
          {
            id: 'sys_protected',
            text: 'System memory (protected)',
            metadata: { source: 'system', topic: 'protected' },
          },
        ]);

        // Script LLM to return a plan with 4 actions (budget will limit to 2)
        // Include one invalid action (DELETE system memory) that validator should reject
        const refinePlanResponse: LLMResponse = {
          content: JSON.stringify({
            actions: [
              {
                type: 'DELETE',
                reason: 'Try to delete system memory (should fail validation)',
                deleteIds: ['sys_protected'],
              },
              {
                type: 'UPDATE',
                reason: 'Update priority for first memory',
                id: 'mem_update_1',
                metadataUpdates: { importance: 'high' },
              },
              {
                type: 'UPDATE',
                reason: 'Update topic for second memory',
                id: 'mem_update_2',
                metadataUpdates: { topic: 'updated' },
              },
              {
                type: 'MERGE',
                reason: 'Test merge action (will exceed budget)',
                targetId: 'mem_merge_target',
                mergeSourceIds: ['mem_update_1'],
                mergedMetadata: { merged: true },
              },
            ],
          }),
          finishReason: 'stop',
        };

        scriptedLLM.queueChatResponse(refinePlanResponse);

        // Call refine_memories with budget=2 (default is dry run)
        const result = await harness.callRefineMemories({
          index: indexName,
          budget: 2,
        });

        // Verify dry run mode
        assert.strictEqual(result.dryRun, true, 'Should be in dry-run mode by default');

        // Verify budget enforcement - status should be budget_reached
        assert.strictEqual(
          result.status,
          'budget_reached',
          'Status should indicate budget was reached'
        );

        // Verify only budget-limited actions are returned (first 2 valid actions)
        assert.ok(result.actions, 'Actions should be present in result');
        assert.ok(result.actions!.length <= 2, 'Should return at most budget count of actions');

        // Verify skipped count reflects validator failures (DELETE action within budget)
        // Note: Actions beyond budget are dropped, not counted as skipped
        // Only validated actions within budget that fail count as skipped
        assert.ok(
          result.skippedActionsCount !== undefined,
          'Skipped actions count should be reported'
        );
        assert.strictEqual(
          result.skippedActionsCount,
          1,
          'Should have 1 skipped action (DELETE failed validation within budget)'
        );

        // Verify error message includes validator information
        assert.ok(result.error, 'Should report validation errors');
        assert.ok(
          result.error.toLowerCase().includes('delete') ||
            result.error.toLowerCase().includes('protected'),
          'Error should mention DELETE or protected memory issue'
        );

        // Verify no actual DB mutations occurred (dry run)
        const mem1 = await getMemory(indexName, 'mem_update_1');
        assert.strictEqual(
          mem1?.metadata.importance,
          undefined,
          'First memory should not be updated in dry-run mode'
        );

        const sysMemExists = await memoryExists('sys_protected');
        assert.strictEqual(sysMemExists, true, 'System memory should still exist');
      } finally {
        // Restore original DELETE flag
        if (originalDeleteFlag !== undefined) {
          process.env.MEMORY_REFINE_ALLOW_DELETE = originalDeleteFlag;
        } else {
          delete process.env.MEMORY_REFINE_ALLOW_DELETE;
        }
      }
    });
  });

  describe('Execution mode with all action types', () => {
    it('should execute UPDATE, MERGE, CREATE, DELETE actions when dryRun=false', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-execution`;

      // Enable DELETE operations via environment variable
      const originalDeleteFlag = process.env.MEMORY_REFINE_ALLOW_DELETE;
      process.env.MEMORY_REFINE_ALLOW_DELETE = 'true';

      try {
        // Seed test memories with explicit IDs
        await seedMemories(indexName, [
          {
            id: 'mem_update_target',
            text: 'Memory to update',
            metadata: { topic: 'old-topic', importance: 'low' },
          },
          {
            id: 'mem_merge_target',
            text: 'Merge target',
            metadata: { topic: 'merge', version: 1 },
          },
          {
            id: 'mem_merge_source1',
            text: 'Merge source 1',
            metadata: { topic: 'merge', detail: 'source1' },
          },
          {
            id: 'mem_merge_source2',
            text: 'Merge source 2',
            metadata: { topic: 'merge', detail: 'source2' },
          },
          {
            id: 'mem_to_delete',
            text: 'Memory to delete',
            metadata: { topic: 'obsolete', importance: 'low' },
          },
        ]);

        // Script LLM to return a plan with all action types
        const refinePlanResponse: LLMResponse = {
          content: JSON.stringify({
            actions: [
              {
                type: 'UPDATE',
                reason: 'Update metadata and text',
                id: 'mem_update_target',
                textUpdate: 'Updated memory text',
                metadataUpdates: { topic: 'new-topic', importance: 'high', updated: true },
              },
              {
                type: 'MERGE',
                reason: 'Consolidate merge sources into target',
                targetId: 'mem_merge_target',
                mergeSourceIds: ['mem_merge_source1', 'mem_merge_source2'],
                mergedText: 'Merged content from sources',
                mergedMetadata: { merged: true, sourceCount: 2 },
              },
              {
                type: 'CREATE',
                reason: 'Create derived summary memory',
                newMemory: {
                  text: 'Summary of merged memories',
                  metadata: {
                    source: 'system',
                    memoryType: 'pattern',
                    kind: 'derived',
                    importance: 'high',
                    topic: 'merge-summary',
                    derivedFromIds: ['mem_merge_target', 'mem_update_target'],
                  },
                },
              },
              {
                type: 'DELETE',
                reason: 'Remove obsolete memory',
                deleteIds: ['mem_to_delete'],
              },
            ],
          }),
          finishReason: 'stop',
        };

        scriptedLLM.queueChatResponse(refinePlanResponse);

        // Call refine_memories with dryRun=false
        const result = await harness.callRefineMemories({
          index: indexName,
          dryRun: false,
          budget: 10, // High budget to allow all actions
        });

        // Verify execution mode
        assert.strictEqual(result.dryRun, false, 'Should be in execution mode');
        assert.strictEqual(result.status, 'ok', 'Status should be ok');

        // Verify all actions were applied
        assert.strictEqual(result.appliedActionsCount, 4, 'Should have applied all 4 actions');

        // Verify UPDATE action - check DB state
        const updatedMem = await getMemory(indexName, 'mem_update_target');
        assert.ok(updatedMem, 'Updated memory should exist');
        assert.strictEqual(
          updatedMem!.content.text,
          'Updated memory text',
          'Text should be updated'
        );
        assert.strictEqual(updatedMem!.metadata.topic, 'new-topic', 'Topic should be updated');
        assert.strictEqual(updatedMem!.metadata.importance, 'high', 'Importance should be updated');
        assert.strictEqual(updatedMem!.metadata.updated, true, 'Should have new metadata field');

        // Verify MERGE action - target enriched, sources deleted or marked
        const mergeTarget = await getMemory(indexName, 'mem_merge_target');
        assert.ok(mergeTarget, 'Merge target should exist');
        assert.strictEqual(
          mergeTarget!.content.text,
          'Merged content from sources',
          'Merge target text should be updated'
        );
        assert.strictEqual(mergeTarget!.metadata.merged, true, 'Should have merged flag');
        assert.strictEqual(mergeTarget!.metadata.sourceCount, 2, 'Should track source count');

        // Verify merge sources were deleted or marked superseded
        const source1Exists = await memoryExists('mem_merge_source1');
        const source2Exists = await memoryExists('mem_merge_source2');
        const sourcesRemoved = !source1Exists && !source2Exists;

        // If sources still exist, they should be marked as superseded
        if (!sourcesRemoved) {
          const source1 = await getMemory(indexName, 'mem_merge_source1');
          const source2 = await getMemory(indexName, 'mem_merge_source2');
          assert.ok(
            source1?.metadata.supersededBy || source2?.metadata.supersededBy,
            'Merge sources should be marked as superseded if not deleted'
          );
        }

        // Verify CREATE action - new derived memory exists
        assert.ok(result.newMemoryIds, 'Should report new memory IDs');
        assert.strictEqual(result.newMemoryIds!.length, 1, 'Should have created 1 new memory');

        const newMemoryId = result.newMemoryIds![0];
        const newMemory = await getMemory(indexName, newMemoryId);
        assert.ok(newMemory, 'New derived memory should exist');
        assert.strictEqual(
          newMemory!.content.text,
          'Summary of merged memories',
          'New memory should have correct text'
        );
        assert.strictEqual(
          newMemory!.metadata.memoryType,
          'pattern',
          'Should be marked as pattern type'
        );
        assert.strictEqual(newMemory!.metadata.kind, 'derived', 'Should be marked as derived kind');
        assert.deepStrictEqual(
          newMemory!.metadata.derivedFromIds,
          ['mem_merge_target', 'mem_update_target'],
          'Should track source memory IDs'
        );

        // Verify DELETE action - memory removed from DB
        const deletedExists = await memoryExists('mem_to_delete');
        assert.strictEqual(deletedExists, false, 'Deleted memory should not exist');
      } finally {
        // Restore original DELETE flag
        if (originalDeleteFlag !== undefined) {
          process.env.MEMORY_REFINE_ALLOW_DELETE = originalDeleteFlag;
        } else {
          delete process.env.MEMORY_REFINE_ALLOW_DELETE;
        }
      }
    });
  });

  describe('Validator and system memory protections', () => {
    it('should reject actions targeting system memories or invalid IDs', async () => {
      const indexName = `${testIndexPrefix}${Date.now()}-validation`;

      // Seed test memories including system-protected ones
      await seedMemories(indexName, [
        {
          id: 'sys_guardian',
          text: 'System guardian memory',
          metadata: { source: 'system', topic: 'system', importance: 'high' },
        },
        {
          id: 'sys_config',
          text: 'System configuration',
          metadata: { source: 'system', memoryType: 'semantic' },
        },
        {
          id: 'mem_valid',
          text: 'Valid user memory',
          metadata: { source: 'user', topic: 'test' },
        },
      ]);

      // Script LLM to return a plan with invalid actions
      const refinePlanResponse: LLMResponse = {
        content: JSON.stringify({
          actions: [
            {
              type: 'UPDATE',
              reason: 'Try to update system memory (should be rejected)',
              id: 'sys_guardian',
              metadataUpdates: { tampered: true },
            },
            {
              type: 'DELETE',
              reason: 'Try to delete system memory (should be rejected)',
              deleteIds: ['sys_config'],
            },
            {
              type: 'UPDATE',
              reason: 'Try to update non-existent memory (should be rejected)',
              id: 'mem_nonexistent',
              metadataUpdates: { exists: false },
            },
            {
              type: 'MERGE',
              reason: 'Try to merge with system memory as source (should be rejected)',
              targetId: 'mem_valid',
              mergeSourceIds: ['sys_guardian'],
            },
          ],
        }),
        finishReason: 'stop',
      };

      scriptedLLM.queueChatResponse(refinePlanResponse);

      // Call refine_memories with dryRun=false (to test validator blocks execution)
      const result = await harness.callRefineMemories({
        index: indexName,
        dryRun: false,
        budget: 10,
      });

      // Verify no actions were applied (all should be rejected by validator)
      assert.strictEqual(
        result.appliedActionsCount,
        0,
        'No actions should be applied (all invalid)'
      );

      // Verify error field contains validator messages
      assert.ok(result.error, 'Should report validation errors');
      assert.ok(
        result.error.toLowerCase().includes('system') ||
          result.error.toLowerCase().includes('protected'),
        'Error should mention system memory protection'
      );

      // Verify system memories are untouched
      const sysGuardian = await getMemory(indexName, 'sys_guardian');
      assert.ok(sysGuardian, 'System guardian should still exist');
      assert.strictEqual(
        sysGuardian!.metadata.tampered,
        undefined,
        'System guardian should not be modified'
      );

      const sysConfig = await getMemory(indexName, 'sys_config');
      assert.ok(sysConfig, 'System config should still exist (not deleted)');

      const validMem = await getMemory(indexName, 'mem_valid');
      assert.ok(validMem, 'Valid memory should still exist');
      // Verify it wasn't merged with system memory
      assert.strictEqual(validMem!.metadata.merged, undefined, 'Valid memory should not be merged');
    });
  });
});
