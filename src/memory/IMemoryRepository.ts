import {
  MemoryRecord,
  MemoryToUpsert,
  MemoryMetadata,
  SearchResult,
  SearchDiagnostics,
} from './types.js';

/**
 * Database-level information from the memory backend.
 *
 * Different backends may provide different subsets of these fields based on
 * their capabilities. Optional fields should return undefined if not supported.
 */
export interface DatabaseInfo {
  documentCount: number;
  pendingDocumentCount?: number; // Optional: some backends may not track pending operations
  diskSize?: number; // Optional: some backends may not expose storage size
  indexes: Record<string, IndexInfo>;
}

/**
 * Per-index statistics from the database.
 *
 * Different backends may provide different subsets of these fields based on
 * their capabilities. Optional fields should return undefined if not supported.
 */
export interface IndexInfo {
  documentCount: number;
  pendingDocumentCount?: number; // Optional: some backends may not track pending operations
}

/**
 * Index summary for listing operations
 */
export interface IndexSummary {
  name: string;
  documentCount: number;
  pendingDocumentCount: number;
  description?: string;
}

/**
 * Backend-neutral repository interface for memory storage and retrieval.
 *
 * This interface abstracts the underlying storage implementation (Upstash, Postgres, etc.)
 * to allow the MCP stack to depend on a stable contract rather than specific backends.
 *
 * All implementations must provide:
 * - CRUD operations (upsert, get, delete)
 * - Semantic search with metadata filtering
 * - Access tracking for memory lifecycle management
 * - Index management and diagnostics
 */
export interface IMemoryRepository {
  /**
   * Ensure that an index exists (idempotent).
   *
   * @param indexName - Logical index name
   * @param description - Optional human-friendly description
   */
  ensureIndex(indexName: string, description?: string): Promise<void>;

  /**
   * Upsert a batch of memories.
   *
   * @param indexName - Target index for storage
   * @param memories - Array of memories to store (with optional IDs for updates)
   * @param defaultMetadata - Optional metadata to merge into each memory
   * @returns Array of memory IDs (generated for new memories, preserved for updates)
   * @throws Error if metadata validation fails or storage operation fails
   */
  upsertMemories(
    indexName: string,
    memories: MemoryToUpsert[],
    defaultMetadata?: Partial<MemoryMetadata>
  ): Promise<string[]>;

  /**
   * Update access statistics for recently retrieved memories.
   *
   * This is a fire-and-forget operation that updates dynamics fields
   * (accessCount, currentPriority, lastAccessedAt) for top-N results.
   *
   * @param indexName - Index containing the memories
   * @param ids - Memory IDs to update (will be sliced to topN)
   * @param options - Optional overrides for topN and priority boost
   * @param options.priorityBoost - Deprecated, use environment configuration instead
   */
  updateAccessStats(
    indexName: string,
    ids: string[],
    options?: {
      topN?: number;
      priorityBoost?: number; // Deprecated: prefer environment config
    }
  ): Promise<void>;

  /**
   * Search for memories with diagnostic instrumentation.
   *
   * @param indexName - Index to search
   * @param query - Search query (semantic + keyword)
   * @param options - Search parameters (limit, filters, reranking, diagnostics callback)
   * @param options.filterExpression - Backend-specific filter expression syntax.
   *        Implementations define their own filter DSL. Consumers should use
   *        backend-appropriate syntax or provide higher-level filter builders.
   * @returns Array of search results with scores and metadata
   * @throws MemorySearchError with diagnostics on search failure
   */
  searchMemories(
    indexName: string,
    query: string,
    options?: {
      limit?: number;
      semanticWeight?: number;
      filterExpression?: string; // Implementation-specific syntax
      includeMetadata?: boolean;
      reranking?: boolean;
      diagnosticsListener?: (diag: SearchDiagnostics) => void;
    }
  ): Promise<SearchResult[]>;

  /**
   * Delete memories by IDs.
   *
   * @param indexName - Index containing the memories
   * @param ids - Memory IDs to delete
   * @returns Count of successfully deleted memories
   */
  deleteMemories(indexName: string, ids: string[]): Promise<number>;

  /**
   * Get a single memory by ID.
   *
   * Uses search API as fallback when fetch API fails, ensuring consistency
   * with recall operations.
   *
   * @param indexName - Index containing the memory
   * @param id - Memory ID to retrieve
   * @returns Memory record or null if not found
   * @throws Error if ID is invalid or retrieval fails
   */
  getMemory(indexName: string, id: string): Promise<MemoryRecord | null>;

  /**
   * Fetch multiple memories by IDs.
   *
   * Uses search API as fallback for any IDs not found via fetch, ensuring
   * consistency with recall operations.
   *
   * @param indexName - Index containing the memories
   * @param ids - Array of memory IDs to retrieve
   * @returns Array of found memory records (may be fewer than requested)
   * @throws Error if IDs are invalid or retrieval fails
   */
  getMemories(indexName: string, ids: string[]): Promise<MemoryRecord[]>;

  /**
   * Check if an index is accessible (connectivity test).
   *
   * @param indexName - Index to test
   * @returns true if index is accessible, false otherwise
   */
  testIndex(indexName: string): Promise<boolean>;

  /**
   * Get database-level information including per-index statistics.
   *
   * @returns Database information with index statistics
   * @throws Error if database info retrieval fails
   */
  getDatabaseInfo(): Promise<DatabaseInfo>;

  /**
   * List all indexes with their document counts.
   *
   * @returns Array of index summaries
   */
  listIndexes(): Promise<IndexSummary[]>;
}
