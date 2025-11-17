import { LLMClient, ChatMessage, ToolDef } from '../../LLMClient.js';
import { PromptManager } from '../../PromptManager.js';
import { IMemoryRepository } from '../../../memory/IMemoryRepository.js';
import { ProjectFileLoader } from '../../../memory/ProjectFileLoader.js';
import { MemoryToUpsert, MemoryType } from '../../../memory/types.js';
import { RequestContext, OperationLogEntry, VALID_MEMORY_TYPES } from '../shared/index.js';
import { safeJsonParse } from '../shared/utils.js';

interface ToolRuntimeConfig {
  maxToolIterations?: number;
  maxSearchIterations?: number;
}

/**
 * ToolRuntime encapsulates the LLM tool-calling runtime:
 * - Tool definition (discovery)
 * - Tool execution
 * - Tool-calling loop orchestration
 */
export class ToolRuntime {
  private maxToolIterations: number;
  private maxSearchIterations: number;

  constructor(
    private llm: LLMClient,
    private prompts: PromptManager,
    private repo: IMemoryRepository,
    private fileLoader: ProjectFileLoader,
    config: ToolRuntimeConfig = {}
  ) {
    this.maxToolIterations = config.maxToolIterations ?? 10;
    this.maxSearchIterations = config.maxSearchIterations ?? 3;
  }

  /**
   * Define internal tools available to the LLM
   * Conditionally excludes delete_memories in dry-run mode
   * Restricts to read-only tools in refinement-planning mode
   */
  getInternalTools(operationMode: 'normal' | 'forget-dryrun' | 'refinement-planning'): ToolDef[] {
    const tools: ToolDef[] = [
      {
        name: 'search_memories',
        description: 'Search for memories using semantic search in the specified index',
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
          'Fetch memories by their IDs to follow explicit relationships or inspect neighbors in the graph',
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
        description: 'Store or update memories in the specified index',
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
        description: 'Read a text file from the project directory (relative path only)',
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
          'Analyze text to extract key facts, metadata, topics, and tags using memory analysis expertise',
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
      description: 'Delete memories by their IDs',
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

          // Normalize memoryType: move from top-level to metadata if present
          const normalizedMemories = cappedMemories.map((memory) => {
            // Sanitize null metadata to prevent downstream crashes
            const sanitizedMemory = memory.metadata === null ? { ...memory, metadata: {} } : memory;

            // If memoryType exists at top level, validate and move to metadata
            if (sanitizedMemory.memoryType && typeof sanitizedMemory.memoryType === 'string') {
              const typedMemoryType = sanitizedMemory.memoryType as MemoryType;
              const { memoryType, ...rest } = sanitizedMemory;

              // Only persist valid memory types
              if (VALID_MEMORY_TYPES.has(typedMemoryType)) {
                const metadata = { ...(sanitizedMemory.metadata || {}) };
                // Always use LLM's fresh classification (don't check if metadata.memoryType exists)
                metadata.memoryType = typedMemoryType;
                return { ...rest, metadata };
              }

              // Drop invalid classifications to avoid feeding bad metadata downstream
              return rest;
            }

            return sanitizedMemory;
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
    context: RequestContext
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const tools = this.getInternalTools(context.operationMode);
    let iterations = 0;

    while (iterations < this.maxToolIterations) {
      iterations++;

      const response = await this.llm.chatWithTools(messages, tools, {
        maxTokens: 16384, // Cap agent's JSON response (memories + metadata + reasoning)
        jsonMode: true, // Enforce JSON mode for structured final responses
      });

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
                const resultIds = parsedResult.map((r: any) => r?.id).filter(Boolean);
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
        } catch (err) {
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
