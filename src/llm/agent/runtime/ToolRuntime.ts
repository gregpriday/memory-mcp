import { LLMClient, ChatMessage, ToolDef } from '../../LLMClient.js';
import { PromptManager } from '../../PromptManager.js';
import { IMemoryRepository } from '../../../memory/IMemoryRepository.js';
import { ProjectFileLoader } from '../../../memory/ProjectFileLoader.js';
import { MemoryToUpsert, MemoryType } from '../../../memory/types.js';
import { RequestContext, OperationLogEntry, VALID_MEMORY_TYPES } from '../shared/index.js';
import { safeJsonParse } from '../shared/utils.js';
import { debugLog } from '../../../utils/logger.js';
import { TimestampValidator } from '../../../validators/TimestampValidator.js';

interface ToolRuntimeConfig {
  maxToolIterations?: number;
  maxSearchIterations?: number;
}

export interface ToolLoopLlmOptions {
  model?: string;
  maxTokens?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  verbosity?: 'low' | 'medium' | 'high';
}

/**
 * ToolRuntime - Internal Tool System for Memory Agent
 *
 * Encapsulates the LLM tool-calling runtime that powers the memory agent.
 * Provides a set of internal tools that the LLM can call to interact with
 * memory storage, files, and analysis capabilities.
 *
 * **Responsibilities:**
 * - **Tool Definition**: Defines available tools with JSON Schema parameters
 * - **Tool Execution**: Routes tool calls to appropriate backend implementations
 * - **Mode-Based Access Control**: Restricts tools based on operation mode
 * - **Loop Orchestration**: Manages multi-turn tool-calling conversations
 *
 * **Available Tools:**
 * - `search_memories`: Semantic search across memory indexes
 * - `get_memories`: Fetch specific memories by ID (for relationship traversal)
 * - `upsert_memories`: Store or update memories
 * - `delete_memories`: Remove memories (only in normal mode)
 * - `read_file`: Read project files with sandboxing
 * - `analyze_text`: Extract metadata and facts using GPT-4-mini
 *
 * **Operation Modes:**
 * - **normal**: All tools available (full read/write access)
 * - **forget-dryrun**: Read-only tools only (preview before deletion)
 * - **refinement-planning**: Read-only tools only (analyze without mutation)
 *
 * @remarks
 * The runtime enforces safety limits:
 * - Maximum tool iterations (default: 10) to prevent infinite loops
 * - Maximum search iterations (default: 3) to encourage result synthesis
 * - Forget confidence thresholds to prevent accidental bulk deletion
 *
 * Tool schemas are compatible with OpenAI's function calling API and Anthropic's tool use.
 *
 * @example
 * ```typescript
 * const runtime = new ToolRuntime(llm, prompts, repo, fileLoader, {
 *   maxToolIterations: 10,
 *   maxSearchIterations: 3
 * });
 *
 * // Get tools for specific operation mode
 * const tools = runtime.getInternalTools('normal');
 * // Returns all 6 tools including delete_memories
 *
 * const readOnlyTools = runtime.getInternalTools('refinement-planning');
 * // Returns only 4 read-only tools (search, get, read_file, analyze)
 *
 * // Execute a tool call
 * const result = await runtime.executeInternalTool('search_memories', {
 *   index: 'chat-history',
 *   query: 'user preferences',
 *   limit: 5
 * }, context);
 * ```
 *
 * @public
 */
export class ToolRuntime {
  private maxToolIterations: number;
  private maxSearchIterations: number;
  private timestampValidator: TimestampValidator;

  constructor(
    private llm: LLMClient,
    private prompts: PromptManager,
    private repo: IMemoryRepository,
    private fileLoader: ProjectFileLoader,
    config: ToolRuntimeConfig = {}
  ) {
    this.maxToolIterations = config.maxToolIterations ?? 10;
    this.maxSearchIterations = config.maxSearchIterations ?? 3;
    this.timestampValidator = new TimestampValidator();
  }

  /**
   * Get internal tools available to the LLM for a specific operation mode.
   *
   * Returns a filtered set of tool definitions based on the operation mode,
   * implementing access control to prevent mutations during read-only operations.
   *
   * @param operationMode - The current operation mode determining tool availability
   *   - `'normal'`: Full access to all 6 tools (including delete_memories)
   *   - `'forget-dryrun'`: Read-only preview mode (search, get, read, analyze only)
   *   - `'refinement-planning'`: Analysis mode (search, get, read, analyze only)
   *
   * @returns Array of tool definitions with JSON Schema parameters
   *
   * @remarks
   * **Tool Filtering by Mode:**
   * - Normal mode: All tools (search, get, upsert, delete, read_file, analyze)
   * - Dry-run/Planning modes: Read-only tools only (search, get, read_file, analyze)
   *
   * **Tool Purposes:**
   * - `search_memories`: Primary retrieval method using semantic similarity
   * - `get_memories`: Follow relationships between memories via IDs
   * - `upsert_memories`: Store new memories or update existing ones
   * - `delete_memories`: Remove memories (excluded in safe modes)
   * - `read_file`: Access project files with path sandboxing
   * - `analyze_text`: Fast metadata extraction using GPT-4-mini
   *
   * Tool definitions conform to JSON Schema and are compatible with both
   * OpenAI function calling and Anthropic tool use APIs.
   *
   * @example
   * ```typescript
   * // Normal operation - all tools available
   * const allTools = runtime.getInternalTools('normal');
   * console.log(allTools.map(t => t.name));
   * // Output: ['search_memories', 'get_memories', 'delete_memories',
   * //          'upsert_memories', 'read_file', 'analyze_text']
   *
   * // Refinement planning - read-only tools
   * const readOnly = runtime.getInternalTools('refinement-planning');
   * console.log(readOnly.map(t => t.name));
   * // Output: ['search_memories', 'get_memories', 'read_file', 'analyze_text']
   * ```
   */
  getInternalTools(operationMode: 'normal' | 'forget-dryrun' | 'refinement-planning'): ToolDef[] {
    const tools: ToolDef[] = [
      {
        name: 'search_memories',
        description:
          'Search for memories using semantic similarity matching. Combines embedding-based semantic search with optional keyword matching and metadata filtering. Returns relevance-ranked results. Use this as the primary method for finding relevant memories based on meaning, not exact keywords.',
        parameters: {
          type: 'object',
          properties: {
            index: {
              type: 'string',
              description: 'The index name to search in',
            },
            query: {
              type: 'string',
              description: 'The search query',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 10)',
            },
            semanticWeight: {
              type: 'number',
              description: 'Weight for semantic vs keyword search (0-1, default: 0.7)',
            },
            filterExpression: {
              type: 'string',
              description: 'Optional raw filter expression understood by the repository',
            },
            reranking: {
              type: 'boolean',
              description: 'Enable AI-powered reranking for improved relevance (default: true)',
            },
          },
          required: ['index', 'query'],
        },
      },
      {
        name: 'get_memories',
        description:
          'Fetch specific memories by their unique IDs. Use this to follow explicit relationships between memories (e.g., relatedMemories field) or to inspect memories discovered through search. Returns full memory records including all metadata and content. More efficient than search when you already know the exact IDs.',
        parameters: {
          type: 'object',
          properties: {
            index: {
              type: 'string',
              description: 'The index name',
            },
            ids: {
              type: 'array',
              description: 'Array of memory IDs to fetch',
              items: { type: 'string' },
            },
          },
          required: ['index', 'ids'],
        },
      },
      {
        name: 'upsert_memories',
        description:
          'Store new memories or update existing ones in the index. Automatically generates embeddings for semantic search. Use for creating memories from user input, file content, or analysis results. Supports batch operations and default metadata for efficient bulk storage. Returns memory IDs for later reference.',
        parameters: {
          type: 'object',
          properties: {
            index: {
              type: 'string',
              description: 'The index name to store memories in',
            },
            memories: {
              type: 'array',
              description: 'Array of memories to store',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  metadata: { type: 'object' },
                  timestamp: {
                    type: 'string',
                    description:
                      'ISO 8601 timestamp for when this memory was created (optional, defaults to now). Use for backdating historical content. Format: "2025-02-04T10:00:00Z" or "2025-02-04" for date only.',
                  },
                },
                required: ['text'],
              },
            },
            defaultMetadata: {
              type: 'object',
              description: 'Optional default metadata to merge with each memory',
            },
          },
          required: ['index', 'memories'],
        },
      },
      {
        name: 'read_file',
        description:
          'Read text files from the project directory. Only relative paths within the project are allowed (sandboxed). Use this to ingest file content for memorization, verify file-based memories, or extract information from project files. Supports text formats including code, markdown, JSON, etc.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative path to the file',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'analyze_text',
        description:
          'Analyze text using GPT-4-mini to extract key facts, suggested metadata (topics, tags, importance, memory type), and structural information. Use this to prepare text for memorization by identifying discrete facts and appropriate metadata. Fast and cost-effective for bulk analysis. Returns structured analysis results including suggested memory segmentation.',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'The text content to analyze',
            },
            contextMetadata: {
              type: 'object',
              description: 'Optional context metadata (source, file path, etc.)',
            },
          },
          required: ['text'],
        },
      },
    ];

    // In refinement-planning or forget-dryrun mode, only expose read-only tools
    if (operationMode === 'refinement-planning' || operationMode === 'forget-dryrun') {
      // Filter to only include: search_memories, get_memories, read_file, analyze_text
      return tools.filter((tool) =>
        ['search_memories', 'get_memories', 'read_file', 'analyze_text'].includes(tool.name)
      );
    }

    // For normal mode, include delete_memories
    // (upsert_memories was already included in the base tools array above)
    tools.splice(2, 0, {
      name: 'delete_memories',
      description:
        'Permanently delete memories by their IDs. Use with caution - this operation cannot be undone. Only available in normal operation mode (excluded from dry-run and planning modes). Prefer forgetting low-priority or outdated memories rather than bulk deletion.',
      parameters: {
        type: 'object',
        properties: {
          index: {
            type: 'string',
            description: 'The index name',
          },
          ids: {
            type: 'array',
            description: 'Array of memory IDs to delete',
            items: { type: 'string' },
          },
        },
        required: ['index', 'ids'],
      },
    });

    return tools;
  }

  /**
   * Determine the confidence threshold for forget operations based on context
   * - 0.0 for explicit memory IDs (bypass confidence check)
   * - 0.4 for dry-run mode OR execution with metadata filters (more lenient)
   * - 0.6 for execution without filters (conservative)
   */
  private getForgetConfidenceThreshold(
    forgetContext: RequestContext['forgetContext'],
    memoryId: string
  ): number {
    if (!forgetContext) {
      return 0; // Not a forget operation, no filtering
    }

    // If memory ID is explicitly listed, bypass confidence check
    const explicitIdSet = new Set(forgetContext.explicitMemoryIds ?? []);
    if (explicitIdSet.has(memoryId)) {
      return 0;
    }

    // Dry-run mode: use lower threshold for broader preview
    if (forgetContext.dryRun) {
      return 0.4;
    }

    // Execution mode with metadata filters: use lower threshold
    if (forgetContext.hasMetadataFilters) {
      return 0.4;
    }

    // Execution mode without filters: use conservative threshold
    return 0.6;
  }

  /**
   * Execute an internal tool call
   */
  async executeInternalTool(
    toolName: string,
    args: Record<string, unknown>,
    context: RequestContext
  ): Promise<string> {
    // Log tool execution with metadata (avoid logging full payloads to prevent data leaks)
    debugLog('operation', `Tool call: ${toolName}`, {
      argKeys: Object.keys(args),
      index: context.index,
      mode: context.operationMode,
    });

    try {
      switch (toolName) {
        case 'search_memories': {
          // Check search iteration limit (aligned with prompt guidance)
          if (context.searchIterationCount >= this.maxSearchIterations) {
            return JSON.stringify({
              error: 'max_search_iterations_reached',
              details: `Maximum ${this.maxSearchIterations} search iterations exceeded. Provide final answer with current results.`,
            });
          }

          const { query, limit, semanticWeight, filterExpression, reranking } = args as {
            index?: string;
            query: string;
            limit?: number;
            semanticWeight?: number;
            filterExpression?: string;
            reranking?: boolean;
          };

          // SECURITY: Use context index, ignore LLM-provided index
          const results = await this.repo.searchMemories(context.index, query, {
            limit: limit ? Math.min(limit, 100) : 10, // Cap at 100
            semanticWeight,
            filterExpression,
            includeMetadata: true,
            reranking, // Defaults to true in repository
            diagnosticsListener: (diag) => {
              // Capture diagnostics for observability
              context.searchDiagnostics.push(diag);
            },
          });

          // Apply tiered confidence filtering for forget operations
          const forgetContext = context.forgetContext;
          let filteredResults = results;
          if (forgetContext) {
            filteredResults = results.filter((result) => {
              const minScore = this.getForgetConfidenceThreshold(forgetContext, result.id);
              // Handle missing or invalid scores:
              // - Dry-run mode: treat as meeting minimum threshold to avoid filtering preview candidates
              // - Execution mode: treat as 0 to filter them out (require valid confidence for deletion)
              const hasScore = typeof result.score === 'number' && Number.isFinite(result.score);
              const score = hasScore
                ? (result.score as number)
                : forgetContext.dryRun
                  ? minScore
                  : 0;
              return score >= minScore;
            });
          }

          // Track which IDs were accessed via search to avoid double-tracking in fallback
          for (const result of results) {
            context.trackedMemoryIds.add(result.id);
          }

          // Only increment counter after successful search
          context.searchIterationCount++;

          return JSON.stringify(filteredResults, null, 2);
        }

        case 'get_memories': {
          const { ids } = args as {
            index?: string;
            ids: string[];
          };

          if (!Array.isArray(ids) || ids.length === 0) {
            return JSON.stringify({
              error: 'invalid_ids',
              details: 'ids must be a non-empty array',
            });
          }

          const records = await this.repo.getMemories(context.index, ids);
          return JSON.stringify(records, null, 2);
        }

        case 'upsert_memories': {
          // SECURITY: Prevent mutations in read-only modes
          if (context.operationMode === 'refinement-planning') {
            return JSON.stringify({
              error: 'upsert_memories not allowed in refinement-planning mode',
            });
          }

          const { memories, defaultMetadata } = args as {
            index?: string;
            memories: MemoryToUpsert[];
            defaultMetadata?: Record<string, unknown>;
          };

          // Validate memories array
          if (!Array.isArray(memories)) {
            return JSON.stringify({
              error: 'invalid_memories',
              details: 'memories must be an array',
            });
          }

          // Cap at 50 memories per call
          const cappedMemories = memories.slice(0, 50);

          // Validate each memory has text
          for (const memory of cappedMemories) {
            if (!memory.text || typeof memory.text !== 'string' || memory.text.trim() === '') {
              return JSON.stringify({
                error: 'invalid_memories',
                details: 'each memory must have non-empty text',
              });
            }
          }

          // Normalize and validate memoryType: move from top-level to metadata if present
          const normalizedMemories = cappedMemories.map((memory) => {
            // Sanitize null metadata to prevent downstream crashes
            const sanitizedMemory = memory.metadata === null ? { ...memory, metadata: {} } : memory;

            // Validate and preserve timestamp if present
            let finalMemory: MemoryToUpsert = sanitizedMemory;
            if (sanitizedMemory.timestamp !== undefined && sanitizedMemory.timestamp !== null) {
              // Check that timestamp is a string
              if (typeof sanitizedMemory.timestamp !== 'string') {
                // Non-string timestamp - drop it and record error
                const { timestamp: _ts, ...rest } = sanitizedMemory;
                finalMemory = rest;
                context.validationMessages.push({
                  level: 'error',
                  message: `Timestamp must be a string (got ${typeof sanitizedMemory.timestamp}). Timestamp dropped.`,
                });
                return finalMemory; // Skip further timestamp validation
              }

              // Handle empty string
              if (sanitizedMemory.timestamp.trim() === '') {
                const { timestamp: _ts, ...rest } = sanitizedMemory;
                finalMemory = rest;
                context.validationMessages.push({
                  level: 'error',
                  message: `Timestamp cannot be empty. Timestamp dropped.`,
                });
                return finalMemory; // Skip further validation
              }

              // Now we know it's a non-empty string - validate it
              const memoryType = (sanitizedMemory.metadata?.memoryType ||
                sanitizedMemory.memoryType) as MemoryType | undefined;
              const validationResult = this.timestampValidator.validate(
                sanitizedMemory.timestamp,
                memoryType
              );

              if (!validationResult.valid) {
                // Validation error: drop timestamp unless force bypass is enabled
                if (!context.forceValidationBypass) {
                  // Drop invalid timestamp
                  const { timestamp: _ts, ...rest } = sanitizedMemory;
                  finalMemory = rest;
                  // Record error in context for user feedback
                  context.validationMessages.push({
                    level: 'error',
                    message: `Timestamp validation failed: ${validationResult.error}. Use force: true to bypass.`,
                  });
                } else {
                  // Force bypass: downgrade to warning and drop timestamp
                  context.validationMessages.push({
                    level: 'warning',
                    message: `Timestamp validation: ${validationResult.error}. Storing without timestamp.`,
                  });
                  const { timestamp: _ts, ...rest } = sanitizedMemory;
                  finalMemory = rest;
                }
              } else {
                // Validation passed: use normalized timestamp
                finalMemory = { ...sanitizedMemory, timestamp: validationResult.normalized };
                if (validationResult.warning) {
                  context.validationMessages.push({
                    level: 'warning',
                    message: validationResult.warning,
                  });
                }
              }
            }

            // If memoryType exists at top level, validate and move to metadata
            if (finalMemory.memoryType && typeof finalMemory.memoryType === 'string') {
              const typedMemoryType = finalMemory.memoryType as MemoryType;
              const { memoryType: _memoryType, ...rest } = finalMemory;

              // Only persist valid memory types
              if (VALID_MEMORY_TYPES.has(typedMemoryType)) {
                const metadata = { ...(finalMemory.metadata || {}) };
                // Always use LLM's fresh classification (don't check if metadata.memoryType exists)
                metadata.memoryType = typedMemoryType;
                return { ...rest, metadata };
              }

              // Drop invalid classifications to avoid feeding bad metadata downstream
              return rest;
            }

            return finalMemory;
          });

          // SECURITY: Use context index, ignore LLM-provided index
          const ids = await this.repo.upsertMemories(
            context.index,
            normalizedMemories,
            defaultMetadata
          );
          // Accumulate IDs for use in final result
          context.storedMemoryIds.push(...ids);
          return JSON.stringify({ success: true, ids }, null, 2);
        }

        case 'delete_memories': {
          // SECURITY: Prevent deletions in read-only/dry-run modes
          if (
            context.operationMode === 'refinement-planning' ||
            context.operationMode === 'forget-dryrun'
          ) {
            return JSON.stringify({
              error: `delete_memories not allowed in ${context.operationMode} mode`,
            });
          }

          const { ids } = args as {
            index?: string;
            ids: string[];
          };

          // Validate IDs array
          if (!Array.isArray(ids) || ids.length === 0) {
            return JSON.stringify({
              error: 'invalid_ids',
              details: 'ids must be a non-empty array',
            });
          }

          // SECURITY: Filter out system IDs (never delete sys_* IDs)
          const safeIds = ids.filter((id) => !id.startsWith('sys_'));
          if (safeIds.length === 0) {
            return JSON.stringify({ success: true, deletedCount: 0, skippedSystemIds: ids.length });
          }

          // Note: This tool is only available when NOT in dry-run mode
          // SECURITY: Use context index, ignore LLM-provided index
          const actualDeletedCount = await this.repo.deleteMemories(context.index, safeIds);
          return JSON.stringify(
            {
              success: true,
              deletedCount: actualDeletedCount,
              skippedSystemIds: ids.length - safeIds.length,
            },
            null,
            2
          );
        }

        case 'read_file': {
          const { path } = args as { path: string };
          const content = await this.fileLoader.readText(path);
          return content;
        }

        case 'analyze_text': {
          const { text, contextMetadata } = args as {
            text: string;
            contextMetadata?: Record<string, unknown>;
          };

          // Use memory-analyzer and classification prompts with LLM
          // Note: We use composePrompt here to get host context injection
          const systemPrompt = this.prompts.composePrompt([
            'memory-analyzer',
            'memory-memorize-classify',
          ]);

          const userPrompt = `Analyze the following text and extract key information:\n\n${text}\n\nContext: ${JSON.stringify(contextMetadata || {})}`;

          const analysis = await this.llm.simpleChat(systemPrompt, userPrompt, {
            model: this.llm.getAnalysisModel(),
            maxTokens: 4096,
          });

          return analysis;
        }

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (error) {
      debugLog('operation', `Tool call failed: ${toolName}`, { error });
      return JSON.stringify({
        error: (error as Error).message,
      });
    }
  }

  /**
   * Run the tool-calling loop for an operation
   * Uses JSON mode for final responses to ensure valid JSON
   */
  async runToolLoop(
    systemPrompt: string,
    userMessage: string,
    context: RequestContext,
    llmOptions: ToolLoopLlmOptions = {}
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const tools = this.getInternalTools(context.operationMode);
    let iterations = 0;
    let previousResponseId: string | undefined;
    const resolvedMaxTokens = llmOptions.maxTokens ?? 16384;
    const resolvedReasoningEffort =
      llmOptions.reasoningEffort ??
      (context.operationMode === 'refinement-planning' ? 'medium' : 'none');

    while (iterations < this.maxToolIterations) {
      iterations++;

      const response = await this.llm.chatWithTools(messages, tools, {
        model: llmOptions.model,
        maxTokens: resolvedMaxTokens, // Cap agent's JSON response (memories + metadata + reasoning)
        previousResponseId,
        reasoningEffort: resolvedReasoningEffort,
        verbosity: llmOptions.verbosity,
        jsonMode: true, // Enforce JSON mode for structured final responses
      });

      previousResponseId = response.responseId;

      // Check for truncation or content filtering BEFORE processing response
      if (response.finishReason === 'length') {
        const preview = (response.content || '').substring(0, 200);
        throw new Error(
          `LLM response was truncated due to token limit (16384 tokens exceeded). ` +
            `Try breaking input into smaller chunks or contact support. ` +
            `Response preview: ${preview}...`
        );
      }

      if (response.finishReason === 'content_filter') {
        throw new Error(
          `LLM response was filtered due to content policy violation. ` +
            `Please review input for policy violations and try again.`
        );
      }

      if (!response.finishReason) {
        throw new Error(
          `LLM response missing finish reason. This may indicate an API error. ` +
            `Response content: ${(response.content || '').substring(0, 200)}...`
        );
      }

      // If no tool calls, we have a final response
      if (!response.toolCalls || response.toolCalls.length === 0) {
        return response.content || '';
      }

      // Add assistant message with tool_calls
      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
      });

      // Execute each tool call and add results
      for (const toolCall of response.toolCalls) {
        const args = safeJsonParse<Record<string, unknown>>(
          toolCall.arguments,
          `arguments for tool "${toolCall.name}"`
        );
        const result = await this.executeInternalTool(toolCall.name, args, context);

        // Log operation for diagnostics with enhanced diagnostic data
        const logEntry: OperationLogEntry = {
          toolName: toolCall.name,
          timestamp: new Date().toISOString(),
          argsSummary: JSON.stringify(args).substring(0, 200),
          resultSummary: result.substring(0, 200),
        };

        // Extract structured diagnostics for decision inference
        try {
          if (toolCall.name === 'upsert_memories') {
            const memories = (args as { memories?: unknown }).memories;
            if (Array.isArray(memories)) {
              logEntry.diagnostics = {
                ...(logEntry.diagnostics || {}),
                memoriesCount: memories.length,
              };
            } else {
              logEntry.diagnostics = {
                ...(logEntry.diagnostics || {}),
                invalidArgs: true,
              };
            }
            // Try to parse result for stored IDs or error information
            try {
              const parsedResult = JSON.parse(result);
              if (parsedResult?.ids && Array.isArray(parsedResult.ids)) {
                logEntry.diagnostics = {
                  ...(logEntry.diagnostics || {}),
                  storedIds: parsedResult.ids,
                };
              } else if (parsedResult && typeof parsedResult === 'object' && parsedResult.error) {
                logEntry.diagnostics = {
                  ...(logEntry.diagnostics || {}),
                  errorMessage:
                    typeof parsedResult.error === 'string'
                      ? parsedResult.error
                      : JSON.stringify(parsedResult.error),
                };
              }
            } catch {
              // Result not parseable, skip extraction
            }
          } else if (toolCall.name === 'search_memories') {
            // Try to parse result for search IDs or error metadata
            try {
              const parsedResult = JSON.parse(result);
              if (Array.isArray(parsedResult)) {
                const resultIds = parsedResult
                  .map((r: unknown) => (r as { id?: string })?.id)
                  .filter(Boolean);
                logEntry.diagnostics = {
                  searchResultIds: resultIds,
                  searchResultCount: parsedResult.length,
                };
              } else if (parsedResult && typeof parsedResult === 'object' && parsedResult.error) {
                logEntry.diagnostics = {
                  ...(logEntry.diagnostics || {}),
                  errorMessage:
                    typeof parsedResult.error === 'string'
                      ? parsedResult.error
                      : JSON.stringify(parsedResult.error),
                };
              }
            } catch {
              // Result not parseable, skip ID extraction
            }
          }
        } catch {
          // Silently skip diagnostic extraction on parse errors
        }

        context.operationLog.push(logEntry);

        // Add tool result
        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCall.id,
        });
      }
    }

    throw new Error('Maximum tool iterations reached without final response');
  }
}
