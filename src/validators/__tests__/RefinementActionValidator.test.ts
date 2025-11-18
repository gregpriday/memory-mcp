import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  validateAction,
  createActionValidator,
  UpdateActionValidator,
  MergeActionValidator,
  CreateActionValidator,
  DeleteActionValidator,
  ValidationContext,
} from '../RefinementActionValidator.js';
import {
  UpdateRefinementAction,
  MergeRefinementAction,
  CreateRefinementAction,
  DeleteRefinementAction,
  MemoryRecord,
} from '../../memory/types.js';
import { IMemoryRepository } from '../../memory/IMemoryRepository.js';
import { RefinementConfig } from '../../config/refinement.js';
import { MemorySearchError } from '../../memory/MemorySearchError.js';

const forceType = <T>(value: unknown): T => value as T;

// Mock repository implementation
class MockMemoryRepository implements Partial<IMemoryRepository> {
  private memories: Map<string, MemoryRecord> = new Map();
  private errorToThrow: Error | null = null;

  setMemory(indexName: string, memory: MemoryRecord): void {
    const key = `${indexName}:${memory.id}`;
    this.memories.set(key, memory);
  }

  setErrorToThrow(error: Error | null): void {
    this.errorToThrow = error;
  }

  async getMemory(indexName: string, id: string): Promise<MemoryRecord | null> {
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
    const key = `${indexName}:${id}`;
    return this.memories.get(key) || null;
  }

  async getMemories(indexName: string, ids: string[]): Promise<MemoryRecord[]> {
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
    const results: MemoryRecord[] = [];
    for (const id of ids) {
      const memory = await this.getMemory(indexName, id);
      if (memory) {
        results.push(memory);
      }
    }
    return results;
  }

  clear(): void {
    this.memories.clear();
    this.errorToThrow = null;
  }
}

describe('RefinementActionValidator', () => {
  let mockRepo: MockMemoryRepository;
  let context: ValidationContext;

  beforeEach(() => {
    mockRepo = new MockMemoryRepository();
    context = {
      indexName: 'test-index',
      repository: mockRepo as unknown as IMemoryRepository,
      config: {
        defaultBudget: 100,
        allowDelete: true,
        accessTrackingEnabled: true,
        accessTrackingTopN: 10,
        accessPriorityBoost: 0.1,
        queryExpansionEnabled: false,
        queryExpansionCount: 3,
      } as RefinementConfig,
    };
  });

  describe('createActionValidator', () => {
    it('should create UpdateActionValidator for UPDATE type', () => {
      const validator = createActionValidator('UPDATE');
      expect(validator).toBeInstanceOf(UpdateActionValidator);
    });

    it('should create MergeActionValidator for MERGE type', () => {
      const validator = createActionValidator('MERGE');
      expect(validator).toBeInstanceOf(MergeActionValidator);
    });

    it('should create CreateActionValidator for CREATE type', () => {
      const validator = createActionValidator('CREATE');
      expect(validator).toBeInstanceOf(CreateActionValidator);
    });

    it('should create DeleteActionValidator for DELETE type', () => {
      const validator = createActionValidator('DELETE');
      expect(validator).toBeInstanceOf(DeleteActionValidator);
    });

    it('should throw error for unknown action type', () => {
      expect(() => createActionValidator(forceType('UNKNOWN'))).toThrow('Unknown action type');
    });
  });

  describe('UpdateActionValidator', () => {
    const createUpdateAction = (
      overrides?: Partial<UpdateRefinementAction>
    ): UpdateRefinementAction => ({
      type: 'UPDATE',
      reason: 'test reason',
      id: 'test-id',
      metadataUpdates: { importance: 'high' },
      ...overrides,
    });

    beforeEach(() => {
      // Add a normal memory to the repository
      mockRepo.setMemory('test-index', {
        id: 'test-id',
        content: {
          text: 'Test memory',
          timestamp: new Date().toISOString(),
        },
        metadata: {
          index: 'test-index',
          source: 'user',
          importance: 'medium',
        },
      });
    });

    it('should accept valid UPDATE action', async () => {
      const action = createUpdateAction();
      const result = await validateAction(action, context);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept UPDATE with textUpdate only', async () => {
      const action = createUpdateAction({
        textUpdate: 'Updated text',
        metadataUpdates: undefined,
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept UPDATE with metadataUpdates only', async () => {
      const action = createUpdateAction({
        textUpdate: undefined,
        metadataUpdates: { tags: ['tag1', 'tag2'] },
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject UPDATE without id', async () => {
      const action = createUpdateAction({ id: forceType('') });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('UPDATE action missing required field: id');
    });

    it('should reject UPDATE without textUpdate or metadataUpdates', async () => {
      const action = createUpdateAction({
        textUpdate: undefined,
        metadataUpdates: undefined,
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'UPDATE action must have either textUpdate or metadataUpdates'
      );
    });

    it('should reject UPDATE for system memory (sys_ prefix)', async () => {
      const action = createUpdateAction({ id: 'sys_memory' });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Cannot UPDATE system memory'))).toBe(true);
    });

    it('should reject UPDATE for system memory (metadata source)', async () => {
      mockRepo.setMemory('test-index', {
        id: 'user-memory',
        content: {
          text: 'System memory',
          timestamp: new Date().toISOString(),
        },
        metadata: {
          index: 'test-index',
          source: 'system',
          importance: 'high',
        },
      });

      const action = createUpdateAction({ id: 'user-memory' });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Cannot UPDATE system memory'))).toBe(true);
    });

    it('should reject UPDATE for non-existent memory', async () => {
      const action = createUpdateAction({ id: 'non-existent' });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('not found'))).toBe(true);
    });

    it('should reject UPDATE with forbidden metadata field: id', async () => {
      const action = createUpdateAction({
        metadataUpdates: forceType({ id: 'new-id' }),
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('forbidden metadata fields'))).toBe(true);
    });

    it('should reject UPDATE with forbidden metadata field: index', async () => {
      const action = createUpdateAction({
        metadataUpdates: forceType({ index: 'new-index' }),
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('forbidden metadata fields'))).toBe(true);
    });

    it('should reject UPDATE with invalid priority value (< 0)', async () => {
      const action = createUpdateAction({
        metadataUpdates: forceType({ priority: -0.1 }),
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('priority'))).toBe(true);
    });

    it('should reject UPDATE with invalid priority value (> 1)', async () => {
      const action = createUpdateAction({
        metadataUpdates: forceType({ priority: 1.5 }),
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('priority'))).toBe(true);
    });

    it('should reject UPDATE with non-number priority', async () => {
      const action = createUpdateAction({
        metadataUpdates: forceType({ priority: 'high' }),
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('priority'))).toBe(true);
    });

    it('should accept UPDATE with valid priority (0)', async () => {
      const action = createUpdateAction({
        metadataUpdates: forceType({ priority: 0 }),
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept UPDATE with valid priority (1)', async () => {
      const action = createUpdateAction({
        metadataUpdates: forceType({ priority: 1 }),
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept UPDATE with valid priority (0.5)', async () => {
      const action = createUpdateAction({
        metadataUpdates: forceType({ priority: 0.5 }),
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle MemorySearchError from repository gracefully', async () => {
      const searchError = new MemorySearchError('Database connection failed', {
        index: 'test-index',
        query: 'test query',
        limit: 10,
        semanticWeight: 0.7,
        reranking: false,
        durationMs: 100,
        status: 'search_error',
        resultCount: 0,
        retryCount: 3,
        timestamp: new Date().toISOString(),
        lastError: 'Connection timeout',
      });
      mockRepo.setErrorToThrow(searchError);

      const action = createUpdateAction({ id: 'test-id' });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Database connection failed');
      expect(result.errors[0]).toContain('status: search_error');
    });

    it('should handle generic repository errors gracefully', async () => {
      mockRepo.setErrorToThrow(new Error('Unexpected database error'));

      const action = createUpdateAction({ id: 'test-id' });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Validation error: Unexpected database error');
    });
  });

  describe('MergeActionValidator', () => {
    const createMergeAction = (
      overrides?: Partial<MergeRefinementAction>
    ): MergeRefinementAction => ({
      type: 'MERGE',
      reason: 'test merge',
      targetId: 'target-1',
      mergeSourceIds: ['source-1', 'source-2'],
      ...overrides,
    });

    beforeEach(() => {
      // Add memories to repository
      mockRepo.setMemory('test-index', {
        id: 'target-1',
        content: {
          text: 'Target memory',
          timestamp: new Date().toISOString(),
        },
        metadata: { index: 'test-index', source: 'user', importance: 'medium' },
      });
      mockRepo.setMemory('test-index', {
        id: 'source-1',
        content: {
          text: 'Source memory 1',
          timestamp: new Date().toISOString(),
        },
        metadata: { index: 'test-index', source: 'user', importance: 'low' },
      });
      mockRepo.setMemory('test-index', {
        id: 'source-2',
        content: {
          text: 'Source memory 2',
          timestamp: new Date().toISOString(),
        },
        metadata: { index: 'test-index', source: 'user', importance: 'low' },
      });
    });

    it('should accept valid MERGE action', async () => {
      const action = createMergeAction();
      const result = await validateAction(action, context);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject MERGE without targetId', async () => {
      const action = createMergeAction({ targetId: forceType('') });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('MERGE action missing required field: targetId');
    });

    it('should reject MERGE without mergeSourceIds', async () => {
      const action = createMergeAction({ mergeSourceIds: forceType(undefined) });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('MERGE action missing required field: mergeSourceIds');
    });

    it('should reject MERGE with empty mergeSourceIds', async () => {
      const action = createMergeAction({ mergeSourceIds: [] });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('MERGE action missing required field: mergeSourceIds');
    });

    it('should reject MERGE when targetId is in mergeSourceIds (self-merge)', async () => {
      const action = createMergeAction({
        targetId: 'target-1',
        mergeSourceIds: ['source-1', 'target-1'],
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('cannot include targetId'))).toBe(true);
    });

    it('should reject MERGE with duplicate source IDs', async () => {
      mockRepo.setMemory('test-index', {
        id: 'source-3',
        content: {
          text: 'Source memory 3',
          timestamp: new Date().toISOString(),
        },
        metadata: { index: 'test-index', source: 'user', importance: 'low' },
      });

      const action = createMergeAction({
        mergeSourceIds: ['source-1', 'source-2', 'source-1'],
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('MERGE action contains duplicate IDs in mergeSourceIds');
    });

    it('should reject MERGE with system memory as target (sys_ prefix)', async () => {
      const action = createMergeAction({ targetId: 'sys_target' });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Cannot use system memory'))).toBe(true);
    });

    it('should reject MERGE with system memory in sources (sys_ prefix)', async () => {
      mockRepo.setMemory('test-index', {
        id: 'sys_source',
        content: {
          text: 'System source',
          timestamp: new Date().toISOString(),
        },
        metadata: { index: 'test-index', source: 'system', importance: 'high' },
      });

      const action = createMergeAction({
        mergeSourceIds: ['source-1', 'sys_source'],
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Cannot MERGE system memories'))).toBe(true);
    });

    it('should reject MERGE with system memory in sources (metadata)', async () => {
      mockRepo.setMemory('test-index', {
        id: 'source-system',
        content: {
          text: 'System source',
          timestamp: new Date().toISOString(),
        },
        metadata: { index: 'test-index', source: 'system', importance: 'high' },
      });

      const action = createMergeAction({
        mergeSourceIds: ['source-1', 'source-system'],
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Cannot MERGE system memories'))).toBe(true);
    });

    it('should reject MERGE with system memory as target (metadata only)', async () => {
      // Override target-1 to be a system memory via metadata (no sys_ prefix)
      mockRepo.setMemory('test-index', {
        id: 'target-1',
        content: {
          text: 'Target that is system via metadata',
          timestamp: new Date().toISOString(),
        },
        metadata: { index: 'test-index', source: 'system', importance: 'high' },
      });

      const action = createMergeAction({
        targetId: 'target-1',
        mergeSourceIds: ['source-1', 'source-2'],
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Cannot MERGE system memories'))).toBe(true);
      expect(result.errors.some((e) => e.includes('marked as system'))).toBe(true);
    });

    it('should reject MERGE with non-existent target', async () => {
      const action = createMergeAction({ targetId: 'non-existent' });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('non-existent IDs'))).toBe(true);
    });

    it('should reject MERGE with non-existent source', async () => {
      const action = createMergeAction({
        mergeSourceIds: ['source-1', 'non-existent'],
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('non-existent IDs'))).toBe(true);
    });
  });

  describe('CreateActionValidator', () => {
    const createCreateAction = (
      overrides?: Partial<CreateRefinementAction>
    ): CreateRefinementAction => ({
      type: 'CREATE',
      reason: 'test create',
      newMemory: {
        text: 'New memory text',
        metadata: { importance: 'high' },
      },
      ...overrides,
    });

    it('should accept valid CREATE action', async () => {
      const action = createCreateAction();
      const result = await validateAction(action, context);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept CREATE with derivedFromIds referencing existing memories', async () => {
      mockRepo.setMemory('test-index', {
        id: 'source-1',
        content: {
          text: 'Source memory',
          timestamp: new Date().toISOString(),
        },
        metadata: { index: 'test-index', source: 'user', importance: 'medium' },
      });

      const action = createCreateAction({
        newMemory: {
          text: 'Derived memory',
          metadata: { derivedFromIds: ['source-1'] },
        },
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject CREATE without newMemory', async () => {
      const action = createCreateAction({ newMemory: forceType(undefined) });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('CREATE action missing required field: newMemory');
    });

    it('should reject CREATE with empty text', async () => {
      const action = createCreateAction({
        newMemory: { text: '' },
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('CREATE action newMemory.text must be non-empty');
    });

    it('should reject CREATE with whitespace-only text', async () => {
      const action = createCreateAction({
        newMemory: { text: '   \n  \t  ' },
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('CREATE action newMemory.text must be non-empty');
    });

    it('should reject CREATE with non-existent derivedFromIds', async () => {
      const action = createCreateAction({
        newMemory: {
          text: 'New memory',
          metadata: { derivedFromIds: ['non-existent'] },
        },
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('non-existent IDs'))).toBe(true);
    });

    it('should reject CREATE with some non-existent derivedFromIds', async () => {
      mockRepo.setMemory('test-index', {
        id: 'source-1',
        content: {
          text: 'Source memory',
          timestamp: new Date().toISOString(),
        },
        metadata: { index: 'test-index', source: 'user', importance: 'medium' },
      });

      const action = createCreateAction({
        newMemory: {
          text: 'New memory',
          metadata: { derivedFromIds: ['source-1', 'non-existent'] },
        },
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('non-existent'))).toBe(true);
    });

    it('should accept CREATE with empty derivedFromIds array', async () => {
      const action = createCreateAction({
        newMemory: {
          text: 'New memory',
          metadata: { derivedFromIds: [] },
        },
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('DeleteActionValidator', () => {
    const createDeleteAction = (
      overrides?: Partial<DeleteRefinementAction>
    ): DeleteRefinementAction => ({
      type: 'DELETE',
      reason: 'test delete',
      deleteIds: ['delete-1', 'delete-2'],
      ...overrides,
    });

    beforeEach(() => {
      mockRepo.setMemory('test-index', {
        id: 'delete-1',
        content: {
          text: 'Memory to delete 1',
          timestamp: new Date().toISOString(),
        },
        metadata: { index: 'test-index', source: 'user', importance: 'low' },
      });
      mockRepo.setMemory('test-index', {
        id: 'delete-2',
        content: {
          text: 'Memory to delete 2',
          timestamp: new Date().toISOString(),
        },
        metadata: { index: 'test-index', source: 'user', importance: 'low' },
      });
    });

    it('should accept valid DELETE action', async () => {
      const action = createDeleteAction();
      const result = await validateAction(action, context);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject DELETE when allowDelete is false', async () => {
      context.config.allowDelete = false;
      const action = createDeleteAction();
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'DELETE action not allowed: allowDelete is false in configuration'
      );
    });

    it('should reject DELETE without deleteIds', async () => {
      const action = createDeleteAction({ deleteIds: forceType(undefined) });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('DELETE action missing required field: deleteIds');
    });

    it('should reject DELETE with empty deleteIds', async () => {
      const action = createDeleteAction({ deleteIds: [] });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('DELETE action missing required field: deleteIds');
    });

    it('should reject DELETE of system memory (sys_ prefix)', async () => {
      mockRepo.setMemory('test-index', {
        id: 'sys_memory',
        content: {
          text: 'System memory',
          timestamp: new Date().toISOString(),
        },
        metadata: { index: 'test-index', source: 'system', importance: 'high' },
      });

      const action = createDeleteAction({
        deleteIds: ['delete-1', 'sys_memory'],
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('cannot delete system memories'))).toBe(true);
    });

    it('should reject DELETE of system memory (metadata source)', async () => {
      mockRepo.setMemory('test-index', {
        id: 'user-id-system-source',
        content: {
          text: 'System memory',
          timestamp: new Date().toISOString(),
        },
        metadata: { index: 'test-index', source: 'system', importance: 'high' },
      });

      const action = createDeleteAction({
        deleteIds: ['delete-1', 'user-id-system-source'],
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('cannot delete system memories'))).toBe(true);
    });

    it('should reject DELETE of non-existent memory', async () => {
      const action = createDeleteAction({
        deleteIds: ['delete-1', 'non-existent'],
      });
      const result = await validateAction(action, context);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('non-existent IDs'))).toBe(true);
    });
  });
});
