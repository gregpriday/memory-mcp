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
 * This interface abstracts the underlying storage implementation (Postgres, etc.)
 * to allow the MCP stack to depend on a stable contract rather than specific backends.
 *
 * All implementations must provide:
 * - CRUD operations (upsert, get, delete)
 * - Semantic search with metadata filtering
 * - Access tracking for memory lifecycle management
 * - Index management and diagnostics
 *
 * @public
 *
 * @remarks
 * Different backends may support different feature subsets. For example:
 * - Filter syntax is backend-specific (see `FilterParser` for Postgres implementation)
 * - Some backends may not track pending operations (`pendingDocumentCount` will be undefined)
 * - Diagnostics availability varies by backend implementation
 *
 * @example
 * ```typescript
 * // Obtain repository instance from your factory or wiring
 * const repo: IMemoryRepository = createMemoryRepository();
 *
 * // Ensure index exists
 * await repo.ensureIndex('chat-history', 'Conversation memories');
 *
 * // Store memories
 * const ids = await repo.upsertMemories('chat-history', [
 *   { text: 'User prefers dark mode', metadata: { importance: 'high' } }
 * ], { source: 'preferences' });
 *
 * // Search memories
 * const results = await repo.searchMemories('chat-history', 'UI preferences', {
 *   limit: 5,
 *   filterExpression: '@metadata.source = "preferences"'
 * });
 * ```
 */
export interface IMemoryRepository {
  /**
   * Ensure that an index exists (idempotent).
   *
   * Creates a new index if it doesn't exist, or returns immediately if it already exists.
   * Safe to call multiple times with the same index name.
   *
   * @param indexName - Logical index name (e.g., 'chat-history', 'documents', 'user-preferences')
   * @param description - Optional human-friendly description for the index purpose
   *
   * @remarks
   * Index names should be lowercase with hyphens for consistency.
   * The description is stored with the index metadata and can help with index management.
   *
   * @example
   * ```typescript
   * // Create a new index
   * await repo.ensureIndex('chat-history', 'Conversation memories from user interactions');
   *
   * // Calling again is safe (idempotent)
   * await repo.ensureIndex('chat-history'); // No error, returns immediately
   * ```
   */
  ensureIndex(indexName: string, description?: string): Promise<void>;

  /**
   * Upsert a batch of memories.
   *
   * Inserts new memories or updates existing ones based on the presence of an ID.
   * If a memory has an ID, it will update the existing record; otherwise, a new ID is generated.
   *
   * @param indexName - Target index for storage
   * @param memories - Array of memories to store (with optional IDs for updates)
   * @param defaultMetadata - Optional metadata to merge into each memory (useful for batch tagging)
   * @returns Array of memory IDs (generated for new memories, preserved for updates) in same order as input
   * @throws Error if metadata validation fails or storage operation fails
   *
   * @remarks
   * - The `defaultMetadata` is merged with individual memory metadata (memory metadata takes precedence)
   * - All memories in the batch are processed atomically where supported by the backend
   * - For updates, only provided fields are modified; others remain unchanged
   *
   * @example
   * ```typescript
   * // Insert new memories with shared metadata
   * const ids = await repo.upsertMemories('chat-history', [
   *   { content: 'User prefers dark mode', importance: 0.8 },
   *   { content: 'User is in Pacific timezone', importance: 0.9 }
   * ], {
   *   source: 'preferences',
   *   tags: ['user-settings']
   * });
   * // Returns: ['generated-id-1', 'generated-id-2']
   *
   * // Update existing memory by providing ID
   * await repo.upsertMemories('chat-history', [
   *   { id: ids[0], content: 'User switched to light mode', importance: 0.9 }
   * ]);
   * ```
   */
  upsertMemories(
    indexName: string,
    memories: MemoryToUpsert[],
    defaultMetadata?: Partial<MemoryMetadata>
  ): Promise<string[]>;

  /**
   * Update access statistics for recently retrieved memories.
   *
   * This is a fire-and-forget operation that updates dynamic fields
   * (accessCount, currentPriority, lastAccessedAt) for recently accessed memories.
   * Used to implement memory lifecycle management where frequently accessed memories
   * have higher priority.
   *
   * @param indexName - Index containing the memories
   * @param ids - Memory IDs to update (will be sliced to topN if more are provided)
   * @param options - Optional overrides for topN and priority boost
   * @param options.topN - Maximum number of IDs to update (default: 5). Only the first N IDs are updated.
   * @param options.priorityBoost - Deprecated, use environment configuration instead
   *
   * @remarks
   * - This operation runs asynchronously and does not block the caller
   * - Errors during access tracking are logged but do not fail the search operation
   * - Priority is recalculated using PriorityCalculator formula (recency × 0.4 + importance × 0.4 + usage × 0.2)
   * - Only the first `topN` memory IDs are updated to avoid excessive write load
   *
   * @example
   * ```typescript
   * // After searching memories, update access stats for results
   * const results = await repo.searchMemories('chat-history', 'user preferences', { limit: 10 });
   * const resultIds = results.map(r => r.id);
   *
   * // Fire-and-forget: updates top 5 results' access stats
   * await repo.updateAccessStats('chat-history', resultIds, { topN: 5 });
   * // Call returns immediately; stats update happens asynchronously
   * ```
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
   * Performs semantic search using embeddings combined with optional keyword matching
   * and metadata filtering. Results are ranked by relevance score.
   *
   * @param indexName - Index to search
   * @param query - Search query (semantic + keyword). Empty string searches all memories.
   * @param options - Search parameters (limit, filters, reranking, diagnostics callback)
   * @param options.limit - Maximum number of results to return (default: 10)
   * @param options.semanticWeight - Weight for semantic vs keyword matching, 0.0-1.0 (default: 0.7)
   * @param options.filterExpression - Backend-specific filter expression syntax.
   *        Implementations define their own filter DSL. For Postgres, see `FilterParser`.
   *        Example: `@metadata.tags contains "work" AND @metadata.priority > 0.5`
   * @param options.includeMetadata - Whether to include full metadata in results (default: true)
   * @param options.reranking - Whether to apply reranking for improved relevance (default: false)
   * @param options.diagnosticsListener - Optional callback for search diagnostics (timing, query plans)
   * @returns Array of search results with scores and metadata, ordered by relevance (highest first)
   * @throws MemorySearchError with diagnostics on search failure
   *
   * @remarks
   * - Results are always ordered by descending relevance score
   * - Filter syntax is backend-specific; Postgres uses FilterParser DSL
   * - Semantic weight of 1.0 means pure semantic search; 0.0 means pure keyword search
   * - Empty query with filters can be used to filter memories without semantic ranking
   *
   * @example
   * ```typescript
   * // Basic semantic search
   * const results = await repo.searchMemories('chat-history', 'user preferences', {
   *   limit: 5
   * });
   *
   * // Search with metadata filter (Postgres syntax)
   * const workMemories = await repo.searchMemories('documents', 'project timeline', {
   *   limit: 10,
   *   filterExpression: '@metadata.tags contains "work" AND @metadata.source = "slack"'
   * });
   *
   * // Pure filtering without semantic search
   * const highPriority = await repo.searchMemories('tasks', '', {
   *   filterExpression: '@metadata.priority > 0.8',
   *   limit: 20
   * });
   *
   * // Search with diagnostics
   * const debugResults = await repo.searchMemories('chat-history', 'API design', {
   *   limit: 5,
   *   diagnosticsListener: (diag) => console.log('Search took:', diag.totalDuration, 'ms')
   * });
   * ```
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
   * Permanently removes memories from the index. This operation cannot be undone.
   *
   * @param indexName - Index containing the memories
   * @param ids - Memory IDs to delete
   * @returns Count of successfully deleted memories (may be less than requested if some IDs don't exist)
   *
   * @remarks
   * - Non-existent IDs are silently ignored
   * - The operation is atomic where supported by the backend
   * - Returns the actual count of deleted memories, not the count of requested IDs
   *
   * @example
   * ```typescript
   * // Delete specific memories
   * const deletedCount = await repo.deleteMemories('chat-history', [
   *   'memory-id-1',
   *   'memory-id-2',
   *   'non-existent-id'  // Silently ignored
   * ]);
   * console.log(`Deleted ${deletedCount} memories`); // Output: "Deleted 2 memories"
   * ```
   */
  deleteMemories(indexName: string, ids: string[]): Promise<number>;

  /**
   * Get a single memory by ID.
   *
   * Retrieves a specific memory by its unique identifier. Uses search API as fallback
   * when direct fetch fails, ensuring consistency with recall operations.
   *
   * @param indexName - Index containing the memory
   * @param id - Memory ID to retrieve (must be a valid UUID or backend-specific ID)
   * @returns Memory record or null if not found
   * @throws Error if ID is invalid or retrieval fails
   *
   * @remarks
   * - Returns null for non-existent IDs (does not throw)
   * - Fallback to search API ensures consistency across different retrieval methods
   * - May trigger access stat updates depending on backend implementation
   *
   * @example
   * ```typescript
   * // Retrieve a specific memory
   * const memory = await repo.getMemory('chat-history', 'uuid-1234-5678');
   * if (memory) {
   *   console.log('Found:', memory.content);
   * } else {
   *   console.log('Memory not found');
   * }
   * ```
   */
  getMemory(indexName: string, id: string): Promise<MemoryRecord | null>;

  /**
   * Fetch multiple memories by IDs.
   *
   * Retrieves multiple memories in a single operation. Uses search API as fallback
   * for any IDs not found via direct fetch, ensuring consistency with recall operations.
   *
   * @param indexName - Index containing the memories
   * @param ids - Array of memory IDs to retrieve
   * @returns Array of found memory records (may be fewer than requested if some IDs don't exist)
   * @throws Error if IDs are invalid or retrieval fails
   *
   * @remarks
   * - Missing IDs are silently omitted from results (no error thrown)
   * - Results are returned in arbitrary order (not necessarily matching input order)
   * - More efficient than calling getMemory multiple times
   *
   * @example
   * ```typescript
   * // Fetch multiple memories at once
   * const memories = await repo.getMemories('documents', [
   *   'uuid-1234',
   *   'uuid-5678',
   *   'uuid-9012'
   * ]);
   * console.log(`Found ${memories.length} of 3 requested memories`);
   * ```
   */
  getMemories(indexName: string, ids: string[]): Promise<MemoryRecord[]>;

  /**
   * Check if an index is accessible (connectivity test).
   *
   * Tests whether an index exists and is accessible. Useful for health checks
   * and validating index names before operations.
   *
   * @param indexName - Index to test
   * @returns true if index exists and is accessible, false otherwise
   *
   * @remarks
   * - Returns false for non-existent indexes (does not throw)
   * - Can be used to verify backend connectivity
   * - Lightweight operation suitable for health checks
   *
   * @example
   * ```typescript
   * // Check if index exists before querying
   * const isAccessible = await repo.testIndex('chat-history');
   * if (!isAccessible) {
   *   await repo.ensureIndex('chat-history', 'Chat conversation memories');
   * }
   * ```
   */
  testIndex(indexName: string): Promise<boolean>;

  /**
   * Get database-level information including per-index statistics.
   *
   * Retrieves comprehensive statistics about the database and all indexes,
   * including document counts, pending operations, and storage size where available.
   *
   * @returns Database information with index statistics
   * @throws Error if database info retrieval fails
   *
   * @remarks
   * - Some fields may be undefined if not supported by the backend
   * - `pendingDocumentCount` is typically 0 for Postgres (no pending operations)
   * - `diskSize` may not be available on all backends
   * - This operation may be expensive on large databases; use sparingly
   *
   * @example
   * ```typescript
   * // Get database statistics
   * const dbInfo = await repo.getDatabaseInfo();
   * console.log(`Total documents: ${dbInfo.documentCount}`);
   * console.log(`Indexes: ${Object.keys(dbInfo.indexes).length}`);
   *
   * // Check specific index stats
   * if (dbInfo.indexes['chat-history']) {
   *   console.log(`Chat history has ${dbInfo.indexes['chat-history'].documentCount} documents`);
   * }
   * ```
   */
  getDatabaseInfo(): Promise<DatabaseInfo>;

  /**
   * List all indexes with their document counts.
   *
   * Returns a summary of all indexes in the database. Lighter weight than
   * `getDatabaseInfo()` as it only returns basic index information.
   *
   * @returns Array of index summaries with names and document counts
   *
   * @remarks
   * - Results are unordered
   * - More efficient than `getDatabaseInfo()` for just listing indexes
   * - Suitable for index selection UIs and management tools
   *
   * @example
   * ```typescript
   * // List all available indexes
   * const indexes = await repo.listIndexes();
   * for (const index of indexes) {
   *   console.log(`${index.name}: ${index.documentCount} documents`);
   * }
   *
   * // Find largest index
   * const largest = indexes.reduce((max, idx) =>
   *   idx.documentCount > max.documentCount ? idx : max
   * );
   * console.log(`Largest index: ${largest.name}`);
   * ```
   */
  listIndexes(): Promise<IndexSummary[]>;

  /**
   * Get memories related to a root memory through multi-hop relationship traversal.
   *
   * Performs graph traversal starting from a root memory, following relationships
   * up to a specified depth. Uses recursive CTEs for efficient multi-hop navigation.
   *
   * @param indexName - Index containing the memories
   * @param rootId - Starting memory ID for traversal
   * @param options - Traversal options (depth, relationship types, direction)
   * @param options.maxDepth - Maximum traversal depth (default: 3, max: 10 to prevent runaway queries)
   * @param options.relationshipTypes - Filter by specific relationship types (undefined = all types)
   * @param options.direction - Traversal direction: 'forward' (outgoing), 'backward' (incoming), 'both' (default: 'forward')
   * @param options.limit - Maximum number of related memories to return (default: 100)
   * @returns Array of related memory records with relationship metadata
   *
   * @remarks
   * - Traversal stops at maxDepth or when no more relationships are found
   * - Results include all memories within maxDepth hops, not just leaf nodes
   * - Relationship cycles are automatically detected and prevented
   * - Use 'backward' direction to find memories that reference the root
   * - Use 'both' direction for undirected graph traversal
   *
   * @example
   * ```typescript
   * // Find all memories within 2 hops of a root memory
   * const related = await repo.getRelatedMemories('knowledge', 'root-id', {
   *   maxDepth: 2,
   *   direction: 'forward'
   * });
   *
   * // Find memories that support or contradict a belief
   * const evidence = await repo.getRelatedMemories('beliefs', 'belief-id', {
   *   relationshipTypes: ['supports', 'contradicts'],
   *   direction: 'backward',
   *   maxDepth: 3
   * });
   * ```
   */
  getRelatedMemories(
    indexName: string,
    rootId: string,
    options?: {
      maxDepth?: number;
      relationshipTypes?: string[];
      direction?: 'forward' | 'backward' | 'both';
      limit?: number;
    }
  ): Promise<MemoryRecord[]>;

  /**
   * Find the shortest relationship path between two memories.
   *
   * Discovers the shortest path of relationships connecting a source memory
   * to a target memory. Uses bidirectional search for efficiency.
   *
   * @param indexName - Index containing the memories
   * @param sourceId - Starting memory ID
   * @param targetId - Destination memory ID
   * @param options - Path finding options
   * @param options.maxDepth - Maximum path length to search (default: 5, max: 10)
   * @param options.relationshipTypes - Limit to specific relationship types (undefined = all types)
   * @returns Array of relationships forming the shortest path, or empty array if no path exists
   *
   * @remarks
   * - Returns empty array if source and target are not connected within maxDepth
   * - Path includes intermediate relationships in order from source to target
   * - Uses bidirectional BFS for optimal performance on large graphs
   * - Each relationship includes type, source, target, and optional metadata
   *
   * @example
   * ```typescript
   * // Find path between two memories
   * const path = await repo.findRelationshipPath('knowledge', 'source-id', 'target-id', {
   *   maxDepth: 5
   * });
   *
   * if (path.length > 0) {
   *   console.log(`Found path with ${path.length} hops:`);
   *   path.forEach((rel, i) => {
   *     console.log(`  ${i + 1}. ${rel.type}: ${rel.sourceId} → ${rel.targetId}`);
   *   });
   * } else {
   *   console.log('No path found within max depth');
   * }
   *
   * // Find path through specific relationship types only
   * const summaryPath = await repo.findRelationshipPath('docs', 'detail-id', 'summary-id', {
   *   relationshipTypes: ['summarizes', 'is_generalization_of'],
   *   maxDepth: 3
   * });
   * ```
   */
  findRelationshipPath(
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
  >;

  /**
   * Increment the sleepCycles counter on specified memories.
   *
   * Updates the `sleepCycles` field in memory metadata to track refinement passes.
   * Used during reconsolidation to mark memories that were processed and evolved.
   *
   * @param indexName - Index containing the memories
   * @param ids - Memory IDs to update
   * @param amount - Number of cycles to increment by (default: 1)
   * @returns Number of memories successfully updated
   *
   * @remarks
   * - Non-existent IDs are silently ignored
   * - Only the `sleepCycles` field is modified; other fields remain unchanged
   * - Returns actual count of memories updated (may be less than requested if some IDs don't exist)
   *
   * @example
   * ```typescript
   * // Increment sleep cycles for memories involved in reconsolidation
   * const updated = await repo.incrementSleepCycles('chat-history', [
   *   'memory-1',
   *   'memory-2',
   *   'memory-3'
   * ]);
   * console.log(`Updated ${updated} memories`);
   * ```
   */
  incrementSleepCycles(indexName: string, ids: string[], amount?: number): Promise<number>;

  /**
   * Mark memories as superseded by other memories.
   *
   * Sets the `supersededById` field on source memories to indicate they are
   * superseded by a replacement memory. Used during reconsolidation when a
   * synthesized memory replaces or consolidates older memories.
   *
   * @param indexName - Index containing the memories
   * @param pairs - Array of (sourceId, supersededById) pairs where supersededById can be:
   *   - A string memory ID (must exist in the same index)
   *   - A number referencing an index in a derivedMemories array (only used internally by executor)
   * @returns Number of memories successfully updated
   *
   * @remarks
   * - Non-existent source IDs are silently ignored
   * - Only the `supersededById` field is modified; other fields remain unchanged
   * - Multiple source memories can be superseded by the same derived memory
   * - Returns actual count of memories updated (may be less than requested if some IDs don't exist)
   *
   * @example
   * ```typescript
   * // Mark old memories as superseded by a new derived summary
   * const updated = await repo.markMemoriesSuperseded('chat-history', [
   *   { sourceId: 'episode-1', supersededById: 'summary-1' },
   *   { sourceId: 'episode-2', supersededById: 'summary-1' },
   *   { sourceId: 'episode-3', supersededById: 'summary-1' }
   * ]);
   * console.log(`Marked ${updated} memories as superseded`);
   * ```
   */
  markMemoriesSuperseded(
    indexName: string,
    pairs: Array<{ sourceId: string; supersededById: string | number }>
  ): Promise<number>;
}
