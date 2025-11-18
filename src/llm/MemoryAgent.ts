import { LLMClient } from './LLMClient.js';
import { PromptManager } from './PromptManager.js';
import { IMemoryRepository } from '../memory/IMemoryRepository.js';
import { ProjectFileLoader } from '../memory/ProjectFileLoader.js';
import {
  MemorizeToolArgs,
  RecallToolArgs,
  ForgetToolArgs,
  CreateIndexToolArgs,
  RefineMemoriesToolArgs,
  ScanMemoriesToolArgs,
  MemorizeResult,
  RecallResult,
  ForgetResult,
  CreateIndexResult,
  ListIndexesResult,
  RefineMemoriesResult,
  ScanMemoriesResult,
  MemoryToUpsert,
  RefinementAction,
  UpdateRefinementAction,
  DeleteRefinementAction,
  MergeRefinementAction,
  CreateRefinementAction,
  SearchResult,
  SearchDiagnostics,
  SearchStatus,
} from '../memory/types.js';
import { MemorySearchError } from '../memory/MemorySearchError.js';
import { loadRefinementConfig } from '../config/refinement.js';
import { validateAction, ValidationContext } from '../validators/RefinementActionValidator.js';
import { debugLogOperation, debugLog } from '../utils/logger.js';
import {
  MemoryAgentConfig,
  RequestContext,
  convertFiltersToExpression,
  hasUsableMetadataFilters,
  safeJsonParse,
} from './agent/shared/index.js';
import { ToolRuntime } from './agent/runtime/index.js';
import { MemorizeOperation } from './agent/operations/memorize/index.js';

/**
 * MemoryAgent
 * Implements the core memory operations using LLM with tool calling
 */
export class MemoryAgent {
  private toolRuntime: ToolRuntime;
  private memorizeOperation: MemorizeOperation;
  private projectId?: string;

  constructor(
    private llm: LLMClient,
    private prompts: PromptManager,
    private repo: IMemoryRepository,
    private fileLoader: ProjectFileLoader,
    config: MemoryAgentConfig = {}
  ) {
    this.projectId = config.projectId;
    // Initialize tool runtime
    this.toolRuntime = new ToolRuntime(llm, prompts, repo, fileLoader);

    // Initialize operations
    this.memorizeOperation = new MemorizeOperation(
      llm,
      prompts,
      repo,
      fileLoader,
      this.toolRuntime,
      config
    );
  }

  /**
   * Store information from natural language or files using LLM-powered extraction.
   *
   * Processes user input and files (with automatic chunking for large files)
   * through an LLM agent that extracts structured memories and stores them
   * through automatic chunking and preprocessing.
   *
   * @param args - Memorize tool arguments including input text, files, and metadata
   * @param index - Target memory index name
   * @param projectSystemMessage - Optional project-specific system message for context
   * @returns Promise resolving to MemorizeResult with stored memory IDs and status
   *
   * @example
   * ```typescript
   * const result = await agent.memorize(
   *   {
   *     input: "Remember the key points from this pricing document",
   *     files: ["docs/pricing-strategy.md"],
   *     metadata: { topic: "pricing", importance: "high" }
   *   },
   *   "my-index"
   * );
   * console.log(`Stored ${result.storedCount} memories`);
   * ```
   */
  async memorize(
    args: MemorizeToolArgs,
    index: string,
    projectSystemMessage?: string
  ): Promise<MemorizeResult> {
    return this.memorizeOperation.execute(args, index, projectSystemMessage);
  }

  /**
   * Run expanded searches for query variations and merge results.
   *
   * Expands the original query into semantic variations, searches all queries in parallel,
   * and merges results by memory ID (keeping highest score). Returns merged results with
   * diagnostics for each query variation.
   *
   * @param query - Original user query
   * @param index - Target memory index
   * @param limit - Maximum results per query
   * @param semanticWeight - Semantic weight for searches
   * @param filterExpression - Optional filter expression for searches
   * @param reranking - Whether to enable reranking
   * @returns Merged search results and diagnostics for all variations
   */
  private async runExpandedSearches(
    query: string,
    index: string,
    limit: number,
    semanticWeight?: number,
    filterExpression?: string,
    reranking?: boolean
  ): Promise<{
    mergedResults: SearchResult[];
    diagnostics: SearchDiagnostics[];
  }> {
    const config = loadRefinementConfig();

    // Expand query into variations
    const expandedQueries = config.queryExpansionEnabled
      ? await this.llm.expandQuery(query, config.queryExpansionCount)
      : [];

    // Build list of all queries to search (original + expanded)
    const allQueries = [query, ...expandedQueries];

    debugLog('query-expansion', 'Running expanded searches', {
      originalQuery: query,
      expandedQueries,
      totalQueries: allQueries.length,
    });

    // Run all searches in parallel
    const searchPromises = allQueries.map(async (q, idx) => {
      const startTime = Date.now();
      const diagnostics: SearchDiagnostics[] = [];

      try {
        const results = await this.repo.searchMemories(index, q, {
          limit,
          semanticWeight,
          filterExpression,
          includeMetadata: true,
          reranking,
          diagnosticsListener: (diag) => {
            diagnostics.push(diag);
          },
        });

        return {
          query: q,
          isOriginal: idx === 0,
          results,
          diagnostics,
          error: undefined,
        };
      } catch (error) {
        // Create error diagnostic
        const errorDiag: SearchDiagnostics = {
          index,
          query: q,
          limit,
          semanticWeight: semanticWeight ?? 0.7,
          filterExpression,
          reranking: reranking ?? true,
          durationMs: Date.now() - startTime,
          status: 'search_error',
          resultCount: 0,
          retryCount: 0,
          lastError: (error as Error).message,
          timestamp: new Date().toISOString(),
        };

        return {
          query: q,
          isOriginal: idx === 0,
          results: [],
          diagnostics: [errorDiag],
          error: (error as Error).message,
        };
      }
    });

    const searchResults = await Promise.all(searchPromises);

    // Merge results by memory ID, keeping highest score
    const mergedMap = new Map<string, SearchResult & { sourceQuery: string }>();
    const allDiagnostics: SearchDiagnostics[] = [];

    for (const search of searchResults) {
      // Collect diagnostics
      allDiagnostics.push(...search.diagnostics);

      // Merge results
      for (const result of search.results) {
        const existing = mergedMap.get(result.id);
        const resultScore = result.score ?? 0;
        const existingScore = existing?.score ?? 0;

        // Keep result with highest score
        if (!existing || resultScore > existingScore) {
          mergedMap.set(result.id, {
            ...result,
            sourceQuery: search.query,
          });
        }
      }
    }

    // Convert map to array and sort by score (descending)
    const mergedResults = Array.from(mergedMap.values())
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit)
      .map(({ sourceQuery: _sourceQuery, ...rest }) => rest); // Remove sourceQuery from final results

    debugLog('query-expansion', 'Merged search results', {
      totalSearches: allQueries.length,
      totalResults: Array.from(mergedMap.values()).length,
      finalResults: mergedResults.length,
      diagnosticsCount: allDiagnostics.length,
    });

    return {
      mergedResults,
      diagnostics: allDiagnostics,
    };
  }

  /**
   * Execute the recall operation via LLM-powered agent.
   *
   * Retrieves and synthesizes information using semantic search with metadata filters.
   * Automatically tracks access patterns for the top-N results to reinforce frequently
   * used memories (controlled by MEMORY_ACCESS_TRACKING_ENABLED and
   * MEMORY_ACCESS_TRACKING_TOP_N environment variables).
   *
   * @param args - Recall tool arguments including query, filters, limit, and response mode
   * @param index - Target memory index name
   * @param projectSystemMessage - Optional project-specific system message for retrieval context
   * @returns Promise resolving to RecallResult with synthesized answer and/or memory hits
   *
   * @remarks
   * Response mode controls output format:
   * - "answer": Synthesized response only (default)
   * - "memories": Raw memory hits only
   * - "both": Synthesized answer + supporting memories
   *
   * Access tracking updates dynamics.accessCount, dynamics.currentPriority, and
   * dynamics.lastAccessedAt for top-N results to enable reinforcement learning.
   *
   * @example
   * ```typescript
   * const result = await agent.recall(
   *   {
   *     query: "How did I explain pricing psychology?",
   *     filters: { topic: "pricing" },
   *     responseMode: "both"
   *   },
   *   "my-index"
   * );
   * console.log(result.answer);
   * console.log(`Found ${result.memories?.length} supporting memories`);
   * ```
   */
  async recall(
    args: RecallToolArgs,
    index: string,
    projectSystemMessage?: string
  ): Promise<RecallResult> {
    const endLog = debugLogOperation('recall', {
      index,
      query: args.query,
      limit: args.limit || 10,
      responseMode: args.responseMode || 'answer',
      hasFilters: Boolean(args.filters && Object.keys(args.filters).length > 0),
    });

    // Create request-specific context for thread safety
    const context: RequestContext = {
      index,
      storedMemoryIds: [],
      operationMode: 'normal',
      searchIterationCount: 0,
      trackedMemoryIds: new Set(),
      searchDiagnostics: [], // Initialize diagnostics array
      operationLog: [],
    };

    try {
      const systemPrompt = this.prompts.composePrompt(
        ['memory-base', 'memory-recall'],
        projectSystemMessage
      );

      // Convert structured filters to filterExpression if provided
      // The LLM can still extend/override this via its own filterExpression
      let baseFilterExpression = args.filterExpression;
      if (args.filters && Object.keys(args.filters).length > 0) {
        const convertedFilters = convertFiltersToExpression(args.filters);
        if (convertedFilters) {
          // Combine user's filterExpression with converted filters
          baseFilterExpression = baseFilterExpression
            ? `(${baseFilterExpression}) AND (${convertedFilters})`
            : convertedFilters;
        }
      }

      // Run query expansion and prefetch results if enabled
      const config = loadRefinementConfig();
      let prefetchedResults: SearchResult[] = [];
      if (config.queryExpansionEnabled) {
        const { mergedResults, diagnostics } = await this.runExpandedSearches(
          args.query,
          index,
          args.limit || 10,
          undefined, // Use default semantic weight
          baseFilterExpression,
          true // Enable reranking
        );

        // Add diagnostics from expanded searches to context
        context.searchDiagnostics.push(...diagnostics);

        // Track prefetched memory IDs to avoid duplicate access tracking
        for (const result of mergedResults) {
          context.trackedMemoryIds.add(result.id);
        }

        prefetchedResults = mergedResults;
      }

      const userMessage = JSON.stringify({
        query: args.query,
        index,
        limit: args.limit || 10,
        baseFilterExpression, // Pre-converted from structured filters
        responseMode: args.responseMode || 'answer',
        prefetchedResults, // Prefetched results from query expansion (empty if disabled)
      });

      const responseText = await this.toolRuntime.runToolLoop(systemPrompt, userMessage, context);

      // Parse the JSON response with enhanced error handling
      const result = safeJsonParse<any>(responseText, 'recall LLM response');

      // Ensure access tracking happens for final returned memories
      // This guarantees tracking even if LLM short-circuits or uses cached results
      const allMemoryIds = new Set<string>();

      // Guard against non-array payloads (LLM may return "none" or null)
      if (Array.isArray(result.memories)) {
        for (const m of result.memories) {
          const id = typeof m?.id === 'string' && m.id.trim();
          if (id) allMemoryIds.add(id);
        }
      } else if (result.memories) {
        console.error('recall returned non-array memories payload, skipping tracking');
      }

      if (Array.isArray(result.supportingMemories)) {
        for (const m of result.supportingMemories) {
          const id = typeof m?.id === 'string' && m.id.trim();
          if (id) allMemoryIds.add(id);
        }
      } else if (result.supportingMemories) {
        console.error('recall returned non-array supportingMemories payload, skipping tracking');
      }

      if (allMemoryIds.size > 0) {
        // Fire-and-forget fallback tracking for memories not already tracked during search_memories calls
        // This handles edge cases where LLM short-circuits, uses cached results, or returns memories
        // from get_memories instead of search_memories
        const untrackedIds = Array.from(allMemoryIds).filter(
          (id) => !context.trackedMemoryIds.has(id)
        );

        if (untrackedIds.length > 0) {
          const config = loadRefinementConfig();
          const idsToTrack = untrackedIds.slice(0, config.accessTrackingTopN);
          this.repo.updateAccessStats(index, idsToTrack).catch((err) => {
            console.error(`Failed to track recall result access for index ${index}:`, err);
          });
        }
      }

      // Determine search status from last diagnostic entry (if any)
      let searchStatus: SearchStatus | undefined;
      if (context.searchDiagnostics.length > 0) {
        const lastDiagnostic = context.searchDiagnostics[context.searchDiagnostics.length - 1];
        searchStatus = lastDiagnostic.status;
      }

      const memoriesCount = Array.isArray(result.memories) ? result.memories.length : 0;
      const supportingCount = Array.isArray(result.supportingMemories)
        ? result.supportingMemories.length
        : 0;

      endLog({
        memoriesCount,
        supportingCount,
        searchStatus,
        hasAnswer: Boolean(result.answer),
      });

      return {
        status: 'ok',
        index,
        answer: result.answer,
        memories: result.memories,
        supportingMemories: result.supportingMemories,
        searchStatus,
        searchDiagnostics:
          context.searchDiagnostics.length > 0 ? context.searchDiagnostics : undefined,
      };
    } catch (error) {
      console.error('Recall error:', error);

      endLog({ error: (error as Error).message });

      // Preserve diagnostics history from context (if any searches succeeded before failure)
      const diagnosticsHistory =
        context.searchDiagnostics.length > 0 ? context.searchDiagnostics : undefined;

      // If it's a MemorySearchError, extract diagnostics for better error reporting
      if (error instanceof MemorySearchError) {
        return {
          status: 'error',
          index,
          error: error.message,
          searchStatus: error.diagnostics.status,
          searchDiagnostics: diagnosticsHistory ?? [error.diagnostics],
        };
      }

      return {
        status: 'error',
        index,
        error: (error as Error).message,
        searchStatus: diagnosticsHistory
          ? diagnosticsHistory[diagnosticsHistory.length - 1]?.status
          : undefined,
        searchDiagnostics: diagnosticsHistory,
      };
    }
  }

  /**
   * Remove memories by evaluating a natural language deletion instruction.
   *
   * Uses an LLM agent to understand the deletion intent, search for matching memories,
   * and optionally execute deletions. Supports dry-run mode (default) for safe preview
   * before permanent execution.
   *
   * @param args - Forget tool arguments including deletion instruction and dry-run flag
   * @param index - Target memory index name
   * @param projectSystemMessage - Optional project-specific system message for deletion context
   * @returns Promise resolving to ForgetResult with deletion plan or execution results
   *
   * @remarks
   * Safety features:
   * - dryRun defaults to true (preview only)
   * - In dry-run mode, delete_memories tool is excluded from agent's available tools
   * - Returns deletion plan with reasons for review before execution
   * - Set dryRun: false only after reviewing the plan
   *
   * @example
   * ```typescript
   * const result = await agent.forget(
   *   {
   *     input: "Delete all memories about old pricing before Q2 2024",
   *     dryRun: true
   *   },
   *   "my-index"
   * );
   * console.log(`Preview: Would delete ${result.deletedCount || 0} memories`);
   * ```
   */
  async forget(
    args: ForgetToolArgs,
    index: string,
    projectSystemMessage?: string
  ): Promise<ForgetResult> {
    const isDryRun = args.dryRun !== false; // Default to true

    const endLog = debugLogOperation('forget', {
      index,
      dryRun: isDryRun,
      hasExplicitIds: Boolean(args.explicitMemoryIds && args.explicitMemoryIds.length > 0),
      hasFilters: Boolean(args.filters && Object.keys(args.filters).length > 0),
    });

    // Sanitize and validate explicitMemoryIds
    const explicitIds = Array.isArray(args.explicitMemoryIds)
      ? args.explicitMemoryIds
          .map((id) => (typeof id === 'string' ? id.trim() : ''))
          .filter((id): id is string => id.length > 0)
      : undefined;

    // Detect if metadata filters are provided (only count filters with actual values)
    const hasMetadataFilters = hasUsableMetadataFilters(args.filters);

    // Create request-specific context for thread safety
    // SAFETY: Set operation mode to prevent actual deletions in dry-run
    const context: RequestContext = {
      index,
      storedMemoryIds: [],
      operationMode: isDryRun ? 'forget-dryrun' : 'normal',
      searchIterationCount: 0,
      trackedMemoryIds: new Set(),
      searchDiagnostics: [],
      operationLog: [],
      forgetContext: {
        dryRun: isDryRun,
        explicitMemoryIds: explicitIds,
        hasMetadataFilters,
      },
    };

    try {
      const systemPrompt = this.prompts.composePrompt(
        ['memory-base', 'memory-forget'],
        projectSystemMessage
      );

      const userMessage = JSON.stringify({
        instruction: args.input,
        index,
        filters: args.filters,
        dryRun: isDryRun,
        explicitMemoryIds: explicitIds, // Pass sanitized explicit IDs if provided
      });

      const responseText = await this.toolRuntime.runToolLoop(systemPrompt, userMessage, context);

      // Parse the JSON response with enhanced error handling
      const result = safeJsonParse<any>(responseText, 'forget LLM response');

      endLog({
        deletedCount: result.deletedCount || 0,
        deletedIds: result.deletedIds?.length || 0,
        dryRun: isDryRun,
      });

      return {
        status: 'ok',
        index,
        deletedCount: result.deletedCount,
        deletedIds: result.deletedIds,
        plan: result.plan,
        lowConfidenceMatches: result.lowConfidenceMatches,
        skippedLowConfidence: result.skippedLowConfidence,
        notes: result.notes,
      };
    } catch (error) {
      console.error('Forget error:', error);

      endLog({ error: (error as Error).message });

      return {
        status: 'error',
        index,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Handle the reflection operation: synthesize beliefs from patterns and upsert them.
   * Unlike other refinement operations, reflection creates beliefs directly without
   * using an action plan.
   */
  private async handleReflectionOperation(
    index: string,
    scope?: any,
    projectSystemMessage?: string,
    isDryRun: boolean = true
  ): Promise<RefineMemoriesResult> {
    try {
      // Call reflection to synthesize beliefs from patterns
      const reflectionResult = await this.reflectOnMemories(index, scope, projectSystemMessage);

      if (reflectionResult.beliefs.length === 0) {
        return {
          status: 'ok',
          index,
          dryRun: isDryRun,
          summary: 'No pattern memories found to reflect upon',
          appliedActionsCount: 0,
          skippedActionsCount: 0,
          newMemoryIds: [],
        };
      }

      // Convert beliefs to MemoryToUpsert format for storage
      const beliefsToStore: MemoryToUpsert[] = reflectionResult.beliefs.map((belief: any) => ({
        text: belief.text,
        metadata: {
          index,
          memoryType: belief.memoryType || 'belief',
          kind: belief.kind || 'derived',
          stability: belief.stability || 'stable',
          importance: belief.importance || 'medium',
          topic: belief.topic,
          tags: belief.tags || ['belief', 'from_reflection', 'synthesized'],
          derivedFromIds: belief.derivedFromIds || [],
          relationships: belief.relationships || [],
        },
      }));

      // Only upsert beliefs if not in dry-run mode
      let createdIds: string[] = [];
      if (!isDryRun) {
        createdIds = await this.repo.upsertMemories(index, beliefsToStore);
      }

      return {
        status: 'ok',
        index,
        dryRun: isDryRun,
        summary: isDryRun
          ? `✨ [DRY RUN] Would synthesize ${beliefsToStore.length} belief/identity memories from ${reflectionResult.patternIds.length} patterns`
          : `✨ Synthesized ${createdIds.length} belief/identity memories from ${reflectionResult.patternIds.length} patterns`,
        appliedActionsCount: isDryRun ? 0 : createdIds.length,
        skippedActionsCount: 0,
        newMemoryIds: createdIds,
      };
    } catch (error) {
      console.error('Reflection operation error:', error);
      return {
        status: 'error',
        index,
        dryRun: isDryRun,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Consolidate, decay, or clean up memories using LLM-powered refinement.
   *
   * Two-phase process: LLM-powered planning (read-only, dry-run) followed by
   * deterministic execution. Supports consolidation (merge redundant memories),
   * decay (reprioritize), and cleanup (identify deletion candidates).
   *
   * @param args - Refine tool arguments including operation, scope, budget, and dry-run mode
   * @param index - Target memory index name
   * @param projectSystemMessage - Optional project-specific system message for refinement context
   * @returns Promise resolving to RefineMemoriesResult with actions plan or execution results
   *
   * @remarks
   * Safety features:
   * - Planning phase uses read-only tools (search_memories, get_memories, analyze_text)
   * - dryRun defaults to true for safe review before execution
   * - Budget parameter limits actions executed (prevents large batch operations)
   * - Validation gates all actions before execution
   * - System memories (source==='system') are never deleted
   *
   * @example
   * ```typescript
   * const result = await agent.refineMemories(
   *   {
   *     operation: "consolidation",
   *     scope: { topic: "pricing" },
   *     budget: 10,
   *     dryRun: true
   *   },
   *   "my-index"
   * );
   * console.log(`Plan: ${result.actions?.length} consolidation actions`);
   * ```
   */

  /**
   * Synthesize beliefs and identity statements from pattern memories via reflection.
   * This method filters patterns, calls the reflection prompt, and returns parsed beliefs.
   *
   * @param index - Target memory index
   * @param scope - Optional filters for patterns (topic, minImportance, seedIds)
   * @param projectSystemMessage - Optional project-specific context
   * @returns Array of belief/self memory objects synthesized from patterns
   */
  private async reflectOnMemories(
    index: string,
    scope?: { topic?: string; minImportance?: string; seedIds?: string[] },
    projectSystemMessage?: string
  ): Promise<{ beliefs: any[]; patternIds: string[] }> {
    try {
      // Search for pattern memories
      let filterExpression = '@metadata.memoryType = "pattern"';

      // Add optional topic filter
      if (scope?.topic) {
        filterExpression += ` AND @metadata.topic = "${scope.topic}"`;
      }

      // Add optional importance filter
      if (scope?.minImportance) {
        const importanceLevels: Record<string, number> = {
          low: 0,
          medium: 1,
          high: 2,
        };
        const minLevel = importanceLevels[scope.minImportance.toLowerCase()] ?? 0;
        if (minLevel === 1) {
          filterExpression +=
            ' AND (@metadata.importance = "medium" OR @metadata.importance = "high")';
        } else if (minLevel === 2) {
          filterExpression += ' AND @metadata.importance = "high"';
        }
      }

      // Search for pattern candidates
      const patternMemories = await this.repo.searchMemories(
        index,
        'pattern memories for reflection synthesis',
        {
          limit: 100,
          filterExpression,
          reranking: true,
        }
      );

      // Filter to include only seed IDs if specified
      let filteredPatterns = patternMemories;
      if (scope?.seedIds && scope.seedIds.length > 0) {
        const seedIdSet = new Set(scope.seedIds);
        filteredPatterns = patternMemories.filter((m: SearchResult) => seedIdSet.has(m.id));
      }

      const patternIds = filteredPatterns.map((m: SearchResult) => m.id);

      // If no patterns found, return empty result
      if (filteredPatterns.length === 0) {
        return {
          beliefs: [],
          patternIds: [],
        };
      }

      // Compose system prompt for reflection
      const systemPrompt = this.prompts.composePrompt(
        ['memory-base', 'memory-refine', 'memory-refine-reflection'],
        projectSystemMessage
      );

      // Call LLM with pattern memories as input
      const userMessage = JSON.stringify(filteredPatterns, null, 2);

      const responseText = await this.llm.simpleChat(systemPrompt, userMessage);

      // Parse reflection response with enhanced error handling
      const response = safeJsonParse<any>(responseText, 'reflection LLM response');

      // Validate response structure
      if (response.status !== 'ok') {
        throw new Error(`Reflection LLM returned error: ${response.error || 'Unknown error'}`);
      }

      if (!Array.isArray(response.beliefs)) {
        throw new Error('Reflection response must contain an array of beliefs');
      }

      // Validate each belief
      const beliefs = response.beliefs;
      const validationErrors: string[] = [];

      for (let i = 0; i < beliefs.length; i++) {
        const belief = beliefs[i];

        // Check required fields
        if (!belief.text) {
          validationErrors.push(`Belief ${i}: missing required field 'text'`);
        }
        if (belief.kind !== 'derived') {
          validationErrors.push(`Belief ${i}: 'kind' must be 'derived', got '${belief.kind}'`);
        }
        if (!['belief', 'self'].includes(belief.memoryType)) {
          validationErrors.push(
            `Belief ${i}: 'memoryType' must be 'belief' or 'self', got '${belief.memoryType}'`
          );
        }
        if (belief.stability !== 'stable') {
          validationErrors.push(
            `Belief ${i}: 'stability' must be 'stable', got '${belief.stability}'`
          );
        }
        if (!belief.topic) {
          validationErrors.push(`Belief ${i}: missing required field 'topic'`);
        }

        // Validate derivedFromIds
        if (Array.isArray(belief.derivedFromIds)) {
          for (const id of belief.derivedFromIds) {
            if (!patternIds.includes(id)) {
              validationErrors.push(
                `Belief ${i}: derivedFromIds references unknown pattern ID '${id}'`
              );
            }
          }
        } else {
          validationErrors.push(`Belief ${i}: 'derivedFromIds' must be an array`);
        }

        // Validate relationships
        if (Array.isArray(belief.relationships)) {
          for (let j = 0; j < belief.relationships.length; j++) {
            const rel = belief.relationships[j];
            if (!rel.targetId) {
              validationErrors.push(
                `Belief ${i}, relationship ${j}: missing required field 'targetId'`
              );
            } else if (!patternIds.includes(rel.targetId)) {
              validationErrors.push(
                `Belief ${i}, relationship ${j}: targetId '${rel.targetId}' not found in pattern memories`
              );
            }
            if (!rel.type) {
              validationErrors.push(
                `Belief ${i}, relationship ${j}: missing required field 'type'`
              );
            }
          }
        }
      }

      if (validationErrors.length > 0) {
        throw new Error(`Belief validation failed: ${validationErrors.join('; ')}`);
      }

      return {
        beliefs,
        patternIds,
      };
    } catch (error) {
      console.error('Reflection error:', error);
      throw error;
    }
  }

  /**
   * Validate consolidation pattern responses from the LLM
   * Ensures all derivedFromIds and relationship targetIds reference valid episodic memory IDs
   */
  private validateConsolidationPatterns(
    patterns: unknown,
    availableMemoryIds: Set<string>
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate structure
    if (!Array.isArray(patterns)) {
      errors.push('Pattern response must be an array');
      return { valid: false, errors };
    }

    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i] as any;

      // Check required fields
      if (!pattern.text) {
        errors.push(`Pattern ${i}: missing required field 'text'`);
      }
      if (pattern.kind !== 'derived') {
        errors.push(`Pattern ${i}: 'kind' must be 'derived', got '${pattern.kind}'`);
      }
      if (pattern.memoryType !== 'pattern') {
        errors.push(`Pattern ${i}: 'memoryType' must be 'pattern', got '${pattern.memoryType}'`);
      }
      if (!pattern.topic) {
        errors.push(`Pattern ${i}: missing required field 'topic'`);
      }

      // Validate derivedFromIds references
      if (Array.isArray(pattern.derivedFromIds)) {
        if (pattern.derivedFromIds.length < 3) {
          errors.push(
            `Pattern ${i}: must have at least 3 derivedFromIds, got ${pattern.derivedFromIds.length}`
          );
        }

        for (const id of pattern.derivedFromIds) {
          if (!availableMemoryIds.has(id)) {
            errors.push(`Pattern ${i}: derivedFromIds references unknown memory ID '${id}'`);
          }
        }
      } else {
        errors.push(`Pattern ${i}: 'derivedFromIds' must be an array`);
      }

      // Validate relationship targetIds
      if (Array.isArray(pattern.relationships)) {
        for (let j = 0; j < pattern.relationships.length; j++) {
          const rel = pattern.relationships[j] as any;
          if (!rel.targetId) {
            errors.push(`Pattern ${i}, relationship ${j}: missing required field 'targetId'`);
          } else if (!availableMemoryIds.has(rel.targetId)) {
            errors.push(
              `Pattern ${i}, relationship ${j}: targetId '${rel.targetId}' not found in available memories`
            );
          }
          if (!rel.type) {
            errors.push(`Pattern ${i}, relationship ${j}: missing required field 'type'`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  async refineMemories(
    args: RefineMemoriesToolArgs,
    index: string,
    projectSystemMessage?: string
  ): Promise<RefineMemoriesResult> {
    const isDryRun = args.dryRun !== false; // Default to true
    const config = loadRefinementConfig();
    const requestedBudget = Number.isFinite(args.budget)
      ? (args.budget as number)
      : config.defaultBudget;
    const budget = Math.max(0, Math.floor(requestedBudget));

    const endLog = debugLogOperation('refineMemories', {
      index,
      operation: args.operation || 'consolidation',
      budget,
      dryRun: isDryRun,
    });

    try {
      // Handle reflection operation separately - it doesn't use the action plan/execution model
      if (args.operation === 'reflection') {
        const reflectionResult = await this.handleReflectionOperation(
          index,
          args.scope,
          projectSystemMessage,
          isDryRun
        );

        endLog({
          operation: 'reflection',
          dryRun: reflectionResult.dryRun,
          status: reflectionResult.status,
          appliedActions: reflectionResult.appliedActionsCount ?? 0,
          skippedActions: reflectionResult.skippedActionsCount ?? 0,
          newMemoryIds: reflectionResult.newMemoryIds?.length || 0,
          error: reflectionResult.error,
        });

        return reflectionResult;
      }

      // Create request-specific context for thread safety
      // SAFETY: Always use refinement-planning mode to prevent mutations during plan generation
      const context: RequestContext = {
        index,
        storedMemoryIds: [],
        operationMode: 'refinement-planning',
        searchIterationCount: 0,
        trackedMemoryIds: new Set(),
        searchDiagnostics: [],
        operationLog: [],
      };

      // Conditionally include consolidation-specific prompt for pattern extraction
      const promptNames =
        args.operation === 'consolidation'
          ? ['memory-base', 'memory-refine', 'memory-refine-consolidation']
          : ['memory-base', 'memory-refine'];

      const systemPrompt = this.prompts.composePrompt(promptNames, projectSystemMessage);

      const userMessage = JSON.stringify({
        operation: args.operation || 'consolidation',
        scope: args.scope,
        budget,
        index,
        dryRun: isDryRun,
      });

      const responseText = await this.toolRuntime.runToolLoop(systemPrompt, userMessage, context);

      // Parse the JSON response with enhanced error handling
      const result = safeJsonParse<any>(responseText, 'refine memories LLM response');
      const plannedActions: RefinementAction[] = Array.isArray(result.actions)
        ? result.actions
        : [];

      // For consolidation mode, validate pattern structure and ID references
      const validationErrors: string[] = [];
      if (args.operation === 'consolidation' && plannedActions.length > 0) {
        // Extract pattern CREATE actions and normalize their structure
        // The LLM may return consolidation fields at top-level or inside metadata
        const patterns = plannedActions
          .filter((a) => a.type === 'CREATE')
          .map((a) => {
            const newMemory = (a as any).newMemory;
            // Normalize: gather all consolidation fields into a single shape for validation
            return {
              text: newMemory.text,
              kind: newMemory.metadata?.kind ?? (newMemory as any).kind,
              memoryType: newMemory.metadata?.memoryType ?? (newMemory as any).memoryType,
              importance: newMemory.metadata?.importance ?? (newMemory as any).importance,
              topic: newMemory.metadata?.topic ?? (newMemory as any).topic,
              derivedFromIds:
                newMemory.metadata?.derivedFromIds ?? (newMemory as any).derivedFromIds,
              relationships: newMemory.metadata?.relationships ?? (newMemory as any).relationships,
            };
          })
          .filter((m) => m.memoryType === 'pattern' || m.kind === 'derived');

        if (patterns.length > 0) {
          // Build set of available memory IDs from actual repository contents
          // The consolidation prompt searches episodic memories and outputs CREATE actions
          // referencing those episodic IDs. We must validate against actual IDs from the repository,
          // not just IDs that appear in the pattern output (which could reference non-existent memories).
          const availableMemoryIds = new Set<string>();
          let consolidationIdsUnavailable = false;

          // Fetch all episodic memories to get actual available IDs
          try {
            const allMemories = await this.repo.searchMemories(
              index,
              '*', // Match all
              { limit: 10000 } // High limit to get all episodics for validation
            );
            // Add all retrieved memory IDs to the available set
            allMemories.forEach((mem) => availableMemoryIds.add(mem.id));
          } catch (err) {
            // If search fails, mark consolidation as unavailable but continue with other validations
            console.error('Failed to fetch memories for consolidation validation:', err);
            const errorMessage = err instanceof Error ? err.message : String(err);
            validationErrors.push(
              `Consolidation skipped: unable to load memory IDs - ${errorMessage}`
            );
            consolidationIdsUnavailable = true;
          }

          // Only validate patterns if we successfully fetched memory IDs
          if (!consolidationIdsUnavailable) {
            const patternValidation = this.validateConsolidationPatterns(
              patterns as any,
              availableMemoryIds
            );
            if (!patternValidation.valid) {
              validationErrors.push(...patternValidation.errors);
              // Mark consolidation as unavailable if pattern validation fails
              consolidationIdsUnavailable = true;
            }
          }

          // If consolidation validation failed, filter out pattern CREATE actions from the plan
          if (consolidationIdsUnavailable) {
            // Remove CREATE actions that are consolidation patterns
            const filteredActions = plannedActions.filter((action) => {
              if (action.type !== 'CREATE') return true;
              const newMemory = (action as any).newMemory;
              const memoryType = newMemory.metadata?.memoryType ?? (newMemory as any).memoryType;
              const kind = newMemory.metadata?.kind ?? (newMemory as any).kind;
              // Filter out pattern/derived memories from consolidation
              return !(memoryType === 'pattern' || kind === 'derived');
            });
            // Update plannedActions to exclude consolidation patterns
            plannedActions.splice(0, plannedActions.length, ...filteredActions);
          }
        }
      }

      // Enforce budget by slicing actions
      const budgetedActions = plannedActions.slice(0, budget);
      const budgetReached = plannedActions.length > budget;

      // Validate all actions before returning (dry-run) or executing
      const validationContext: ValidationContext = {
        indexName: index,
        repository: this.repo,
        config,
      };
      const validatedActions: RefinementAction[] = [];
      for (const action of budgetedActions) {
        const validation = await validateAction(action, validationContext);
        if (!validation.valid) {
          validationErrors.push(`Invalid ${action.type}: ${validation.errors.join(', ')}`);
          continue;
        }
        validatedActions.push(action);
      }

      const skippedCount = budgetedActions.length - validatedActions.length;

      // If dry-run, return the plan without executing
      if (isDryRun) {
        endLog({
          dryRun: true,
          plannedActions: validatedActions.length,
          skippedActions: skippedCount,
          budgetReached,
        });

        return {
          status: budgetReached ? 'budget_reached' : 'ok',
          index,
          dryRun: true,
          summary: result.summary || `Planned ${budgetedActions.length} refinement actions.`,
          actions: validatedActions,
          appliedActionsCount: 0,
          skippedActionsCount: skippedCount,
          newMemoryIds: [],
          error: validationErrors.length > 0 ? validationErrors.join('; ') : undefined,
        };
      }

      // Execute the plan
      const executionResult = await this.executeRefinementPlan(validatedActions, index);

      // Combine validation errors with execution errors
      const allErrors = [...validationErrors];
      if (executionResult.errors.length > 0) {
        allErrors.push(...executionResult.errors);
      }

      endLog({
        dryRun: false,
        appliedActions: executionResult.appliedCount,
        skippedActions: skippedCount + executionResult.skippedCount,
        newMemoryIds: executionResult.newMemoryIds.length,
        hasErrors: executionResult.hasErrors,
      });

      return {
        status: executionResult.hasErrors ? 'error' : budgetReached ? 'budget_reached' : 'ok',
        index,
        dryRun: false,
        summary: executionResult.summary,
        actions: validatedActions,
        appliedActionsCount: executionResult.appliedCount,
        skippedActionsCount: skippedCount + executionResult.skippedCount,
        newMemoryIds: executionResult.newMemoryIds,
        error: allErrors.length > 0 ? allErrors.join('; ') : undefined,
      };
    } catch (error) {
      console.error('Refine error:', error);

      endLog({ error: (error as Error).message });

      return {
        status: 'error',
        index,
        dryRun: isDryRun,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Execute a validated refinement plan deterministically
   * No LLM calls - just repository operations
   */
  private async executeRefinementPlan(
    actions: RefinementAction[],
    index: string
  ): Promise<{
    appliedCount: number;
    skippedCount: number;
    newMemoryIds: string[];
    summary: string;
    errors: string[];
    hasErrors: boolean;
  }> {
    const config = loadRefinementConfig();
    const validationContext: ValidationContext = {
      indexName: index,
      repository: this.repo,
      config,
    };

    let appliedCount = 0;
    let skippedCount = 0;
    const newMemoryIds: string[] = [];
    const errors: string[] = [];

    for (const action of actions) {
      try {
        // Validate the action
        const validation = await validateAction(action, validationContext);
        if (!validation.valid) {
          console.error(`Skipping invalid action:`, validation.errors);
          errors.push(`Invalid ${action.type}: ${validation.errors.join(', ')}`);
          skippedCount++;
          continue;
        }

        // Execute based on action type
        switch (action.type) {
          case 'UPDATE':
            await this.executeUpdateAction(action, index);
            appliedCount++;
            break;

          case 'MERGE':
            await this.executeMergeAction(action, index);
            appliedCount++;
            break;

          case 'CREATE': {
            const createdIds = await this.executeCreateAction(action, index);
            newMemoryIds.push(...createdIds);
            appliedCount++;
            break;
          }

          case 'DELETE':
            await this.executeDeleteAction(action, index);
            appliedCount++;
            break;

          default:
            errors.push(`Unknown action type: ${(action as any).type}`);
            skippedCount++;
        }
      } catch (error) {
        console.error(`Error executing ${action.type} action:`, error);
        errors.push(`${action.type} failed: ${(error as Error).message}`);
        skippedCount++;
      }
    }

    const summary = `Applied ${appliedCount} actions, skipped ${skippedCount}${newMemoryIds.length > 0 ? `, created ${newMemoryIds.length} new memories` : ''}.`;

    return {
      appliedCount,
      skippedCount,
      newMemoryIds,
      summary,
      errors,
      hasErrors: errors.length > 0,
    };
  }

  /**
   * Execute an UPDATE action: modify existing memory metadata or text
   */
  private async executeUpdateAction(action: UpdateRefinementAction, index: string): Promise<void> {
    // Fetch the existing memory
    const existingMemory = await this.repo.getMemory(index, action.id);
    if (!existingMemory) {
      throw new Error(`Memory ${action.id} not found`);
    }

    // Prepare the updated memory
    const updatedText = action.textUpdate ?? existingMemory.content.text;
    const updatedMetadata = {
      ...existingMemory.metadata,
      ...action.metadataUpdates,
    };

    // Upsert with the existing ID to update
    await this.repo.upsertMemories(index, [
      {
        id: action.id,
        text: updatedText,
        metadata: updatedMetadata,
      },
    ]);
  }

  /**
   * Execute a MERGE action: consolidate multiple memories into one
   */
  private async executeMergeAction(action: MergeRefinementAction, index: string): Promise<void> {
    // Fetch the target memory
    const targetMemory = await this.repo.getMemory(index, action.targetId);
    if (!targetMemory) {
      throw new Error(`Target memory ${action.targetId} not found`);
    }

    // Fetch source memories
    const sourceMemories = await this.repo.getMemories(index, action.mergeSourceIds);

    // Prepare merged text and metadata
    const mergedText = action.mergedText ?? targetMemory.content.text;

    // Sanitize merged metadata: remove forbidden fields
    const sanitizedMergedMetadata = action.mergedMetadata ? { ...action.mergedMetadata } : {};
    delete sanitizedMergedMetadata.index;
    delete sanitizedMergedMetadata.id;

    const mergedMetadata = {
      ...targetMemory.metadata,
      ...sanitizedMergedMetadata,
    };

    // Set derivedFromIds to track the merge
    mergedMetadata.derivedFromIds = [
      ...(mergedMetadata.derivedFromIds || []),
      ...action.mergeSourceIds,
    ];

    // Update target memory
    await this.repo.upsertMemories(index, [
      {
        id: action.targetId,
        text: mergedText,
        metadata: mergedMetadata,
      },
    ]);

    // Mark source memories as superseded and delete them
    const sourceIds = action.mergeSourceIds.filter((id) => id !== action.targetId);
    if (sourceIds.length > 0) {
      // SECURITY: Filter out system memories (never delete sys_* IDs or memories with source === 'system')
      const safeIds = sourceIds.filter((id) => {
        const memory = sourceMemories.find((m) => m.id === id);
        return !id.startsWith('sys_') && memory?.metadata?.source !== 'system';
      });

      const skippedIds = sourceIds.filter((id) => {
        const memory = sourceMemories.find((m) => m.id === id);
        return id.startsWith('sys_') || memory?.metadata?.source === 'system';
      });

      if (safeIds.length > 0) {
        // First, update source memories with supersededById
        const updatedSources = sourceMemories
          .filter((mem) => safeIds.includes(mem.id))
          .map((mem) => ({
            id: mem.id,
            text: mem.content.text,
            metadata: {
              ...mem.metadata,
              supersededById: action.targetId,
            },
          }));

        if (updatedSources.length > 0) {
          await this.repo.upsertMemories(index, updatedSources);
        }

        // Then delete them
        await this.repo.deleteMemories(index, safeIds);
      }

      if (skippedIds.length > 0) {
        console.warn(`MERGE action skipped deletion of system memories: ${skippedIds.join(', ')}`);
      }
    }
  }

  /**
   * Execute a CREATE action: generate new derived or summary memories
   * For consolidation patterns, also marks source episodic memories as superseded
   */
  private async executeCreateAction(
    action: CreateRefinementAction,
    index: string
  ): Promise<string[]> {
    // The LLM may return consolidation metadata either within the metadata object
    // or as top-level fields. Merge both sources to preserve all fields.
    const asAny = action.newMemory as any;
    const metadataBase = action.newMemory.metadata ?? {};

    const mergedMetadata: any = {
      ...metadataBase,
    };

    // Consolidation fields: merge from top-level or metadata
    // Priority: use metadata version if present, otherwise top-level
    const consolidationFields = [
      'kind',
      'memoryType',
      'importance',
      'topic',
      'tags',
      'derivedFromIds',
      'relationships',
    ];

    for (const field of consolidationFields) {
      // If not already in metadata and exists at top level, copy it
      if (!(field in metadataBase) && field in asAny) {
        mergedMetadata[field] = asAny[field];
      }
    }

    // Sanitize metadata: remove forbidden fields that shouldn't be stored
    delete mergedMetadata.index;
    delete mergedMetadata.id;

    const sanitizedMemory: any = {
      text: action.newMemory.text,
      metadata: mergedMetadata,
    };

    // Preserve ID if provided
    if (action.newMemory.id) {
      sanitizedMemory.id = action.newMemory.id;
    }

    const ids = await this.repo.upsertMemories(index, [sanitizedMemory]);

    // For consolidation patterns (kind === 'derived' and memoryType === 'pattern'),
    // mark the source episodic memories as superseded by this new pattern
    const createdId = ids[0];
    if (
      createdId &&
      mergedMetadata.kind === 'derived' &&
      mergedMetadata.memoryType === 'pattern' &&
      Array.isArray(mergedMetadata.derivedFromIds)
    ) {
      const episodicIds = mergedMetadata.derivedFromIds as string[];

      try {
        // Fetch each episodic memory and mark as superseded
        const episodicMemories = await this.repo.getMemories(index, episodicIds);
        const supersessionUpdates = episodicMemories.map((episodic) => ({
          id: episodic.id,
          text: episodic.content.text,
          metadata: {
            ...episodic.metadata,
            supersededById: createdId,
          },
        }));

        if (supersessionUpdates.length > 0) {
          await this.repo.upsertMemories(index, supersessionUpdates);
        }
      } catch (error) {
        console.warn(
          `Failed to mark episodic memories as superseded during consolidation: ${(error as Error).message}`
        );
        // Continue despite error - pattern was created successfully
      }
    }

    return ids;
  }

  /**
   * Execute a DELETE action: remove memories from the index
   */
  private async executeDeleteAction(action: DeleteRefinementAction, index: string): Promise<void> {
    // Filter out system IDs (never delete sys_* IDs)
    const safeIds = action.deleteIds.filter((id) => !id.startsWith('sys_'));
    if (safeIds.length === 0) {
      return;
    }

    await this.repo.deleteMemories(index, safeIds);
  }

  /**
   * Create and register a memory index backed by Postgres.
   *
   * Ensures the index row exists inside the database and returns basic metadata.
   */
  async createIndex(args: CreateIndexToolArgs): Promise<CreateIndexResult> {
    try {
      await this.repo.ensureIndex(args.name, args.description);

      const notes = args.description
        ? `Index "${args.name}" ready. ${args.description}`
        : `Index "${args.name}" ready.`;

      return {
        status: 'ok',
        name: args.name,
        description: args.description,
        notes,
      };
    } catch (error) {
      console.error('Create index error:', error);
      return {
        status: 'error',
        name: args.name,
        error: (error as Error).message,
      };
    }
  }

  /** List all indexes stored in Postgres with per-index document counts. */
  async listIndexes(): Promise<ListIndexesResult> {
    try {
      const [dbInfo, summaries] = await Promise.all([
        this.repo.getDatabaseInfo(),
        this.repo.listIndexes(),
      ]);

      const indexList = summaries.map((summary) => ({
        name: summary.name,
        documentCount: summary.documentCount,
        pendingDocumentCount: summary.pendingDocumentCount ?? 0,
        description: summary.description,
        project: this.projectId,
      }));

      return {
        status: 'ok',
        documentCount: dbInfo.documentCount,
        pendingDocumentCount: dbInfo.pendingDocumentCount,
        diskSize: dbInfo.diskSize,
        indexes: indexList,
      };
    } catch (error) {
      console.error('List indexes error:', error);
      return {
        status: 'error',
        error: (error as Error).message,
      };
    }
  }

  /**
   * Perform direct, LLM-free semantic search over stored memories.
   *
   * Bypasses the LLM agent's tool-calling loop and returns raw repository search results
   * with metadata, scores, and diagnostics. Useful for debugging, analytics, and
   * advanced orchestration scenarios where structured data access is needed without
   * OpenAI API costs.
   *
   * @param args - Scan tool arguments including query, filters, limit, and search options
   * @param index - Target memory index name
   * @returns Promise resolving to ScanMemoriesResult with raw search results and diagnostics
   *
   * @remarks
   * This tool:
   * - Calls MemoryRepository.searchMemories directly (no LLM involvement)
   * - Returns raw SearchResult[] with scores, metadata, and SearchDiagnostics
   * - Triggers access tracking (updates accessCount, currentPriority, lastAccessedAt)
   * - Reuses existing filter conversion and retry logic
   * - Positions as an advanced/low-level tool (not a replacement for recall)
   *
   * @example
   * ```typescript
   * const result = await agent.scanMemories(
   *   {
   *     query: "pricing strategy",
   *     filters: { topic: "pricing" },
   *     limit: 20,
   *     reranking: true
   *   },
   *   "my-index"
   * );
   * console.log(`Found ${result.results?.length} memories with scores`);
   * console.log(result.diagnostics); // Search timing, retry counts, pending docs
   * ```
   */
  async scanMemories(args: ScanMemoriesToolArgs, index: string): Promise<ScanMemoriesResult> {
    const diagnostics: SearchDiagnostics[] = [];

    try {
      // Convert structured filters to filterExpression if provided
      let finalFilterExpression = args.filterExpression;
      if (args.filters && Object.keys(args.filters).length > 0) {
        const convertedFilters = convertFiltersToExpression(args.filters);
        if (convertedFilters) {
          // Combine user's filterExpression with converted filters
          finalFilterExpression = finalFilterExpression
            ? `(${finalFilterExpression}) AND (${convertedFilters})`
            : convertedFilters;
        }
      }

      // Call MemoryRepository.searchMemories directly with diagnostics listener
      const results = await this.repo.searchMemories(index, args.query, {
        limit: args.limit ? Math.min(args.limit, 1000) : 10, // Cap at 1000 for scan operations
        semanticWeight: args.semanticWeight,
        filterExpression: finalFilterExpression,
        includeMetadata: args.includeMetadata !== false, // Default to true
        reranking: args.reranking, // Defaults to true in repository
        diagnosticsListener: (diag) => {
          // Capture diagnostics for observability
          diagnostics.push(diag);
        },
      });

      // Determine search status from last diagnostic entry (if any)
      let searchStatus: SearchStatus | undefined;
      if (diagnostics.length > 0) {
        const lastDiagnostic = diagnostics[diagnostics.length - 1];
        searchStatus = lastDiagnostic.status;
      }

      return {
        status: 'ok',
        index,
        results,
        searchStatus,
        diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      };
    } catch (error) {
      console.error('Scan memories error:', error);

      // If it's a MemorySearchError, extract diagnostics for better error reporting
      if (error instanceof MemorySearchError) {
        return {
          status: 'error',
          index,
          error: error.message,
          searchStatus: error.diagnostics.status,
          diagnostics: diagnostics.length > 0 ? diagnostics : [error.diagnostics],
        };
      }

      return {
        status: 'error',
        index,
        error: (error as Error).message,
        searchStatus:
          diagnostics.length > 0 ? diagnostics[diagnostics.length - 1]?.status : undefined,
        diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      };
    }
  }
}
