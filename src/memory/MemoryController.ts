import { IndexResolver } from './IndexResolver.js';
import { ProjectFileLoader } from './ProjectFileLoader.js';
import { MemoryAgent } from '../llm/MemoryAgent.js';
import { CharacterIntrospection } from './CharacterIntrospection.js';
import {
  MemorizeToolArgs,
  RecallToolArgs,
  ForgetToolArgs,
  CreateIndexToolArgs,
  RefineMemoriesToolArgs,
  ScanMemoriesToolArgs,
  InspectCharacterToolArgs,
  MemorizeResult,
  RecallResult,
  ForgetResult,
  CreateIndexResult,
  ListIndexesResult,
  RefineMemoriesResult,
  ScanMemoriesResult,
  InspectCharacterResult,
} from './types.js';

/**
 * MCP Content format for responses
 */
export interface McpContent {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

/**
 * MemoryController - MCP Tool Orchestration Layer
 *
 * Orchestrates high-level memory operations by coordinating between MCP tools,
 * the memory agent, and backend storage. Acts as the bridge between the MCP
 * server layer and the agent/repository layers.
 *
 * **Responsibilities:**
 * - **Index Resolution**: Validates and resolves index names via IndexResolver
 * - **Agent Orchestration**: Delegates operations to MemoryAgent with appropriate mode
 * - **File Access Control**: Manages project file reading permissions via ProjectFileLoader
 * - **Response Formatting**: Converts agent results to MCP content format
 *
 * **Supported Operations:**
 * - `memorize`: Store memories from text or files using agent
 * - `recall`: Search and retrieve memories semantically
 * - `forget`: Delete memories by criteria (with dry-run support)
 * - `refine_memories`: Analyze and consolidate memories
 * - `create_index`: Create new memory index
 * - `list_indexes`: List all available indexes
 * - `scan_memories`: Get statistics about stored memories
 *
 * @remarks
 * This class implements security boundaries:
 * - Index names are validated against project configuration
 * - File paths are restricted to project directory
 * - Agent operations use sandboxed tool runtime
 *
 * @example
 * ```typescript
 * const controller = new MemoryController(
 *   indexResolver,
 *   memoryAgent,
 *   projectFileLoader
 * );
 *
 * // Store memories
 * const result = await controller.memorize({
 *   input: 'User prefers dark mode',
 *   index: 'preferences'
 * });
 *
 * // Search memories
 * const recall = await controller.recall({
 *   query: 'UI preferences',
 *   index: 'preferences'
 * });
 * ```
 *
 * @public
 */
export class MemoryController {
  private introspection: CharacterIntrospection;

  constructor(
    private indexResolver: IndexResolver,
    private agent: MemoryAgent,
    private fileLoader: ProjectFileLoader,
    introspectionService?: CharacterIntrospection
  ) {
    if (introspectionService) {
      this.introspection = introspectionService;
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = (this.agent as any).repository ?? (this.agent as any).repo;
    if (!repo) {
      throw new Error('MemoryAgent repository is required for character introspection');
    }
    this.introspection = new CharacterIntrospection(repo);
  }

  /**
   * Load project system message if provided
   */
  private async loadProjectSystemMessage(path?: string): Promise<string | undefined> {
    if (!path) {
      return undefined;
    }

    try {
      return await this.fileLoader.readText(path);
    } catch (error) {
      console.error('Failed to load project system message:', error);
      throw new Error(
        `Could not load project system message from "${path}": ${(error as Error).message}`
      );
    }
  }

  /**
   * Format a result as MCP content
   */
  private formatResponse(result: unknown, summary?: string, isError = false): McpContent {
    const text = summary
      ? `${summary}\n\n${JSON.stringify(result, null, 2)}`
      : JSON.stringify(result, null, 2);

    return {
      content: [
        {
          type: 'text',
          text,
        },
      ],
      isError,
    };
  }

  /**
   * Handle MEMORIZE tool
   */
  async handleMemorizeTool(args: MemorizeToolArgs): Promise<McpContent> {
    try {
      const index = this.indexResolver.resolve(args.index);
      const projectMessage = await this.loadProjectSystemMessage(args.projectSystemMessagePath);

      const result: MemorizeResult = await this.agent.memorize(args, index, projectMessage);

      if (result.status === 'error') {
        return this.formatResponse(result, `Error: ${result.error}`, true);
      }

      // Use decision-based summary when available
      let summary = '';
      if (result.decision) {
        const { action, reason, remediation } = result.decision;
        const storedCount = result.storedCount ?? 0;

        // Add action-specific emoji
        const actionEmoji =
          action === 'STORED'
            ? '✅'
            : action === 'DEDUPLICATED'
              ? '🔄'
              : action === 'FILTERED'
                ? '🚫'
                : '⚠️';

        const heading = `${actionEmoji} ${action}: ${reason}`;

        if (action === 'STORED') {
          summary = `${heading}\nStored ${storedCount} memories in index "${result.index}".`;
        } else {
          summary = `${heading}\nNo memories were stored.`;
        }

        if (remediation) {
          summary += `\n\n💡 ${remediation}`;
        }

        // Append notes if they don't duplicate the decision
        const trimmedNotes = result.notes?.trim();
        if (trimmedNotes) {
          // Split into paragraphs and filter out duplicates
          const uniqueSections = trimmedNotes
            .split(/\n{2,}/)
            .filter((section) => !section.trim().toUpperCase().startsWith(`${action}:`))
            .join('\n\n')
            .trim();

          if (uniqueSections) {
            summary += `\n\n${uniqueSections}`;
          }
        }
      } else {
        // Fallback for backwards compatibility
        summary = `Stored ${result.storedCount} memories in index "${result.index}".`;
        if (result.notes) {
          summary += `\n${result.notes}`;
        }
      }

      return this.formatResponse(result, summary);
    } catch (error) {
      console.error('Memorize tool error:', error);
      return this.formatResponse(
        {
          status: 'error',
          error: (error as Error).message,
        },
        'Failed to memorize',
        true
      );
    }
  }

  /**
   * Handle RECALL tool
   */
  async handleRecallTool(args: RecallToolArgs): Promise<McpContent> {
    try {
      const index = this.indexResolver.resolve(args.index);
      const projectMessage = await this.loadProjectSystemMessage(args.projectSystemMessagePath);

      const result: RecallResult = await this.agent.recall(args, index, projectMessage);

      if (result.status === 'error') {
        let errorSummary = `Error: ${result.error}`;

        // Add diagnostic context if available
        if (result.searchStatus === 'search_error' && result.searchDiagnostics?.[0]) {
          const diag = result.searchDiagnostics[0];
          errorSummary += `\n\nSearch diagnostics: ${diag.lastError || 'Unknown error'}`;
          if (diag.retryCount > 0) {
            errorSummary += ` (after ${diag.retryCount} retries)`;
          }
        }

        return this.formatResponse(result, errorSummary, true);
      }

      // Format based on response mode
      const mode = args.responseMode || 'answer';
      let summary = '';

      if (mode === 'answer' && result.answer) {
        summary = result.answer;

        // Add diagnostic guidance based on search status
        if (result.searchStatus === 'pending_documents') {
          summary +=
            '\n\nNote: The index has documents pending indexing. If you just stored new memories, wait 5-10 seconds for embeddings to finish indexing, then retry your query.';
        } else if (
          result.searchStatus === 'no_results' &&
          (!result.memories || result.memories.length === 0)
        ) {
          summary +=
            '\n\nNote: Search completed successfully but found no matching memories in the index.';
        }
      } else if (mode === 'memories' && result.memories) {
        summary = `Found ${result.memories.length} memories`;

        // Add diagnostic guidance for empty results
        if (result.memories.length === 0) {
          if (result.searchStatus === 'pending_documents') {
            summary +=
              '\n\nNote: The index has documents pending indexing. Wait a few seconds and retry.';
          } else if (result.searchStatus === 'no_results') {
            summary += '\n\nNote: Search completed successfully but found no matching memories.';
          }
        }
      } else if (mode === 'both') {
        summary = result.answer || `Found ${result.memories?.length ?? 0} memories`;

        // Add diagnostic guidance
        if (!result.memories || result.memories.length === 0) {
          if (result.searchStatus === 'pending_documents') {
            summary += '\n\nNote: Documents are still being indexed. Wait 5-10 seconds and retry.';
          } else if (result.searchStatus === 'no_results') {
            summary += '\n\nNote: Search completed successfully but found no matching memories.';
          }
        }
      }

      return this.formatResponse(result, summary);
    } catch (error) {
      console.error('Recall tool error:', error);
      return this.formatResponse(
        {
          status: 'error',
          error: (error as Error).message,
        },
        'Failed to recall',
        true
      );
    }
  }

  /**
   * Handle FORGET tool
   */
  async handleForgetTool(args: ForgetToolArgs): Promise<McpContent> {
    try {
      const index = this.indexResolver.resolve(args.index);
      const projectMessage = await this.loadProjectSystemMessage(args.projectSystemMessagePath);

      const result: ForgetResult = await this.agent.forget(args, index, projectMessage);

      if (result.status === 'error') {
        return this.formatResponse(result, `Error: ${result.error}`, true);
      }

      let summary = '';
      if (args.dryRun !== false) {
        // Dry run mode
        const planCount = result.plan?.length || 0;
        summary =
          planCount > 0
            ? `Dry run: Would delete ${planCount} memories. Review the plan below.`
            : 'Dry run: No memories matched the forget criteria.';
      } else {
        // Execution mode
        summary = `Deleted ${result.deletedCount || 0} memories from index "${result.index}".`;
      }

      return this.formatResponse(result, summary);
    } catch (error) {
      console.error('Forget tool error:', error);
      return this.formatResponse(
        {
          status: 'error',
          error: (error as Error).message,
        },
        'Failed to forget',
        true
      );
    }
  }

  /**
   * Handle CREATE_INDEX tool
   */
  async handleCreateIndexTool(args: CreateIndexToolArgs): Promise<McpContent> {
    try {
      const result: CreateIndexResult = await this.agent.createIndex(args);

      if (result.status === 'error') {
        return this.formatResponse(result, `Error: ${result.error}`, true);
      }

      const summary = `Index "${result.name}" registered successfully.\n${result.notes || ''}`;
      return this.formatResponse(result, summary);
    } catch (error) {
      console.error('Create index tool error:', error);
      return this.formatResponse(
        {
          status: 'error',
          error: (error as Error).message,
        },
        'Failed to create index',
        true
      );
    }
  }

  /**
   * Handle LIST_INDEXES tool
   */
  async handleListIndexesTool(): Promise<McpContent> {
    try {
      const result: ListIndexesResult = await this.agent.listIndexes();

      if (result.status === 'error') {
        return this.formatResponse(result, `Error: ${result.error}`, true);
      }

      const indexCount = result.indexes?.length ?? 0;
      const summaryParts: string[] = [];

      summaryParts.push(`Found ${indexCount} indexes in Postgres.`);

      if (typeof result.documentCount === 'number') {
        summaryParts.push(
          `Total documents: ${result.documentCount} (pending: ${result.pendingDocumentCount ?? 0}).`
        );
      }

      const summary = summaryParts.join(' ');

      return this.formatResponse(result, summary);
    } catch (error) {
      console.error('List indexes tool error:', error);
      return this.formatResponse(
        {
          status: 'error',
          error: (error as Error).message,
        },
        'Failed to list indexes',
        true
      );
    }
  }

  /**
   * Handle REFINE_MEMORIES tool
   */
  async handleRefineMemoriesTool(args: RefineMemoriesToolArgs): Promise<McpContent> {
    try {
      const index = this.indexResolver.resolve(args.index);
      const projectMessage = await this.loadProjectSystemMessage(args.projectSystemMessagePath);

      const result: RefineMemoriesResult = await this.agent.refineMemories(
        args,
        index,
        projectMessage
      );

      if (result.status === 'error') {
        return this.formatResponse(result, `Refinement failed: ${result.error}`, true);
      }

      // Format summary based on operation type and dry run mode
      let summary = '';
      if (result.dryRun) {
        const actionCount = result.actions?.length ?? 0;
        const skipped = result.skippedActionsCount ?? 0;
        summary = `🔍 Dry run: Proposed ${actionCount} actions`;
        if (skipped > 0) {
          summary += ` (${skipped} skipped due to validation errors)`;
        }
        // Add budget warning if needed
        if (result.status === 'budget_reached') {
          summary += ' - Budget reached';
        }
        // Add validation error details if present
        if (result.error) {
          summary += `\n\n⚠️ Validation warnings: ${result.error}`;
        }
      } else {
        // For reflection operation, use the custom summary from the agent
        if (args.operation === 'reflection') {
          summary = result.summary || `✨ Reflection complete`;
        } else {
          const applied = result.appliedActionsCount ?? 0;
          const skipped = result.skippedActionsCount ?? 0;
          summary = `✅ Applied ${applied} actions`;
          if (skipped > 0) {
            summary += ` (${skipped} skipped)`;
          }

          // Add budget warning if needed
          if (result.status === 'budget_reached') {
            summary += ' - Budget reached';
          }
          // Add error details if present
          if (result.error) {
            summary += `\n\n⚠️ ${result.error}`;
          }
        }
      }

      return this.formatResponse(result, summary);
    } catch (error) {
      console.error('Refine memories tool error:', error);
      return this.formatResponse(
        {
          status: 'error' as const,
          index: args.index ?? this.indexResolver.getDefault(),
          dryRun: args.dryRun !== false,
          error: (error as Error).message,
        },
        'Failed to refine memories',
        true
      );
    }
  }

  /**
   * Handle SCAN_MEMORIES tool
   */
  async handleScanMemoriesTool(args: ScanMemoriesToolArgs): Promise<McpContent> {
    try {
      const index = this.indexResolver.resolve(args.index);

      const result: ScanMemoriesResult = await this.agent.scanMemories(args, index);

      if (result.status === 'error') {
        let errorSummary = `Error: ${result.error}`;

        // Add diagnostic context if available
        if (result.searchStatus === 'search_error' && result.diagnostics?.[0]) {
          const diag = result.diagnostics[0];
          errorSummary += `\n\nSearch diagnostics: ${diag.lastError || 'Unknown error'}`;
          if (diag.retryCount > 0) {
            errorSummary += ` (after ${diag.retryCount} retries)`;
          }
        }

        return this.formatResponse(result, errorSummary, true);
      }

      // Format successful response with diagnostic information
      const resultCount = result.results?.length ?? 0;
      let summary = `🔍 Found ${resultCount} memories in index "${result.index}"`;

      // Add diagnostic guidance based on search status
      if (result.searchStatus === 'pending_documents') {
        summary +=
          '\n\n⚠️ Note: The index has documents pending indexing. If you just stored new memories, wait 5-10 seconds for embeddings to finish indexing, then retry your query.';
      } else if (result.searchStatus === 'no_results' && resultCount === 0) {
        summary +=
          '\n\nℹ️ Note: Search completed successfully but found no matching memories in the index.';
      }

      // Add diagnostic summary if available
      if (result.diagnostics && result.diagnostics.length > 0) {
        const diag = result.diagnostics[0];
        summary += `\n\n📊 Search diagnostics:`;
        summary += `\n  • Query: "${diag.query}"`;
        summary += `\n  • Duration: ${diag.durationMs}ms`;
        summary += `\n  • Semantic weight: ${diag.semanticWeight}`;
        summary += `\n  • Reranking: ${diag.reranking ? 'enabled' : 'disabled'}`;
        if (diag.retryCount > 0) {
          summary += `\n  • Retries: ${diag.retryCount}`;
        }
        if (diag.pendingDocumentCount !== undefined && diag.pendingDocumentCount > 0) {
          summary += `\n  • Pending documents: ${diag.pendingDocumentCount}`;
        }
        if (diag.documentCount !== undefined) {
          summary += `\n  • Total documents: ${diag.documentCount}`;
        }
      }

      return this.formatResponse(result, summary);
    } catch (error) {
      console.error('Scan memories tool error:', error);
      return this.formatResponse(
        {
          status: 'error' as const,
          index: args.index ?? this.indexResolver.getDefault(),
          error: (error as Error).message,
        },
        'Failed to scan memories',
        true
      );
    }
  }

  /**
   * Handle INSPECT_CHARACTER tool
   */
  async handleInspectCharacterTool(args: InspectCharacterToolArgs): Promise<McpContent> {
    try {
      const index = this.indexResolver.resolve(args.index);

      // Generate introspection report
      const report = await this.introspection.inspectCharacter(index, args.view, {
        limit: args.limit,
        minPriority: args.minPriority,
        minIntensity: args.minIntensity,
        emotionLabel: args.emotionLabel,
      });

      // Generate text summary
      const summary = this.introspection.summarizeReport(args.view, report);

      const result: InspectCharacterResult = {
        status: 'ok',
        index,
        view: args.view,
        report,
      };

      return this.formatResponse(result, summary);
    } catch (error) {
      console.error('Inspect character tool error:', error);
      const result: InspectCharacterResult = {
        status: 'error',
        index: args.index ?? this.indexResolver.getDefault(),
        view: args.view,
        error: (error as Error).message,
      };
      return this.formatResponse(
        result,
        `Error inspecting character: ${(error as Error).message}`,
        true
      );
    }
  }
}
