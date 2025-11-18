import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ReconsolidationExecutor } from '../ReconsolidationExecutor.js';
import { IMemoryRepository } from '../../memory/IMemoryRepository.js';
import { ReconsolidationPlan } from '../../memory/types.js';

// Mock repository
const createMockRepository = (): jest.Mocked<IMemoryRepository> => {
  return {
    upsertMemories: jest.fn<IMemoryRepository['upsertMemories']>(),
    markMemoriesSuperseded: jest.fn<IMemoryRepository['markMemoriesSuperseded']>(),
    incrementSleepCycles: jest.fn<IMemoryRepository['incrementSleepCycles']>(),
    searchMemories: jest.fn<IMemoryRepository['searchMemories']>(),
    getMemory: jest.fn<IMemoryRepository['getMemory']>(),
    getMemories: jest.fn<IMemoryRepository['getMemories']>(),
    deleteMemories: jest.fn<IMemoryRepository['deleteMemories']>(),
    updateAccessStats: jest.fn<IMemoryRepository['updateAccessStats']>(),
    ensureIndex: jest.fn<IMemoryRepository['ensureIndex']>(),
    testIndex: jest.fn<IMemoryRepository['testIndex']>(),
    getDatabaseInfo: jest.fn<IMemoryRepository['getDatabaseInfo']>(),
    listIndexes: jest.fn<IMemoryRepository['listIndexes']>(),
    getRelatedMemories: jest.fn<IMemoryRepository['getRelatedMemories']>(),
    findRelationshipPath: jest.fn<IMemoryRepository['findRelationshipPath']>(),
  } as jest.Mocked<IMemoryRepository>;
};

describe('ReconsolidationExecutor', () => {
  let executor: ReconsolidationExecutor;
  let mockRepo: jest.Mocked<IMemoryRepository>;

  beforeEach(() => {
    mockRepo = createMockRepository();
    executor = new ReconsolidationExecutor(mockRepo);
  });

  describe('execute', () => {
    it('should create derived memories and return report', async () => {
      const plan: ReconsolidationPlan = {
        derivedMemories: [
          {
            text: 'Consolidated pattern about creative process',
            memoryType: 'pattern',
            derivedFromIds: ['mem1', 'mem2', 'mem3'],
            relationships: [
              { targetId: 'mem1', type: 'summarizes' },
              { targetId: 'mem2', type: 'derived_from' },
            ],
            metadata: {
              topic: 'creative-workflow',
              importance: 'high',
            },
          },
        ],
        sleepCycleTargets: ['mem1', 'mem2'],
      };

      // Mock repository responses
      mockRepo.upsertMemories.mockResolvedValue(['derived-mem-1']);
      mockRepo.incrementSleepCycles.mockResolvedValue(3);

      const validMemoryIds = new Set(['mem1', 'mem2', 'mem3']);
      const report = await executor.execute(plan, 'test-index', validMemoryIds);

      // Verify created memories
      expect(mockRepo.upsertMemories).toHaveBeenCalledTimes(1);
      expect(mockRepo.upsertMemories).toHaveBeenCalledWith('test-index', [
        {
          text: 'Consolidated pattern about creative process',
          metadata: expect.objectContaining({
            memoryType: 'pattern',
            kind: 'derived',
            derivedFromIds: ['mem1', 'mem2', 'mem3'],
            source: 'system',
          }),
        },
      ]);

      // Verify sleep cycles incremented
      expect(mockRepo.incrementSleepCycles).toHaveBeenCalledTimes(1);
      expect(mockRepo.incrementSleepCycles).toHaveBeenCalledWith(
        'test-index',
        expect.arrayContaining(['mem1', 'mem2', 'derived-mem-1'])
      );

      // Verify report
      expect(report.createdMemoryIds).toEqual(['derived-mem-1']);
      expect(report.supersededPairs).toEqual([]);
      expect(report.sleepCycleIncrementedIds).toHaveLength(3);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle supersession pairs with memory ID references', async () => {
      const plan: ReconsolidationPlan = {
        derivedMemories: [
          {
            text: 'Evolved belief about consistency',
            memoryType: 'belief',
            derivedFromIds: ['old-belief-1', 'old-belief-2'],
          },
        ],
        supersessionPairs: [
          { sourceId: 'old-belief-1', supersededById: 'existing-mem-id' },
          { sourceId: 'old-belief-2', supersededById: 0 }, // Reference to derived memory index
        ],
      };

      mockRepo.upsertMemories.mockResolvedValue(['new-derived-mem']);
      mockRepo.markMemoriesSuperseded.mockResolvedValue(2);
      mockRepo.incrementSleepCycles.mockResolvedValue(1);

      const validMemoryIds = new Set(['old-belief-1', 'old-belief-2']);
      const report = await executor.execute(plan, 'test-index', validMemoryIds);

      // Verify supersessions were applied
      expect(mockRepo.markMemoriesSuperseded).toHaveBeenCalledTimes(1);
      expect(mockRepo.markMemoriesSuperseded).toHaveBeenCalledWith('test-index', [
        { sourceId: 'old-belief-1', supersededById: 'existing-mem-id' },
        { sourceId: 'old-belief-2', supersededById: 'new-derived-mem' }, // Index 0 resolved to created ID
      ]);

      expect(report.supersededPairs).toHaveLength(2);
      expect(report.supersededPairs).toContainEqual({
        sourceId: 'old-belief-1',
        supersededById: 'existing-mem-id',
      });
      expect(report.supersededPairs).toContainEqual({
        sourceId: 'old-belief-2',
        supersededById: 'new-derived-mem',
      });
    });

    it('should handle empty plan gracefully', async () => {
      const plan: ReconsolidationPlan = {
        derivedMemories: [],
      };

      const validMemoryIds = new Set<string>();
      const report = await executor.execute(plan, 'test-index', validMemoryIds);

      expect(mockRepo.upsertMemories).not.toHaveBeenCalled();
      expect(mockRepo.markMemoriesSuperseded).not.toHaveBeenCalled();
      expect(mockRepo.incrementSleepCycles).not.toHaveBeenCalled();

      expect(report.createdMemoryIds).toEqual([]);
      expect(report.supersededPairs).toEqual([]);
      expect(report.sleepCycleIncrementedIds).toEqual([]);
    });

    it('should handle errors gracefully and return partial report', async () => {
      const plan: ReconsolidationPlan = {
        derivedMemories: [
          {
            text: 'Test memory',
            memoryType: 'pattern',
            derivedFromIds: ['mem1'],
          },
        ],
      };

      mockRepo.upsertMemories.mockRejectedValue(new Error('Database error'));

      const validMemoryIds = new Set(['mem1']);
      const report = await executor.execute(plan, 'test-index', validMemoryIds);

      expect(report.createdMemoryIds).toEqual([]);
      expect(report.notes).toContain('Partial execution');
      expect(report.notes).toContain('Database error');
    });

    it('should warn if execution exceeds 500ms threshold', async () => {
      const plan: ReconsolidationPlan = {
        derivedMemories: [
          {
            text: 'Test memory',
            memoryType: 'pattern',
            derivedFromIds: ['mem1'],
          },
        ],
      };

      // Simulate slow operation
      mockRepo.upsertMemories.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(['derived-1']), 600);
          })
      );
      mockRepo.incrementSleepCycles.mockResolvedValue(1);

      const validMemoryIds = new Set(['mem1']);
      const report = await executor.execute(plan, 'test-index', validMemoryIds);

      expect(report.durationMs).toBeGreaterThan(500);
      expect(report.notes).toContain('Reconsolidation took');
      expect(report.notes).toContain('threshold: 500ms');
    });

    it('should include plan notes in report', async () => {
      const plan: ReconsolidationPlan = {
        derivedMemories: [
          {
            text: 'Test memory',
            memoryType: 'pattern',
            derivedFromIds: ['mem1'],
          },
        ],
        notes: 'Consolidated 3 episodes into pattern',
      };

      mockRepo.upsertMemories.mockResolvedValue(['derived-1']);
      mockRepo.incrementSleepCycles.mockResolvedValue(1);

      const validMemoryIds = new Set(['mem1']);
      const report = await executor.execute(plan, 'test-index', validMemoryIds);

      expect(report.notes).toContain('Consolidated 3 episodes into pattern');
    });

    it('should deduplicate sleep cycle targets with created IDs', async () => {
      const plan: ReconsolidationPlan = {
        derivedMemories: [
          {
            text: 'Test memory',
            memoryType: 'pattern',
            derivedFromIds: ['mem1', 'mem2'],
          },
        ],
        sleepCycleTargets: ['mem1', 'mem2', 'mem1'], // Duplicate mem1
      };

      mockRepo.upsertMemories.mockResolvedValue(['derived-1']);
      mockRepo.incrementSleepCycles.mockResolvedValue(3);

      const validMemoryIds = new Set(['mem1', 'mem2']);
      const report = await executor.execute(plan, 'test-index', validMemoryIds);

      // Should include mem1, mem2 (deduplicated), and derived-1
      expect(report.sleepCycleIncrementedIds).toHaveLength(3);
      expect(report.sleepCycleIncrementedIds).toContain('mem1');
      expect(report.sleepCycleIncrementedIds).toContain('mem2');
      expect(report.sleepCycleIncrementedIds).toContain('derived-1');
    });
  });
});
