import { Pool, QueryResult, QueryResultRow } from 'pg';
import { randomUUID } from 'crypto';
import type { EmbeddingService } from '../llm/EmbeddingService.js';
import {
  MemoryRecord,
  MemoryMetadata,
  SearchResult,
  MemoryToUpsert,
  SearchDiagnostics,
  Importance,
  Relationship,
  MemoryType,
} from './types.js';
import { IMemoryRepository, DatabaseInfo, IndexInfo, IndexSummary } from './IMemoryRepository.js';
import { PoolManager } from './PoolManager.js';
import { loadRefinementConfig } from '../config/refinement.js';
import { computeTypeDependentPriority } from './PriorityCalculator.js';
import { MetadataValidator, ValidationError } from '../validators/MetadataValidator.js';
import { MemorySearchError } from './MemorySearchError.js';
import { debugLog, logDebug, logWarn, logError } from '../utils/logger.js';
import { parseFilterExpression, FilterParserError } from './postgres/FilterParser.js';
import { formatRelativeTime } from '../utils/dateUtils.js';
import { loadLoggingConfig } from '../config/logging.js';

/**
 * Type for database row with lifecycle columns
 * Used internally for hydrating metadata from denormalized columns
 */
interface MemoryRow {
  metadata: MemoryMetadata | null;
  memory_type?: string;
  topic?: string | null;
  importance?: number;
  tags?: string[];
  source?: string | null;
  source_path?: string | null;
  channel?: string | null;
  initial_priority: number;
  current_priority: number;
  created_at: Date;
  updated_at?: Date;
  last_accessed_at?: Date | null;
  access_count: number;
  max_access_count?: number;
  stability?: string | null;
  sleep_cycles?: number;
  kind?: string | null;
  derived_from_ids?: string[] | null;
  superseded_by_id?: string | null;
}

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
  private databaseUrl: string;
  private loggingConfig = loadLoggingConfig();

  /**
   * @param databaseUrl - PostgreSQL connection string for this project
   * @param projectId - Project identifier (for multi-tenancy tracking)
   * @param embeddingService - Optional embedding service for vector generation
   */
  constructor(databaseUrl: string, projectId: string, embeddingService?: EmbeddingService) {
    this.pool = PoolManager.getPool(databaseUrl);
    this.projectId = projectId;
    this.embeddingService = embeddingService;
    this.databaseUrl = databaseUrl;
  }

  /**
   * Wrap pool.query with timing instrumentation and slow query logging
   */
  private async runQuery<T extends QueryResultRow = QueryResultRow>(
    label: string,
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const start = Date.now();

    try {
      const result = await this.pool.query<T>(text, params);
      const durationMs = Date.now() - start;

      // Log all queries at debug level
      logDebug('db-repository', `query:${label}`, {
        meta: {
          durationMs,
          rowCount: result.rowCount,
        },
      });

      // Log slow queries at warn level
      if (durationMs > this.loggingConfig.slowQueryThresholdMs) {
        logWarn('db-repository', `slow-query:${label}`, {
          message: `Query exceeded ${this.loggingConfig.slowQueryThresholdMs}ms threshold`,
          meta: {
            durationMs,
            rowCount: result.rowCount,
            threshold: this.loggingConfig.slowQueryThresholdMs,
          },
        });
      }

      return result;
    } catch (error) {
      const durationMs = Date.now() - start;
      logError('db-repository', `query-error:${label}`, {
        message: `Query failed after ${durationMs}ms`,
        error: error instanceof Error ? error : new Error(String(error)),
        meta: {
          durationMs,
        },
      });
      throw error;
    }
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
   * Hydrate metadata with dynamics from denormalized columns.
   * This is the single source of truth for dynamics - they are NOT stored in JSONB.
   *
   * @param row - Database row with both metadata JSONB and denormalized columns
   * @returns Complete MemoryMetadata with dynamics populated from columns
   */
  private hydrateMetadata(row: MemoryRow): MemoryMetadata {
    // Start with JSONB metadata (excludes dynamics)
    const metadata: MemoryMetadata = row.metadata || { index: '' };

    // Overlay denormalized columns (source of truth)
    if (row.memory_type) metadata.memoryType = row.memory_type as MemoryType;
    if (row.topic !== undefined) metadata.topic = row.topic || undefined;
    if (row.importance !== undefined) metadata.importance = this.numberToImportance(row.importance);
    if (row.tags) metadata.tags = row.tags;
    if (row.source) metadata.source = row.source as 'user' | 'file' | 'system';
    if (row.source_path !== undefined) metadata.sourcePath = row.source_path || undefined;
    if (row.channel !== undefined) metadata.channel = row.channel || undefined;
    if (row.kind) metadata.kind = row.kind as 'raw' | 'summary' | 'derived';
    if (row.derived_from_ids !== undefined) {
      metadata.derivedFromIds = row.derived_from_ids || undefined;
    }
    if (row.superseded_by_id !== undefined) {
      metadata.supersededById = row.superseded_by_id || undefined;
    }

    // Construct dynamics from lifecycle columns (single source of truth)
    metadata.dynamics = {
      initialPriority: row.initial_priority,
      currentPriority: row.current_priority,
      createdAt: row.created_at.toISOString(),
      lastAccessedAt: row.last_accessed_at?.toISOString(),
      accessCount: row.access_count,
      maxAccessCount: row.max_access_count || 0,
      stability: (row.stability as 'tentative' | 'stable' | 'canonical') || 'tentative',
      sleepCycles: row.sleep_cycles || 0,
    };

    return metadata;
  }

  /**
   * Resolve index UUID from index name, creating if necessary
   */
  private async resolveIndexId(indexName: string): Promise<string> {
    const result = await this.runQuery<{ id: string }>(
      'resolve-index',
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

    // Fetch existing metadata for updates (memories with IDs)
    const existingMetadataMap = new Map<string, Partial<MemoryMetadata>>();
    const updateIds = memories.filter((m) => m.id).map((m) => m.id!);

    if (updateIds.length > 0) {
      const existingQuery = `
        SELECT id, metadata
        FROM memories
        WHERE id = ANY($1::text[])
          AND index_id = $2
          AND project = $3
      `;

      const existingResult = await this.runQuery<{ id: string; metadata: MemoryMetadata | null }>(
        'fetch-existing-metadata',
        existingQuery,
        [updateIds, indexId, this.projectId]
      );

      for (const row of existingResult.rows) {
        existingMetadataMap.set(row.id, row.metadata || {});
      }
    }

    // Prepare batch insert with ON CONFLICT
    const values: unknown[] = [];
    const memoryIds: string[] = [];

    for (let i = 0; i < memories.length; i++) {
      const memory = memories[i];
      const embedding = embeddings![i];

      // Generate or reuse ID
      const memoryId = memory.id || this.generateId();
      memoryIds.push(memoryId);

      // Merge metadata: default → existing → new (preserves existing, new overrides, defaults fill gaps)
      const existingMetadata = existingMetadataMap.get(memoryId) || {};
      const fullMetadata = {
        ...defaultMetadata,
        ...existingMetadata,
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

      // Store metadata in JSONB (excluding dynamics which live in denormalized columns)
      // Remove dynamics if present to prevent drift between JSONB and columns
      const { dynamics: _, ...metadataWithoutDynamics } = fullMetadata;
      const metadataJson = metadataWithoutDynamics;

      // Extract denormalized columns
      const importance = this.importanceToNumber(fullMetadata.importance);
      const tags = fullMetadata.tags || [];
      const topic = fullMetadata.topic || null;
      const source = fullMetadata.source || null;
      const sourcePath = fullMetadata.sourcePath || null;
      const kind = fullMetadata.kind || 'raw';
      const derivedFromIds = fullMetadata.derivedFromIds
        ? fullMetadata.derivedFromIds.map((id: string) => id)
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

    const result = await this.runQuery<{ id: string }>('upsert-memories', query, values);

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
      metadata: Record<string, unknown>;
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
      // Include index_id filter to prevent cross-index deletions
      await client.query(
        `DELETE FROM memory_relationships
         WHERE project = $1 AND index_id = $2 AND source_id = ANY($3::text[])`,
        [this.projectId, indexId, idsWithRelationships]
      );

      // Insert new relationships if any exist
      if (relationshipsToInsert.length > 0) {
        const values: unknown[] = [];
        const placeholders: string[] = [];

        for (let i = 0; i < relationshipsToInsert.length; i++) {
          const rel = relationshipsToInsert[i];
          const offset = i * 7 + 1;
          placeholders.push(
            `($${offset}, $${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`
          );
          values.push(
            this.projectId,
            indexId,
            rel.sourceId,
            rel.targetId,
            rel.type,
            rel.confidence,
            JSON.stringify(rel.metadata)
          );
        }

        const insertQuery = `
          INSERT INTO memory_relationships (project, index_id, source_id, target_id, relationship_type, confidence, metadata)
          VALUES ${placeholders.join(', ')}
          ON CONFLICT (source_id, target_id, relationship_type, index_id)
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

    // Get index_id from the first memory's metadata (all memories in a batch should be from the same index)
    // If we can't determine the index, we need to fetch it from the database
    const indexName = memories[0].metadata?.index;
    if (!indexName) {
      // No index information, skip relationship population
      return;
    }

    // Resolve index ID
    const indexResult = await this.pool.query<{ id: string }>(
      'SELECT id FROM memory_indexes WHERE project = $1 AND name = $2',
      [this.projectId, indexName]
    );

    if (indexResult.rows.length === 0) {
      // Index not found, skip relationship population
      return;
    }

    const indexId = indexResult.rows[0].id;

    // Fetch all relationships (both outgoing and incoming) for these memory IDs within this index
    const result = await this.pool.query<{
      source_id: string;
      target_id: string;
      relationship_type: string;
      confidence: number;
    }>(
      `SELECT source_id, target_id, relationship_type, confidence
       FROM memory_relationships
       WHERE project = $1 AND index_id = $2 AND (source_id = ANY($3::text[]) OR target_id = ANY($3::text[]))`,
      [this.projectId, indexId, memoryIds]
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

    // Resolve index ID to ensure we only update memories in this index
    const indexResult = await this.pool.query<{ id: string }>(
      'SELECT id FROM memory_indexes WHERE project = $1 AND name = $2',
      [this.projectId, indexName]
    );

    if (indexResult.rows.length === 0) {
      debugLog('access', `Index ${indexName} not found, skipping updateAccessStats`);
      return;
    }

    const indexId = indexResult.rows[0].id;

    // Fetch existing memories to recalculate priority using PriorityCalculator
    const selectQuery = `
      SELECT id, content, created_at, metadata, memory_type, access_count, max_access_count
      FROM memories
      WHERE index_id = $1
        AND project = $2
        AND id = ANY($3::text[])
    `;

    const result = await this.pool.query<{
      id: string;
      content: string;
      created_at: Date;
      metadata: MemoryMetadata | null;
      memory_type: string;
      access_count: number;
      max_access_count: number;
    }>(selectQuery, [indexId, this.projectId, idsToUpdate]);

    if (result.rows.length === 0) {
      return;
    }
    const now = new Date();
    // Build update for each memory with recalculated priority
    for (const row of result.rows) {
      const currentMetadata: MemoryMetadata = row.metadata ?? {
        index: indexName,
      };

      // Increment access count (use column values as source of truth)
      const newAccessCount = (row.access_count || 0) + 1;
      const newMaxAccessCount = Math.max(row.max_access_count || 0, newAccessCount);

      // Build temporary memory record for priority calculation
      const tempMemory: MemoryRecord = {
        id: row.id,
        content: {
          text: row.content,
          timestamp: row.created_at.toISOString(),
        },
        metadata: {
          ...currentMetadata,
          memoryType: row.memory_type as MemoryMetadata['memoryType'],
          dynamics: {
            initialPriority: 0, // not used in priority calculation
            currentPriority: 0, // recalculated below
            createdAt: row.created_at.toISOString(),
            accessCount: newAccessCount,
            maxAccessCount: newMaxAccessCount,
            lastAccessedAt: now.toISOString(),
          },
        },
      };

      // Recalculate priority using PriorityCalculator
      const newPriority = computeTypeDependentPriority(tempMemory, now);

      // Update only denormalized columns (no JSONB sync needed)
      // Dynamics will be hydrated from columns at read time
      const updateQuery = `
        UPDATE memories
        SET
          last_accessed_at = $1,
          access_count = $2,
          max_access_count = $3,
          current_priority = $4,
          updated_at = $1
        WHERE id = $5
          AND index_id = $6
          AND project = $7
      `;

      await this.pool.query(updateQuery, [
        now,
        newAccessCount,
        newMaxAccessCount,
        newPriority,
        row.id,
        indexId,
        this.projectId,
      ]);

      debugLog(
        'access',
        `Updated access stats for ${row.id}: accessCount=${newAccessCount}, priority=${newPriority.toFixed(3)}`
      );
    }
  }

  /**
   * Classify Postgres errors and return enhanced error information
   */
  private mapPostgresError(error: unknown): {
    message: string;
    postgresCode?: string;
    hint?: string;
    suggestedFixes?: string[];
    details?: Record<string, unknown>;
  } {
    // Handle FilterParserError specially
    if (error instanceof FilterParserError) {
      return {
        message: `Filter syntax error: ${error.message}`,
        postgresCode: 'FILTER_PARSE_ERROR',
        hint: error.hint,
        suggestedFixes: error.hint ? [error.hint] : undefined,
        details: {
          stage: error.stage,
          position: error.position,
          snippet: error.snippet,
        },
      };
    }

    // Handle Node.js system errors (connection issues)
    if (error && typeof error === 'object' && 'code' in error) {
      const sysError = error as { code?: string; message?: string };

      // Connection errors
      if (
        sysError.code === 'ECONNREFUSED' ||
        sysError.code === 'ENOTFOUND' ||
        sysError.code === 'ETIMEDOUT' ||
        sysError.code === 'ECONNRESET'
      ) {
        const url = new URL(this.databaseUrl);
        return {
          message: `Unable to connect to PostgreSQL database`,
          postgresCode: sysError.code,
          hint: 'Database connection failed',
          suggestedFixes: [
            'Check if PostgreSQL server is running and accessible',
            'Verify MEMORY_POSTGRES_URL environment variable is correct',
            'Ensure database server is accessible from this host',
            'Check firewall rules and network connectivity',
          ],
          details: {
            errorCode: sysError.code,
            // Infrastructure details available for debugging but not in user-facing messages
            host: url.hostname,
            port: url.port || 5432,
            database: url.pathname.slice(1),
          },
        };
      }
    }

    // Handle Postgres-specific errors
    if (error && typeof error === 'object' && 'severity' in error) {
      const pgError = error as {
        severity?: string;
        code?: string;
        message?: string;
        detail?: string;
      };

      // Fatal connection errors
      if (pgError.severity === 'FATAL' || pgError.code?.startsWith('57')) {
        return {
          message: `PostgreSQL connection error: ${pgError.message || 'Unknown error'}`,
          postgresCode: pgError.code,
          hint: 'Database connection terminated',
          suggestedFixes: [
            'Check database server status',
            'Verify connection credentials',
            'Review PostgreSQL server logs for details',
          ],
          details: {
            severity: pgError.severity,
            detail: pgError.detail,
          },
        };
      }
    }

    // Check for dimension mismatch errors
    if (error instanceof Error) {
      const dimMatch = error.message.match(/dimension.*?(\d+).*?(\d+)/i);
      if (dimMatch || error.message.toLowerCase().includes('dimension')) {
        const expected = dimMatch?.[1];
        const actual = dimMatch?.[2];
        return {
          message:
            expected && actual
              ? `Vector dimension mismatch: expected ${expected}, got ${actual}`
              : `Vector dimension mismatch: ${error.message}`,
          postgresCode: 'VECTOR_DIMENSION_MISMATCH',
          hint: 'Embedding dimensions do not match database schema',
          suggestedFixes: [
            expected && actual
              ? `Update MEMORY_EMBEDDING_DIMENSIONS to ${expected} or recreate schema for ${actual} dimensions`
              : 'Check MEMORY_EMBEDDING_DIMENSIONS matches your embedding model',
            'Verify embedding model configuration',
            'Run migrations to update vector dimensions if needed',
          ],
          details: {
            expectedDimension: expected,
            actualDimension: actual,
          },
        };
      }
    }

    // Generic error fallback
    const message = error instanceof Error ? error.message : String(error);
    return {
      message,
      hint: 'An unexpected database error occurred',
      suggestedFixes: [
        'Check database logs for more details',
        'Verify database schema is up to date',
      ],
    };
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
      const indexResult = await this.runQuery<{ id: string }>(
        'search-resolve-index',
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
      // Select all columns needed for metadata hydration
      let searchQuery = `
        SELECT
          id,
          content,
          metadata,
          memory_type,
          topic,
          importance,
          tags,
          source,
          source_path,
          channel,
          initial_priority,
          current_priority,
          created_at,
          updated_at,
          last_accessed_at,
          access_count,
          max_access_count,
          stability,
          sleep_cycles,
          kind,
          derived_from_ids,
          superseded_by_id,
          1 - (embedding <=> $1::vector) AS semantic_score
        FROM memories
        WHERE index_id = $2
          AND project = $3
          AND superseded_by_id IS NULL
      `;

      const params: unknown[] = [`[${queryEmbedding.join(',')}]`, indexId, this.projectId];

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
          // Re-throw FilterParserError as-is to preserve detailed error context
          // It will be caught by the outer catch block and processed by mapPostgresError
          if (error instanceof FilterParserError) {
            throw error;
          }
          // Wrap other errors for safety
          throw new Error(
            `Invalid filter expression: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Order by score and limit
      searchQuery += ` ORDER BY semantic_score DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await this.runQuery<
        MemoryRow & {
          semantic_score: number;
          content: string;
          id: string;
        }
      >('vector-search', searchQuery, params);

      // Convert to SearchResult format with hydrated metadata
      const memoryRecords: MemoryRecord[] = result.rows.map((row) => ({
        id: row.id,
        content: {
          text: row.content,
          timestamp: row.created_at.toISOString(),
        },
        metadata: this.hydrateMetadata(row),
      }));

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
          age: formatRelativeTime(record.content.timestamp),
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
      // Classify the error and get enhanced diagnostics
      const errorInfo = this.mapPostgresError(error);

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
        lastError: errorInfo.message,
        postgresCode: errorInfo.postgresCode,
        hint: errorInfo.hint,
        suggestedFixes: errorInfo.suggestedFixes,
        details: errorInfo.details,
      };

      options?.diagnosticsListener?.(diagnostics);

      throw new MemorySearchError(
        `Search failed for index "${indexName}": ${errorInfo.message}`,
        diagnostics,
        error instanceof Error ? error : undefined
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

    const result = await this.pool.query<MemoryRow & { content: string; id: string }>(
      `SELECT id, content, created_at, metadata,
              memory_type, topic, importance, tags, source, source_path, channel,
              initial_priority, current_priority, updated_at, last_accessed_at,
              access_count, max_access_count, stability, sleep_cycles,
              kind, derived_from_ids, superseded_by_id
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
      metadata: this.hydrateMetadata(row),
    };

    // Populate relationships from memory_relationships table
    await this.populateRelationships([memory]);

    // Update access stats (fire-and-forget)
    this.updateAccessStats(indexName, [id]).catch((err) => {
      debugLog('access', `Failed to update access stats for ${id}:`, err);
    });

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

    const result = await this.pool.query<MemoryRow & { content: string; id: string }>(
      `SELECT id, content, created_at, metadata,
              memory_type, topic, importance, tags, source, source_path, channel,
              initial_priority, current_priority, updated_at, last_accessed_at,
              access_count, max_access_count, stability, sleep_cycles,
              kind, derived_from_ids, superseded_by_id
       FROM memories
       WHERE index_id = $1
         AND project = $2
         AND id = ANY($3::text[])`,
      [indexId, this.projectId, ids]
    );

    const memories = result.rows.map((row) => ({
      id: row.id,
      content: {
        text: row.content,
        timestamp: row.created_at.toISOString(),
      },
      metadata: this.hydrateMetadata(row),
    }));

    // Populate relationships from memory_relationships table
    await this.populateRelationships(memories);

    // Update access stats (fire-and-forget)
    const memoryIds = memories.map((m) => m.id);
    this.updateAccessStats(indexName, memoryIds).catch((err) => {
      debugLog('access', `Failed to update access stats for ${memoryIds.length} memories:`, err);
    });

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
  async getRelatedMemories(
    indexName: string,
    rootId: string,
    options?: {
      maxDepth?: number;
      relationshipTypes?: string[];
      direction?: 'forward' | 'backward' | 'both';
      limit?: number;
    }
  ): Promise<MemoryRecord[]> {
    const maxDepth = Math.min(Math.max(options?.maxDepth ?? 3, 1), 10);
    const limit = Math.max(options?.limit ?? 100, 1);
    const direction = options?.direction ?? 'forward';
    const relationshipTypes = options?.relationshipTypes
      ?.map((type) => type.trim())
      .filter((type) => type.length > 0);

    if (direction !== 'forward' && direction !== 'backward' && direction !== 'both') {
      throw new Error(`Invalid traversal direction: ${direction}`);
    }

    const indexResult = await this.pool.query<{ id: string }>(
      'SELECT id FROM memory_indexes WHERE project = $1 AND name = $2',
      [this.projectId, indexName]
    );

    if (indexResult.rows.length === 0) {
      return [];
    }

    const indexId = indexResult.rows[0].id;
    const params: unknown[] = [];
    const addParam = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    const projectParam = addParam(this.projectId);
    const indexParam = addParam(indexId);
    const rootParam = addParam(rootId);

    let relationshipFilterClause = '';
    if (relationshipTypes && relationshipTypes.length > 0) {
      const relationshipParam = addParam(relationshipTypes);
      relationshipFilterClause = ` AND relationship_type = ANY(${relationshipParam}::text[])`;
    }

    const maxDepthParam = addParam(maxDepth);
    const limitParam = addParam(limit);

    let edgesCte = '';
    switch (direction) {
      case 'forward':
        edgesCte = `
  edges AS (
    SELECT source_id, target_id, relationship_type, confidence
    FROM memory_relationships
    WHERE project = ${projectParam}
      AND index_id = ${indexParam}
      ${relationshipFilterClause}
  ),`;
        break;
      case 'backward':
        edgesCte = `
  edges AS (
    SELECT target_id AS source_id, source_id AS target_id, relationship_type, confidence
    FROM memory_relationships
    WHERE project = ${projectParam}
      AND index_id = ${indexParam}
      ${relationshipFilterClause}
  ),`;
        break;
      case 'both':
        edgesCte = `
  edges AS (
    SELECT source_id, target_id, relationship_type, confidence
    FROM memory_relationships
    WHERE project = ${projectParam}
      AND index_id = ${indexParam}
      ${relationshipFilterClause}
    UNION ALL
    SELECT target_id AS source_id, source_id AS target_id, relationship_type, confidence
    FROM memory_relationships
    WHERE project = ${projectParam}
      AND index_id = ${indexParam}
      ${relationshipFilterClause}
  ),`;
        break;
    }

    const query = `
      WITH RECURSIVE
      ${edgesCte}
      traversal AS (
        SELECT
          e.target_id AS memory_id,
          e.relationship_type,
          e.confidence,
          1 AS depth,
          ARRAY[${rootParam}::text, e.target_id] AS path
        FROM edges e
        WHERE e.source_id = ${rootParam}

        UNION ALL

        SELECT
          e.target_id,
          e.relationship_type,
          e.confidence,
          t.depth + 1 AS depth,
          t.path || e.target_id
        FROM edges e
        INNER JOIN traversal t ON e.source_id = t.memory_id
        WHERE t.depth < ${maxDepthParam}
          AND NOT e.target_id = ANY(t.path)
      )
      SELECT ranked.*
      FROM (
        SELECT DISTINCT ON (t.memory_id)
          m.id,
          m.content,
          m.created_at,
          m.metadata,
          m.memory_type,
          m.topic,
          m.importance,
          m.tags,
          m.source,
          m.source_path,
          m.channel,
          m.initial_priority,
          m.current_priority,
          m.updated_at,
          m.last_accessed_at,
          m.access_count,
          m.max_access_count,
          m.stability,
          m.sleep_cycles,
          m.kind,
          m.derived_from_ids,
          m.superseded_by_id,
          t.depth,
          t.relationship_type,
          t.confidence
        FROM traversal t
        INNER JOIN memories m
          ON m.id = t.memory_id
         AND m.index_id = ${indexParam}
         AND m.project = ${projectParam}
        ORDER BY t.memory_id, t.depth
      ) ranked
      ORDER BY ranked.depth, ranked.id
      LIMIT ${limitParam}
    `;

    type RelatedMemoryRow = MemoryRow & {
      id: string;
      content: string;
      depth: number;
      relationship_type?: string;
      confidence?: number;
    };

    const result = await this.runQuery<RelatedMemoryRow>('get-related-memories', query, params);

    const memories: MemoryRecord[] = result.rows.map((row) => ({
      id: row.id,
      content: {
        text: row.content,
        timestamp: row.created_at.toISOString(),
      },
      metadata: this.hydrateMetadata(row),
    }));

    await this.populateRelationships(memories);

    const memoryIds = memories.map((memory) => memory.id);
    if (memoryIds.length > 0) {
      this.updateAccessStats(indexName, memoryIds).catch((err) => {
        debugLog(
          'access',
          `Failed to update access stats for ${memoryIds.length} related memories:`,
          err
        );
      });
    }

    return memories;
  }

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
   * Find the shortest path of relationships between two memories.
   */
  async findRelationshipPath(
    indexName: string,
    sourceId: string,
    targetId: string,
    options?: {
      maxDepth?: number;
      relationshipTypes?: string[];
    }
  ): Promise<
    Array<{
      sourceId: string;
      targetId: string;
      type: string;
      metadata?: Record<string, unknown>;
    }>
  > {
    const normalizedIndexName = indexName.trim();
    const normalizedSourceId = sourceId.trim();
    const normalizedTargetId = targetId.trim();

    if (!normalizedIndexName) {
      throw new Error('indexName is required');
    }

    if (!normalizedSourceId) {
      throw new Error('sourceId is required');
    }

    if (!normalizedTargetId) {
      throw new Error('targetId is required');
    }

    if (normalizedSourceId === normalizedTargetId) {
      throw new Error('sourceId and targetId must be different');
    }

    const maxDepth = Math.min(Math.max(options?.maxDepth ?? 5, 1), 10);
    const relationshipTypes = options?.relationshipTypes
      ?.map((type) => type.trim())
      .filter((type) => type.length > 0);

    const indexResult = await this.pool.query<{ id: string }>(
      'SELECT id FROM memory_indexes WHERE project = $1 AND name = $2',
      [this.projectId, normalizedIndexName]
    );

    if (indexResult.rows.length === 0) {
      return [];
    }

    const indexId = indexResult.rows[0].id;

    const params: unknown[] = [];
    const addParam = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    const projectParam = addParam(this.projectId);
    const indexParam = addParam(indexId);
    const sourceParam = addParam(normalizedSourceId);
    const targetParam = addParam(normalizedTargetId);
    const maxDepthParam = addParam(maxDepth);

    let relationshipFilterClause = '';
    if (relationshipTypes && relationshipTypes.length > 0) {
      const relationshipParam = addParam(relationshipTypes);
      relationshipFilterClause = ` AND relationship_type = ANY(${relationshipParam}::text[])`;
    }

    const query = `
      WITH RECURSIVE
      edges AS (
        SELECT source_id, target_id, relationship_type, metadata
        FROM memory_relationships
        WHERE project = ${projectParam}
          AND index_id = ${indexParam}
          ${relationshipFilterClause}
      ),
      search AS (
        SELECT
          e.target_id AS current_id,
          1 AS depth,
          ARRAY[${sourceParam}::text, e.target_id] AS visited,
          jsonb_build_array(
            jsonb_build_object(
              'sourceId', e.source_id,
              'targetId', e.target_id,
              'type', e.relationship_type,
              'metadata', COALESCE(e.metadata, '{}'::jsonb)
            )
          ) AS path_edges
        FROM edges e
        WHERE e.source_id = ${sourceParam}

        UNION ALL

        SELECT
          e.target_id AS current_id,
          s.depth + 1 AS depth,
          s.visited || e.target_id,
          s.path_edges || jsonb_build_array(
            jsonb_build_object(
              'sourceId', e.source_id,
              'targetId', e.target_id,
              'type', e.relationship_type,
              'metadata', COALESCE(e.metadata, '{}'::jsonb)
            )
          )
        FROM edges e
        INNER JOIN search s ON e.source_id = s.current_id
        WHERE s.depth < ${maxDepthParam}
          AND NOT (e.target_id = ANY(s.visited))
      )
      SELECT path_edges, depth
      FROM search
      WHERE current_id = ${targetParam}
      ORDER BY depth
      LIMIT 1
    `;

    type PathRow = {
      path_edges: Array<{
        sourceId: string;
        targetId: string;
        type: string;
        metadata?: Record<string, unknown>;
      }>;
    };

    const result = await this.runQuery<PathRow>('find-relationship-path', query, params);

    if (result.rows.length === 0 || !Array.isArray(result.rows[0].path_edges)) {
      return [];
    }

    return result.rows[0].path_edges.map((edge) => ({
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      type: edge.type,
      metadata: edge.metadata ?? undefined,
    }));
  }

  /**
   * List all indexes with their document counts.
   */
  async listIndexes(): Promise<IndexSummary[]> {
    const result = await this.pool.query<{
      name: string;
      count: string;
      description: string | null;
    }>(
      `SELECT mi.name, mi.description, COUNT(m.id)::text as count
       FROM memory_indexes mi
       LEFT JOIN memories m ON m.index_id = mi.id AND m.project = mi.project
       WHERE mi.project = $1
       GROUP BY mi.id, mi.name, mi.description
       ORDER BY mi.name`,
      [this.projectId]
    );

    return result.rows.map((row: { name: string; count: string; description: string | null }) => ({
      name: row.name,
      documentCount: parseInt(row.count, 10),
      pendingDocumentCount: 0, // Postgres doesn't have pending documents
      description: row.description ?? undefined,
    }));
  }

  /**
   * Increment the sleepCycles counter on specified memories.
   * Used during reconsolidation to track memories that were processed.
   */
  async incrementSleepCycles(
    indexName: string,
    ids: string[],
    amount: number = 1
  ): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    try {
      // Resolve index ID to ensure we only update memories in this index
      const indexResult = await this.pool.query<{ id: string }>(
        'SELECT id FROM memory_indexes WHERE project = $1 AND name = $2',
        [this.projectId, indexName]
      );

      if (indexResult.rows.length === 0) {
        debugLog('reconsolidation', `Index ${indexName} not found for incrementSleepCycles`);
        return 0;
      }

      const indexId = indexResult.rows[0].id;

      // Update memories to increment sleep_cycles in both metadata JSONB and denormalized column
      const updateQuery = `
        UPDATE memories
        SET
          metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{dynamics,sleepCycles}',
            to_jsonb(COALESCE((metadata->'dynamics'->>'sleepCycles')::int, 0) + $1)
          ),
          sleep_cycles = COALESCE(sleep_cycles, 0) + $1,
          updated_at = NOW()
        WHERE id = ANY($2::text[])
          AND index_id = $3
          AND project = $4
        RETURNING id
      `;

      const result = await this.pool.query<{ id: string }>(updateQuery, [
        amount,
        ids,
        indexId,
        this.projectId,
      ]);

      debugLog(
        'reconsolidation',
        `Incremented sleepCycles by ${amount} for ${result.rows.length} memories`
      );

      return result.rows.length;
    } catch (error) {
      const errorInfo = this.mapPostgresError(error);
      debugLog('reconsolidation', `Error incrementing sleepCycles: ${errorInfo.message}`);
      // Don't throw - log and continue
      return 0;
    }
  }

  /**
   * Mark memories as superseded by other memories.
   * Used during reconsolidation when derived memories replace older memories.
   */
  async markMemoriesSuperseded(
    indexName: string,
    pairs: Array<{ sourceId: string; supersededById: string | number }>
  ): Promise<number> {
    if (pairs.length === 0) {
      return 0;
    }

    try {
      // Resolve index ID to ensure we only update memories in this index
      const indexResult = await this.pool.query<{ id: string }>(
        'SELECT id FROM memory_indexes WHERE project = $1 AND name = $2',
        [this.projectId, indexName]
      );

      if (indexResult.rows.length === 0) {
        debugLog('reconsolidation', `Index ${indexName} not found for markMemoriesSuperseded`);
        return 0;
      }

      const indexId = indexResult.rows[0].id;

      // Build a temporary table with the pairs to avoid N+1 queries
      // Using UNNEST to create a table expression
      // Convert all supersededById values to strings for SQL
      const sourceIds = pairs.map((p) => p.sourceId);
      const supersededByIds = pairs.map((p) => String(p.supersededById));

      const updateQuery = `
        UPDATE memories
        SET
          metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{supersededById}',
            to_jsonb(pairs.superseded_by_id)
          ),
          superseded_by_id = pairs.superseded_by_id,
          updated_at = NOW()
        FROM (
          SELECT unnest($1::text[]) AS source_id, unnest($2::text[]) AS superseded_by_id
        ) AS pairs
        WHERE memories.id = pairs.source_id
          AND memories.index_id = $3
          AND memories.project = $4
        RETURNING memories.id
      `;

      const result = await this.pool.query<{ id: string }>(updateQuery, [
        sourceIds,
        supersededByIds,
        indexId,
        this.projectId,
      ]);

      debugLog(
        'reconsolidation',
        `Marked ${result.rows.length} memories as superseded in index ${indexName}`
      );

      return result.rows.length;
    } catch (error) {
      const errorInfo = this.mapPostgresError(error);
      debugLog('reconsolidation', `Error marking memories as superseded: ${errorInfo.message}`);
      // Don't throw - log and continue
      return 0;
    }
  }
}
