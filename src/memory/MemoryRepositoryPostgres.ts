import { Pool, QueryResult } from 'pg';
import { randomUUID } from 'crypto';
import type { EmbeddingService } from '../llm/EmbeddingService.js';
import {
  MemoryRecord,
  MemoryContent,
  MemoryMetadata,
  SearchResult,
  MemoryToUpsert,
  SearchDiagnostics,
  SearchStatus,
  Importance,
  Relationship,
} from './types.js';
import { IMemoryRepository, DatabaseInfo, IndexInfo, IndexSummary } from './IMemoryRepository.js';
import { PoolManager } from './PoolManager.js';
import { loadRefinementConfig } from '../config/refinement.js';
import { computeTypeDependentPriority } from './PriorityCalculator.js';
import { MetadataValidator, ValidationError } from '../validators/MetadataValidator.js';
import { MemorySearchError } from './MemorySearchError.js';
import { debugLog } from '../utils/logger.js';
import { parseFilterExpression } from './postgres/FilterParser.js';

/**
 * MemoryRepositoryPostgres
 * Postgres implementation of IMemoryRepository using pgvector for semantic search
 *
 * Features:
 * - Connection pooling per project database via PoolManager
 * - Batch upserts with ON CONFLICT for efficient memory storage
 * - Vector similarity search using pgvector's cosine distance
 * - Metadata filtering via JSONB and denormalized columns
 * - Access tracking for memory lifecycle management
 */
export class MemoryRepositoryPostgres implements IMemoryRepository {
  private pool: Pool;
  private projectId: string;
  private embeddingService?: EmbeddingService;

  /**
   * @param databaseUrl - PostgreSQL connection string for this project
   * @param projectId - Project identifier (for multi-tenancy tracking)
   * @param embeddingService - Optional embedding service for vector generation
   */
  constructor(databaseUrl: string, projectId: string, embeddingService?: EmbeddingService) {
    this.pool = PoolManager.getPool(databaseUrl);
    this.projectId = projectId;
    this.embeddingService = embeddingService;
  }

  /**
   * Generate a unique memory ID using cryptographically strong random values
   * Format matches Upstash implementation: mem_<uuid>
   */
  private generateId(): string {
    return `mem_${randomUUID()}`;
  }

  /**
   * Convert importance string to numeric value for database storage
   */
  private importanceToNumber(importance?: Importance): number {
    if (!importance) return 0; // low
    switch (importance) {
      case 'low':
        return 0;
      case 'medium':
        return 1;
      case 'high':
        return 2;
      default:
        return 0;
    }
  }

  /**
   * Convert numeric importance back to string
   */
  private numberToImportance(value: number): Importance {
    switch (value) {
      case 2:
        return 'high';
      case 1:
        return 'medium';
      default:
        return 'low';
    }
  }

  /**
   * Resolve index UUID from index name, creating if necessary
   */
  private async resolveIndexId(indexName: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO memory_indexes (project, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (project, name) DO UPDATE
       SET description = COALESCE(EXCLUDED.description, memory_indexes.description)
       RETURNING id`,
      [this.projectId, indexName, `Auto-created index: ${indexName}`]
    );

    return result.rows[0].id;
  }

  /**
   * Public ensureIndex API - idempotent create
   */
  async ensureIndex(indexName: string, description?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO memory_indexes (project, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (project, name) DO UPDATE
       SET description = COALESCE(EXCLUDED.description, memory_indexes.description)`,
      [this.projectId, indexName, description ?? null]
    );
  }

  /**
   * Upsert a batch of memories.
   */
  async upsertMemories(
    indexName: string,
    memories: MemoryToUpsert[],
    defaultMetadata?: Partial<MemoryMetadata>
  ): Promise<string[]> {
    if (memories.length === 0) {
      return [];
    }

    // Validate metadata for all memories
    for (const memory of memories) {
      const fullMetadata = { ...defaultMetadata, ...memory.metadata, index: indexName };
      try {
        MetadataValidator.validate(fullMetadata);
      } catch (error) {
        if (error instanceof ValidationError) {
          throw new Error(`Memory metadata validation failed: ${error.message}`);
        }
        throw error;
      }
    }

    // Resolve index ID
    const indexId = await this.resolveIndexId(indexName);

    // Generate embeddings for all texts if embedding service is available
    let embeddings: number[][] | null = null;
    if (this.embeddingService) {
      const texts = memories.map((m) => m.text);
      embeddings = await this.embeddingService.embedBatch(texts);
    } else {
      throw new Error(
        'EmbeddingService is required for Postgres backend. Ensure OPENAI_API_KEY is configured.'
      );
    }

    // Prepare batch insert with ON CONFLICT
    const values: any[] = [];
    const memoryIds: string[] = [];

    for (let i = 0; i < memories.length; i++) {
      const memory = memories[i];
      const embedding = embeddings![i];

      // Generate or reuse ID
      const memoryId = memory.id || this.generateId();
      memoryIds.push(memoryId);

      // Merge metadata
      const fullMetadata = {
        ...defaultMetadata,
        ...memory.metadata,
        index: indexName,
        project: this.projectId,
      };

      // Compute dynamics if not present (for new memories)
      const now = new Date().toISOString();
      const timestamp = memory.timestamp || now;
      const memoryType = memory.memoryType || fullMetadata.memoryType || 'semantic';

      let dynamics = fullMetadata.dynamics;
      if (!dynamics) {
        // Compute initial priority by constructing a temporary MemoryRecord
        const tempRecord: MemoryRecord = {
          id: memoryId,
          content: {
            text: memory.text,
            timestamp,
          },
          metadata: {
            ...fullMetadata,
            memoryType,
            dynamics: {
              initialPriority: 0,
              currentPriority: 0,
              createdAt: timestamp,
              accessCount: 0,
              maxAccessCount: 0,
              stability: 'tentative',
              sleepCycles: 0,
            },
          },
        };

        const initialPriority = computeTypeDependentPriority(tempRecord, new Date(timestamp));

        dynamics = {
          initialPriority,
          currentPriority: initialPriority,
          createdAt: timestamp,
          accessCount: 0,
          maxAccessCount: 0,
          stability: 'tentative',
          sleepCycles: 0,
        };
      }

      // Store full metadata including dynamics in JSONB
      const metadataJson = { ...fullMetadata, dynamics };

      // Extract denormalized columns
      const importance = this.importanceToNumber(fullMetadata.importance);
      const tags = fullMetadata.tags || [];
      const topic = fullMetadata.topic || null;
      const source = fullMetadata.source || null;
      const sourcePath = fullMetadata.sourcePath || null;
      const kind = fullMetadata.kind || 'raw';
      const derivedFromIds = fullMetadata.derivedFromIds
        ? fullMetadata.derivedFromIds.map((id) => id)
        : null;
      const supersededById = fullMetadata.supersededById || null;

      values.push(
        memoryId,
        indexId,
        this.projectId,
        memory.text,
        `[${embedding.join(',')}]`, // pgvector format
        memoryType,
        topic,
        importance,
        tags,
        source,
        sourcePath,
        dynamics.initialPriority,
        dynamics.currentPriority,
        dynamics.createdAt,
        dynamics.lastAccessedAt || null,
        dynamics.accessCount,
        dynamics.maxAccessCount || 0,
        dynamics.stability || 'tentative',
        dynamics.sleepCycles || 0,
        kind,
        derivedFromIds,
        supersededById,
        metadataJson
      );
    }

    // Build bulk INSERT with ON CONFLICT
    const cols = 23; // Number of columns per row
    const placeholders = memories
      .map((_, i) => {
        const start = i * cols + 1;
        const params = Array.from({ length: cols }, (_, j) => `$${start + j}`);
        return `(${params.join(', ')})`;
      })
      .join(', ');

    const query = `
      INSERT INTO memories (
        id, index_id, project, content, embedding,
        memory_type, topic, importance, tags, source, source_path,
        initial_priority, current_priority, created_at, last_accessed_at,
        access_count, max_access_count, stability, sleep_cycles,
        kind, derived_from_ids, superseded_by_id, metadata
      )
      VALUES ${placeholders}
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        embedding = EXCLUDED.embedding,
        memory_type = EXCLUDED.memory_type,
        topic = EXCLUDED.topic,
        importance = EXCLUDED.importance,
        tags = EXCLUDED.tags,
        source = EXCLUDED.source,
        source_path = EXCLUDED.source_path,
        current_priority = EXCLUDED.current_priority,
        last_accessed_at = EXCLUDED.last_accessed_at,
        access_count = EXCLUDED.access_count,
        max_access_count = EXCLUDED.max_access_count,
        stability = EXCLUDED.stability,
        sleep_cycles = EXCLUDED.sleep_cycles,
        kind = EXCLUDED.kind,
        derived_from_ids = EXCLUDED.derived_from_ids,
        superseded_by_id = EXCLUDED.superseded_by_id,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING id
    `;

    const result = await this.pool.query<{ id: string }>(query, values);

    // Sync relationships to memory_relationships table
    const upsertedIds = result.rows.map((row: { id: string }) => row.id);
    await this.syncRelationships(indexId, memoryIds, memories);

    return upsertedIds;
  }

  /**
   * Sync relationships from metadata to memory_relationships table.
   * Uses delete-then-insert pattern wrapped in a transaction to ensure atomicity.
   *
   * Only syncs relationships when explicitly provided in metadata.
   * If metadata.relationships is undefined/null, existing relationships are preserved.
   * If metadata.relationships is an empty array [], existing relationships are cleared.
   *
   * @param indexId - UUID of the index (for filtering)
   * @param memoryIds - Array of memory IDs being upserted
   * @param memories - Array of memory objects with metadata
   */
  private async syncRelationships(
    indexId: string,
    memoryIds: string[],
    memories: MemoryToUpsert[]
  ): Promise<void> {
    // Collect memory IDs that explicitly provide relationships (including empty arrays)
    const idsWithRelationships: string[] = [];
    const relationshipsToInsert: Array<{
      sourceId: string;
      targetId: string;
      type: string;
      confidence: number;
      metadata: any;
    }> = [];

    for (let i = 0; i < memories.length; i++) {
      const memory = memories[i];
      const sourceId = memoryIds[i];

      // Only sync if relationships field is explicitly provided (not undefined/null)
      if (memory.metadata?.relationships !== undefined && memory.metadata?.relationships !== null) {
        idsWithRelationships.push(sourceId);

        const relationships = memory.metadata.relationships;
        for (const rel of relationships) {
          relationshipsToInsert.push({
            sourceId,
            targetId: rel.targetId,
            type: rel.type,
            confidence: rel.weight ?? 1.0,
            metadata: {},
          });
        }
      }
    }

    // If no memories explicitly provided relationships, nothing to sync
    if (idsWithRelationships.length === 0) {
      return;
    }

    // Use a transaction to make delete and insert atomic
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Delete existing relationships only for memory IDs that explicitly provided relationships
      await client.query(
        `DELETE FROM memory_relationships
         WHERE project = $1 AND source_id = ANY($2::text[])`,
        [this.projectId, idsWithRelationships]
      );

      // Insert new relationships if any exist
      if (relationshipsToInsert.length > 0) {
        const values: any[] = [];
        const placeholders: string[] = [];

        for (let i = 0; i < relationshipsToInsert.length; i++) {
          const rel = relationshipsToInsert[i];
          const offset = i * 6 + 1;
          placeholders.push(
            `($${offset}, $${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`
          );
          values.push(
            this.projectId,
            rel.sourceId,
            rel.targetId,
            rel.type,
            rel.confidence,
            JSON.stringify(rel.metadata)
          );
        }

        const insertQuery = `
          INSERT INTO memory_relationships (project, source_id, target_id, relationship_type, confidence, metadata)
          VALUES ${placeholders.join(', ')}
          ON CONFLICT (source_id, target_id, relationship_type)
          DO UPDATE SET
            confidence = EXCLUDED.confidence,
            metadata = EXCLUDED.metadata
        `;

        await client.query(insertQuery, values);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Populate relationships from memory_relationships table into MemoryRecord objects.
   * Updates both metadata.relationships and metadata.relatedIds fields.
   *
   * @param memories - Array of memory records to populate
   */
  private async populateRelationships(memories: MemoryRecord[]): Promise<void> {
    if (memories.length === 0) {
      return;
    }

    const memoryIds = memories.map((m) => m.id);
    const memoryIdSet = new Set(memoryIds); // Performance: O(1) lookups instead of O(n)

    // Fetch all relationships (both outgoing and incoming) for these memory IDs
    const result = await this.pool.query<{
      source_id: string;
      target_id: string;
      relationship_type: string;
      confidence: number;
    }>(
      `SELECT source_id, target_id, relationship_type, confidence
       FROM memory_relationships
       WHERE project = $1 AND (source_id = ANY($2::text[]) OR target_id = ANY($2::text[]))`,
      [this.projectId, memoryIds]
    );

    // Build maps for outgoing and incoming relationships
    const outgoingMap = new Map<string, Relationship[]>();
    const relatedIdsMap = new Map<string, Set<string>>();

    for (const row of result.rows) {
      // Outgoing relationships (source_id → target_id)
      if (memoryIdSet.has(row.source_id)) {
        if (!outgoingMap.has(row.source_id)) {
          outgoingMap.set(row.source_id, []);
        }
        const relationship: Relationship = {
          targetId: row.target_id,
          type: row.relationship_type as Relationship['type'],
          weight: row.confidence,
        };
        outgoingMap.get(row.source_id)!.push(relationship);

        // Add to relatedIds
        if (!relatedIdsMap.has(row.source_id)) {
          relatedIdsMap.set(row.source_id, new Set());
        }
        relatedIdsMap.get(row.source_id)!.add(row.target_id);
      }

      // Incoming relationships (target_id ← source_id)
      if (memoryIdSet.has(row.target_id)) {
        if (!relatedIdsMap.has(row.target_id)) {
          relatedIdsMap.set(row.target_id, new Set());
        }
        relatedIdsMap.get(row.target_id)!.add(row.source_id);
      }
    }

    // Populate each memory's metadata
    for (const memory of memories) {
      if (!memory.metadata) {
        memory.metadata = { index: '' };
      }

      memory.metadata.relationships = outgoingMap.get(memory.id) || [];
      memory.metadata.relatedIds = relatedIdsMap.has(memory.id)
        ? Array.from(relatedIdsMap.get(memory.id)!)
        : [];
    }
  }

  /**
   * Update access statistics for recently retrieved memories.
   */
  async updateAccessStats(
    indexName: string,
    ids: string[],
    options?: { topN?: number; priorityBoost?: number }
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const config = loadRefinementConfig();

    if (!config.accessTrackingEnabled) {
      debugLog('access', 'Access tracking is disabled, skipping updateAccessStats');
      return;
    }

    // Respect topN limit
    const topN = options?.topN ?? config.accessTrackingTopN;
    const idsToUpdate = ids.slice(0, topN);

    if (idsToUpdate.length === 0) {
      return;
    }

    // Use accessPriorityBoost from config if not provided in options
    const priorityBoost = options?.priorityBoost ?? config.accessPriorityBoost;

    // Batch update using ANY - update both denormalized columns AND metadata JSONB
    // IMPORTANT: Sync JSONB dynamics.accessCount from the authoritative column to prevent drift
    const query = `
      UPDATE memories
      SET
        last_accessed_at = NOW(),
        access_count = access_count + 1,
        current_priority = LEAST(1.0, current_priority + $1),
        metadata = jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{dynamics,lastAccessedAt}',
              to_jsonb(NOW()::text),
              true
            ),
            '{dynamics,accessCount}',
            to_jsonb(access_count + 1),
            true
          ),
          '{dynamics,currentPriority}',
          to_jsonb(LEAST(1.0, current_priority + $1)),
          true
        ),
        updated_at = NOW()
      WHERE id = ANY($2::text[])
    `;

    await this.pool.query(query, [priorityBoost, idsToUpdate]);
  }

  /**
   * Search for memories with diagnostic instrumentation.
   */
  async searchMemories(
    indexName: string,
    query: string,
    options?: {
      limit?: number;
      semanticWeight?: number;
      filterExpression?: string;
      includeMetadata?: boolean;
      reranking?: boolean;
      diagnosticsListener?: (diag: SearchDiagnostics) => void;
    }
  ): Promise<SearchResult[]> {
    const startTime = Date.now();
    const limit = options?.limit ?? 10;
    const semanticWeight = options?.semanticWeight ?? 1.0;
    const includeMetadata = options?.includeMetadata ?? true;

    try {
      // Resolve index ID
      const indexResult = await this.pool.query<{ id: string }>(
        'SELECT id FROM memory_indexes WHERE project = $1 AND name = $2',
        [this.projectId, indexName]
      );

      if (indexResult.rows.length === 0) {
        // Index doesn't exist yet
        const diagnostics: SearchDiagnostics = {
          index: indexName,
          query,
          limit,
          semanticWeight,
          filterExpression: options?.filterExpression,
          reranking: options?.reranking ?? false,
          durationMs: Date.now() - startTime,
          status: 'no_results',
          resultCount: 0,
          retryCount: 0,
          timestamp: new Date().toISOString(),
          lastError: 'Index does not exist',
        };

        options?.diagnosticsListener?.(diagnostics);
        return [];
      }

      const indexId = indexResult.rows[0].id;

      // Generate query embedding if embedding service is available
      if (!this.embeddingService) {
        throw new Error('EmbeddingService is required for semantic search');
      }

      const queryEmbedding = await this.embeddingService.embedText(query);

      // Build search query with vector similarity and optional keyword matching
      // For now, we'll implement pure vector search (keyword search can be added later)
      let searchQuery = `
        SELECT
          id,
          content,
          metadata,
          created_at,
          1 - (embedding <=> $1::vector) AS semantic_score
        FROM memories
        WHERE index_id = $2
          AND project = $3
          AND superseded_by_id IS NULL
      `;

      const params: any[] = [`[${queryEmbedding.join(',')}]`, indexId, this.projectId];

      // Add filter expression if provided
      if (options?.filterExpression) {
        try {
          const { sql: filterSQL, params: filterParams } = parseFilterExpression(
            options.filterExpression
          );

          // Adjust parameter placeholders to account for existing params
          const baseParamCount = params.length;
          const adjustedFilterSQL = filterSQL.replace(/\$(\d+)/g, (_, num) => {
            return `$${baseParamCount + parseInt(num, 10)}`;
          });

          searchQuery += ` AND (${adjustedFilterSQL})`;
          params.push(...filterParams);
        } catch (error) {
          throw new Error(
            `Invalid filter expression: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Order by score and limit
      searchQuery += ` ORDER BY semantic_score DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await this.pool.query<{
        id: string;
        content: string;
        metadata: any;
        created_at: Date;
        semantic_score: number;
      }>(searchQuery, params);

      // Convert to SearchResult format
      const memoryRecords: MemoryRecord[] = result.rows.map(
        (row: {
          id: string;
          content: string;
          metadata: any;
          created_at: Date;
          semantic_score: number;
        }) => ({
          id: row.id,
          content: {
            text: row.content,
            timestamp: row.created_at.toISOString(),
          },
          metadata: row.metadata as MemoryMetadata,
        })
      );

      // Populate relationships from memory_relationships table
      if (includeMetadata) {
        await this.populateRelationships(memoryRecords);
      }

      // Convert to SearchResult format
      const results: SearchResult[] = memoryRecords.map((record) => {
        const matchingRow = result.rows.find(
          (r: { id: string; semantic_score: number }) => r.id === record.id
        );
        const searchResult: SearchResult = {
          id: record.id,
          content: record.content,
          score: matchingRow?.semantic_score,
        };

        if (includeMetadata && record.metadata) {
          searchResult.metadata = record.metadata;
        }

        return searchResult;
      });

      // Fire-and-forget access tracking
      const resultIds = results.map((r) => r.id);
      this.updateAccessStats(indexName, resultIds).catch((err) =>
        console.error('Access tracking failed:', err)
      );

      // Emit diagnostics
      const diagnostics: SearchDiagnostics = {
        index: indexName,
        query,
        limit,
        semanticWeight,
        filterExpression: options?.filterExpression,
        reranking: options?.reranking ?? false,
        durationMs: Date.now() - startTime,
        status: results.length > 0 ? 'results' : 'no_results',
        resultCount: results.length,
        retryCount: 0,
        timestamp: new Date().toISOString(),
      };

      options?.diagnosticsListener?.(diagnostics);

      return results;
    } catch (error) {
      const diagnostics: SearchDiagnostics = {
        index: indexName,
        query,
        limit,
        semanticWeight,
        filterExpression: options?.filterExpression,
        reranking: options?.reranking ?? false,
        durationMs: Date.now() - startTime,
        status: 'search_error',
        resultCount: 0,
        retryCount: 0,
        timestamp: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      };

      options?.diagnosticsListener?.(diagnostics);

      throw new MemorySearchError(
        `Search failed for index "${indexName}": ${error instanceof Error ? error.message : String(error)}`,
        diagnostics
      );
    }
  }

  /**
   * Delete memories by IDs.
   */
  async deleteMemories(indexName: string, ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    // Resolve index ID to ensure it exists
    const indexResult = await this.pool.query<{ id: string }>(
      'SELECT id FROM memory_indexes WHERE project = $1 AND name = $2',
      [this.projectId, indexName]
    );

    if (indexResult.rows.length === 0) {
      // Index doesn't exist, nothing to delete
      return 0;
    }

    const indexId = indexResult.rows[0].id;

    const result = await this.pool.query<{ id: string }>(
      `DELETE FROM memories
       WHERE index_id = $1
         AND project = $2
         AND id = ANY($3::text[])
       RETURNING id`,
      [indexId, this.projectId, ids]
    );

    return result.rows.length;
  }

  /**
   * Get a single memory by ID.
   */
  async getMemory(indexName: string, id: string): Promise<MemoryRecord | null> {
    // Resolve index ID
    const indexResult = await this.pool.query<{ id: string }>(
      'SELECT id FROM memory_indexes WHERE project = $1 AND name = $2',
      [this.projectId, indexName]
    );

    if (indexResult.rows.length === 0) {
      return null;
    }

    const indexId = indexResult.rows[0].id;

    const result = await this.pool.query<{
      id: string;
      content: string;
      created_at: Date;
      metadata: any;
    }>(
      `SELECT id, content, created_at, metadata
       FROM memories
       WHERE index_id = $1
         AND project = $2
         AND id = $3`,
      [indexId, this.projectId, id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    const memory: MemoryRecord = {
      id: row.id,
      content: {
        text: row.content,
        timestamp: row.created_at.toISOString(),
      },
      metadata: row.metadata as MemoryMetadata,
    };

    // Populate relationships from memory_relationships table
    await this.populateRelationships([memory]);

    return memory;
  }

  /**
   * Fetch multiple memories by IDs.
   */
  async getMemories(indexName: string, ids: string[]): Promise<MemoryRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    // Resolve index ID
    const indexResult = await this.pool.query<{ id: string }>(
      'SELECT id FROM memory_indexes WHERE project = $1 AND name = $2',
      [this.projectId, indexName]
    );

    if (indexResult.rows.length === 0) {
      return [];
    }

    const indexId = indexResult.rows[0].id;

    const result = await this.pool.query<{
      id: string;
      content: string;
      created_at: Date;
      metadata: any;
    }>(
      `SELECT id, content, created_at, metadata
       FROM memories
       WHERE index_id = $1
         AND project = $2
         AND id = ANY($3::text[])`,
      [indexId, this.projectId, ids]
    );

    const memories = result.rows.map(
      (row: { id: string; content: string; created_at: Date; metadata: any }) => ({
        id: row.id,
        content: {
          text: row.content,
          timestamp: row.created_at.toISOString(),
        },
        metadata: row.metadata as MemoryMetadata,
      })
    );

    // Populate relationships from memory_relationships table
    await this.populateRelationships(memories);

    return memories;
  }

  /**
   * Check if an index is accessible (connectivity test).
   */
  async testIndex(indexName: string): Promise<boolean> {
    try {
      const result = await this.pool.query<{ id: string }>(
        'SELECT id FROM memory_indexes WHERE project = $1 AND name = $2',
        [this.projectId, indexName]
      );
      return result.rows.length > 0;
    } catch (error) {
      debugLog('operation', `testIndex failed for ${indexName}`, error);
      return false;
    }
  }

  /**
   * Get database-level information including per-index statistics.
   */
  async getDatabaseInfo(): Promise<DatabaseInfo> {
    // Get total document count
    const totalResult = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM memories WHERE project = $1',
      [this.projectId]
    );

    const documentCount = parseInt(totalResult.rows[0].count, 10);

    // Get per-index statistics
    const indexResult = await this.pool.query<{
      name: string;
      count: string;
    }>(
      `SELECT mi.name, COUNT(m.id)::text as count
       FROM memory_indexes mi
       LEFT JOIN memories m ON m.index_id = mi.id AND m.project = mi.project
       WHERE mi.project = $1
       GROUP BY mi.id, mi.name`,
      [this.projectId]
    );

    const indexes: Record<string, IndexInfo> = {};
    for (const row of indexResult.rows) {
      indexes[row.name] = {
        documentCount: parseInt(row.count, 10),
        pendingDocumentCount: 0, // Postgres doesn't have pending documents concept
      };
    }

    return {
      documentCount,
      pendingDocumentCount: 0,
      indexes,
    };
  }

  /**
   * List all indexes with their document counts.
   */
  async listIndexes(): Promise<IndexSummary[]> {
    const result = await this.pool.query<{
      name: string;
      count: string;
    }>(
      `SELECT mi.name, COUNT(m.id)::text as count
       FROM memory_indexes mi
       LEFT JOIN memories m ON m.index_id = mi.id AND m.project = mi.project
       WHERE mi.project = $1
       GROUP BY mi.id, mi.name
       ORDER BY mi.name`,
      [this.projectId]
    );

    return result.rows.map((row: { name: string; count: string }) => ({
      name: row.name,
      documentCount: parseInt(row.count, 10),
      pendingDocumentCount: 0, // Postgres doesn't have pending documents
    }));
  }
}
