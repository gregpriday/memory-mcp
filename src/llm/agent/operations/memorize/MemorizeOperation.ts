import { LLMClient } from '../../../LLMClient.js';
import { PromptManager } from '../../../PromptManager.js';
import { IMemoryRepository } from '../../../../memory/IMemoryRepository.js';
import { ProjectFileLoader } from '../../../../memory/ProjectFileLoader.js';
import {
  MemorizeToolArgs,
  MemorizeResult,
  MemorizeDecision,
  MemoryToUpsert,
} from '../../../../memory/types.js';
import { ToolRuntime } from '../../runtime/ToolRuntime.js';
import { MemoryAgentConfig, RequestContext, PreprocessedFileSummary } from '../../shared/index.js';
import { safeJsonParse } from '../../shared/utils.js';
import { debugLogOperation, debugLog } from '../../../../utils/logger.js';

/**
 * MemorizeOperation handles memory ingestion with automatic chunking,
 * LLM-powered extraction, and decision tracking.
 */
export class MemorizeOperation {
  private ingestionConfig: Required<Omit<MemoryAgentConfig, 'projectId'>>;

  constructor(
    private llm: LLMClient,
    private prompts: PromptManager,
    private repo: IMemoryRepository,
    private fileLoader: ProjectFileLoader,
    private toolRuntime: ToolRuntime,
    config: MemoryAgentConfig = {}
  ) {
    this.ingestionConfig = {
      largeFileThresholdBytes: config.largeFileThresholdBytes ?? 256 * 1024, // 256KB default
      chunkSizeChars: config.chunkSizeChars ?? 16_000,
      chunkOverlapChars: config.chunkOverlapChars ?? 2_000,
      maxChunksPerFile: config.maxChunksPerFile ?? 24,
      maxMemoriesPerFile: config.maxMemoriesPerFile ?? 50,
    };
  }

  /**
   * Split large content into overlapping character chunks to keep LLM requests bounded
   */
  private chunkText(text: string): string[] {
    const { chunkSizeChars, chunkOverlapChars, maxChunksPerFile } = this.ingestionConfig;

    if (chunkSizeChars <= 0) {
      return [text];
    }

    const chunks: string[] = [];
    const length = text.length;
    let start = 0;

    while (start < length && chunks.length < maxChunksPerFile) {
      const end = Math.min(length, start + chunkSizeChars);
      const chunk = text.slice(start, end);
      if (chunk.trim().length > 0) {
        chunks.push(chunk);
      }

      if (end === length) {
        break;
      }

      start = Math.max(0, end - chunkOverlapChars);
    }

    return chunks.length > 0 ? chunks : [text];
  }

  /**
   * Parse analyzer output into MemoryToUpsert entries
   */
  private parseAnalyzerOutput(raw: string): MemoryToUpsert[] {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.memories)) {
        return [];
      }

      return parsed.memories
        .map((memory: any): MemoryToUpsert | null => {
          const text = typeof memory?.text === 'string' ? memory.text.trim() : '';
          if (!text) {
            return null;
          }
          const metadata =
            memory.metadata && typeof memory.metadata === 'object'
              ? (memory.metadata as Record<string, unknown>)
              : {};

          // Preserve top-level memoryType field into metadata if present
          if (memory.memoryType && typeof memory.memoryType === 'string') {
            metadata.memoryType = memory.memoryType;
          }

          return {
            text,
            metadata,
          } as MemoryToUpsert;
        })
        .filter((memory: MemoryToUpsert | null): memory is MemoryToUpsert => Boolean(memory));
    } catch (error) {
      console.warn('Failed to parse memory-analyzer output', error, raw?.slice?.(0, 200));
      return [];
    }
  }

  /**
   * Run the memory-analyzer prompt deterministically for a host-managed chunk
   */
  private async analyzeChunk(
    chunk: string,
    contextMetadata: Record<string, unknown>
  ): Promise<MemoryToUpsert[]> {
    const systemPrompt = this.prompts.composePrompt([
      'memory-analyzer',
      'memory-memorize-classify',
    ]);
    const userPrompt = [
      'Analyze the following text chunk and return JSON with a "memories" array.',
      'Each entry must include "text" and optional "metadata" (topic, tags, importance, relationships, etc.).',
      `Chunk Context: ${JSON.stringify(contextMetadata)}`,
      'Chunk Text:',
      chunk,
    ].join('\n\n');

    const analysis = await this.llm.simpleChat(systemPrompt, userPrompt, {
      model: this.llm.getAnalysisModel(),
      maxTokens: 2048,
    });

    return this.parseAnalyzerOutput(analysis);
  }

  /**
   * Format byte values for human-readable notes
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes}B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)}KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  /**
   * Host-side chunked ingestion path for large files. Reads once, analyzes per chunk
   * using the cheaper analysis model, and upserts resulting memories directly.
   */
  private async ingestLargeFileWithAnalysis(params: {
    path: string;
    content: string;
    byteSize: number;
    index: string;
    defaultMetadata?: Record<string, unknown>;
    context: RequestContext;
  }): Promise<PreprocessedFileSummary> {
    const { path, content, byteSize, index, defaultMetadata, context } = params;
    const chunks = this.chunkText(content);
    const totalChunks = chunks.length;
    const collectedMemories: MemoryToUpsert[] = [];
    let processedChunks = 0;

    for (let i = 0; i < totalChunks; i++) {
      if (collectedMemories.length >= this.ingestionConfig.maxMemoriesPerFile) {
        break;
      }
      const chunk = chunks[i];
      processedChunks++;

      const chunkContext = {
        source: 'file',
        sourcePath: path,
        chunkIndex: i + 1,
        chunkCount: totalChunks,
        byteSize,
      };

      const analyzedMemories = await this.analyzeChunk(chunk, {
        ...chunkContext,
        index,
        defaultMetadata,
      });

      if (!analyzedMemories.length) {
        continue;
      }

      const remainingSlots = this.ingestionConfig.maxMemoriesPerFile - collectedMemories.length;
      const normalized = analyzedMemories.slice(0, remainingSlots).map((memory) => {
        const metadata = { ...(memory.metadata || {}) } as Record<string, unknown>;
        metadata.source = 'file';
        metadata.sourcePath = path;
        metadata.ingestion = 'chunked-analysis';
        metadata.chunkIndex = i + 1;
        metadata.chunkCount = totalChunks;
        metadata.chunkCharLength = chunk.length;
        metadata.byteSize = byteSize;
        return {
          text: memory.text,
          metadata,
        };
      });

      collectedMemories.push(...normalized);
    }

    if (collectedMemories.length === 0) {
      return {
        path,
        byteSize,
        storedMemories: 0,
        chunkCount: processedChunks || totalChunks,
        notes: `Processed ${processedChunks || totalChunks} chunks from ${path} but no memories qualified for storage.`,
      };
    }

    const ids = await this.repo.upsertMemories(index, collectedMemories, defaultMetadata);
    context.storedMemoryIds.push(...ids);

    return {
      path,
      byteSize,
      storedMemories: ids.length,
      chunkCount: processedChunks,
      notes: `Chunk-ingested ${path} (${this.formatBytes(byteSize)}). Processed ${processedChunks}/${totalChunks} chunks and stored ${ids.length} memories via analysis model.`,
    };
  }

  /**
   * Build a MemorizeDecision from LLM response or fallback heuristics.
   *
   * This helper analyzes the LLM's response and operation log to determine:
   * - What action was taken (STORED/FILTERED/DEDUPLICATED/REJECTED)
   * - Why that decision was made
   * - What remediation is available (if applicable)
   * - Related memory IDs (if deduplicating)
   *
   * @param llmResult - The parsed JSON response from the LLM
   * @param context - Request context with operation log and stored IDs
   * @param storedCount - Number of memories that were actually stored
   * @returns MemorizeDecision object with action, reason, remediation, and relatedIds
   */
  private buildMemorizeDecision(
    llmResult: Record<string, unknown>,
    context: RequestContext,
    storedCount: number
  ): MemorizeDecision {
    // Guard against null/false/non-object LLM responses (valid JSON but invalid structure)
    if (!llmResult || typeof llmResult !== 'object') {
      return {
        action: 'REJECTED',
        reason: 'LLM returned invalid response format (expected object)',
        remediation: 'Review LLM prompt and retry',
      };
    }

    // If LLM provided a decision, parse and validate it against actual results
    if (llmResult.decision && typeof llmResult.decision === 'object') {
      const decision = llmResult.decision as Record<string, unknown>;
      const action = (decision.action as string)?.toUpperCase();

      // Validate action is one of the allowed values
      if (['STORED', 'FILTERED', 'DEDUPLICATED', 'REJECTED'].includes(action)) {
        // Reconcile LLM's decision with actual storedCount
        const claimedAction = action as 'STORED' | 'FILTERED' | 'DEDUPLICATED' | 'REJECTED';

        // If LLM claims STORED but nothing was stored, check if it was deduplication
        if (claimedAction === 'STORED' && storedCount === 0) {
          // Check operation log for signs of deduplication
          const searchCalls = context.operationLog.filter(
            (log) => log.toolName === 'search_memories'
          );
          const upsertCalls = context.operationLog.filter(
            (log) => log.toolName === 'upsert_memories'
          );
          const attemptedMemoriesCount = upsertCalls.reduce(
            (sum, call) => sum + (call.diagnostics?.memoriesCount || 0),
            0
          );

          // Filter to only searches that actually returned results
          const searchCallsWithResults = searchCalls.filter((call) => {
            const hitCount =
              call.diagnostics?.searchResultCount ?? call.diagnostics?.searchResultIds?.length ?? 0;
            return hitCount > 0 && !call.diagnostics?.errorMessage;
          });

          // If searches found results but no upserts (or only no-op upserts), likely deduplication
          if (
            searchCallsWithResults.length > 0 &&
            (upsertCalls.length === 0 || attemptedMemoriesCount === 0)
          ) {
            const relatedIds = new Set<string>();
            for (const searchCall of searchCallsWithResults) {
              if (searchCall.diagnostics?.searchResultIds) {
                for (const id of searchCall.diagnostics.searchResultIds) {
                  relatedIds.add(id);
                }
              }
            }

            return {
              action: 'DEDUPLICATED',
              reason:
                relatedIds.size > 0
                  ? `Content overlaps with ${relatedIds.size} existing memor${relatedIds.size === 1 ? 'y' : 'ies'} (agent incorrectly claimed storage)`
                  : 'Content appears to duplicate existing memories (agent incorrectly claimed storage)',
              remediation: 'Use force: true to bypass deduplication and store anyway',
              relatedIds: relatedIds.size > 0 ? Array.from(relatedIds).slice(0, 5) : undefined,
            };
          }

          // Otherwise, this is a genuine rejection (agent claimed success but failed)
          return {
            action: 'REJECTED',
            reason: 'Agent claimed storage succeeded but no memories were persisted',
            remediation: 'Review operation logs and retry with explicit input',
          };
        }

        // If LLM claims non-storage but memories were stored, override to STORED
        if (claimedAction !== 'STORED' && storedCount > 0) {
          return {
            action: 'STORED',
            reason: `Successfully stored ${storedCount} memories (agent reported: ${claimedAction})`,
          };
        }

        // LLM and reality agree, use LLM's decision
        return {
          action: claimedAction,
          reason: (decision.reason as string) || 'No reason provided',
          remediation: decision.remediation as string | undefined,
          relatedIds: decision.relatedIds as string[] | undefined,
        };
      }
    }

    // Fallback heuristics when LLM doesn't provide decision
    const upsertCalls = context.operationLog.filter((log) => log.toolName === 'upsert_memories');
    const searchCalls = context.operationLog.filter((log) => log.toolName === 'search_memories');

    // Filter to only searches that actually returned results
    const searchCallsWithResults = searchCalls.filter((call) => {
      const hitCount =
        call.diagnostics?.searchResultCount ?? call.diagnostics?.searchResultIds?.length ?? 0;
      return hitCount > 0 && !call.diagnostics?.errorMessage;
    });

    // Check if any upsert_memories calls occurred
    if (upsertCalls.length === 0 && storedCount === 0) {
      // No upsert calls - check if searches found results (indicates deduplication)
      if (searchCallsWithResults.length > 0) {
        // Agent searched and found duplicates but didn't upsert
        const relatedIds = new Set<string>();
        for (const searchCall of searchCallsWithResults) {
          if (searchCall.diagnostics?.searchResultIds) {
            for (const id of searchCall.diagnostics.searchResultIds) {
              relatedIds.add(id);
            }
          }
        }

        return {
          action: 'DEDUPLICATED',
          reason:
            relatedIds.size > 0
              ? `Content overlaps with ${relatedIds.size} existing memor${relatedIds.size === 1 ? 'y' : 'ies'}`
              : 'Content appears to duplicate existing memories',
          remediation: 'Use force: true to bypass deduplication and store anyway',
          relatedIds: relatedIds.size > 0 ? Array.from(relatedIds).slice(0, 5) : undefined, // Limit to top 5
        };
      }

      // No upsert and no search results - likely filtered for lack of content
      return {
        action: 'FILTERED',
        reason: 'No atomic memories were generated from the input',
        remediation: 'Provide more specific details or break the content into clearer statements',
      };
    }

    // Check if upsert was called but nothing was stored
    if (upsertCalls.length > 0 && storedCount === 0) {
      // Check if upsert was called with empty array or if memories were rejected
      const attemptedMemoriesCount = upsertCalls.reduce(
        (sum, call) => sum + (call.diagnostics?.memoriesCount || 0),
        0
      );

      if (attemptedMemoriesCount === 0) {
        // Upsert called with empty array - likely deduplication happened before upsert
        // Check if there were searches that found results
        const relatedIds = new Set<string>();
        for (const searchCall of searchCallsWithResults) {
          if (searchCall.diagnostics?.searchResultIds) {
            for (const id of searchCall.diagnostics.searchResultIds) {
              relatedIds.add(id);
            }
          }
        }

        if (relatedIds.size > 0) {
          return {
            action: 'DEDUPLICATED',
            reason: `Content overlaps with ${relatedIds.size} existing memor${relatedIds.size === 1 ? 'y' : 'ies'}`,
            remediation: 'Use force: true to bypass deduplication and store anyway',
            relatedIds: Array.from(relatedIds).slice(0, 5), // Limit to top 5
          };
        }

        // No search results but empty upsert - filtered
        return {
          action: 'FILTERED',
          reason: 'No atomic memories qualified for storage after processing',
          remediation: 'Provide more specific or detailed content',
        };
      }

      // Memories were attempted but rejected (validation or persistence failure)
      return {
        action: 'REJECTED',
        reason: `Agent attempted to store ${attemptedMemoriesCount} memor${attemptedMemoriesCount === 1 ? 'y' : 'ies'} but none were persisted`,
        remediation: 'Check logs for validation errors or retry the operation',
      };
    }

    // Default to STORED if we have stored memories
    if (storedCount > 0) {
      return {
        action: 'STORED',
        reason: `Successfully stored ${storedCount} memories`,
      };
    }

    // Fallback - unknown reason for zero storage
    return {
      action: 'REJECTED',
      reason: 'Unknown reason for zero storage',
      remediation: 'Review operation logs and retry with more explicit input',
    };
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
  async execute(
    args: MemorizeToolArgs,
    index: string,
    projectSystemMessage?: string
  ): Promise<MemorizeResult> {
    const endLog = debugLogOperation('memorize', {
      index,
      inputLength: args.input?.length || 0,
      fileCount: Array.isArray(args.files) ? args.files.length : 0,
      force: args.force || false,
    });

    // Create request-specific context for thread safety
    const context: RequestContext = {
      index,
      storedMemoryIds: [],
      operationMode: 'normal',
      searchIterationCount: 0,
      trackedMemoryIds: new Set(),
      searchDiagnostics: [],
      operationLog: [],
    };

    try {
      const defaultMetadata = args.metadata || {};
      const requestedFiles = Array.isArray(args.files) ? args.files : [];
      const filesForAgent: string[] = [];
      const preprocessedSummaries: PreprocessedFileSummary[] = [];

      for (const filePath of requestedFiles) {
        const fileSize = await this.fileLoader.getFileSize(filePath);
        if (fileSize >= this.ingestionConfig.largeFileThresholdBytes) {
          const content = await this.fileLoader.readText(filePath);
          const summary = await this.ingestLargeFileWithAnalysis({
            path: filePath,
            content,
            byteSize: fileSize,
            index,
            defaultMetadata,
            context,
          });
          preprocessedSummaries.push(summary);
          continue;
        }
        filesForAgent.push(filePath);
      }

      const systemPrompt = this.prompts.composePrompt(
        ['memory-base', 'memory-memorize', 'memory-memorize-classify'],
        projectSystemMessage
      );

      const payload: Record<string, unknown> = {
        instruction: args.input,
        files: filesForAgent,
        requestedFiles,
        index,
        defaultMetadata,
        force: args.force,
      };

      if (preprocessedSummaries.length > 0) {
        payload.preprocessedFiles = preprocessedSummaries;
      }

      const userMessage = JSON.stringify(payload);

      const responseText = await this.toolRuntime.runToolLoop(systemPrompt, userMessage, context);

      // Parse the JSON response with enhanced error handling
      const result = safeJsonParse<any>(responseText, 'LLM response');
      const storedCount = context.storedMemoryIds.length;

      // Build decision from LLM response or heuristics
      const decision = this.buildMemorizeDecision(result, context, storedCount);

      // Gather notes from preprocessing and LLM response
      const preprocessNotes = preprocessedSummaries
        .map((summary) => summary.notes)
        .filter((note): note is string => Boolean(note));
      const llmNotes = result.notes || result.summary;

      // Prepend action to notes if not already present
      let finalNotes = '';
      if (llmNotes && typeof llmNotes === 'string') {
        // Check if notes already start with action prefix
        const hasPrefix = /^(STORED|FILTERED|DEDUPLICATED|REJECTED):/i.test(llmNotes);
        if (hasPrefix) {
          finalNotes = llmNotes;
        } else {
          finalNotes = `${decision.action}: ${llmNotes}`;
        }
      } else {
        // Generate default notes from decision
        finalNotes = `${decision.action}: ${decision.reason}`;
        if (decision.remediation) {
          finalNotes += ` ${decision.remediation}`;
        }
      }

      // Combine with preprocessing notes
      const allNotes = [...preprocessNotes, finalNotes].filter(Boolean).join('\n\n');

      // Log warning when zero storage occurs
      if (storedCount === 0) {
        console.warn('Memorize returned zero storage:', {
          index,
          action: decision.action,
          reason: decision.reason,
          operationLogSummary: context.operationLog.map((log) => ({
            tool: log.toolName,
            args: log.argsSummary.substring(0, 100),
          })),
        });
      }

      debugLog('operation', 'memorize: Building decision', {
        storedCount,
        action: decision.action,
        operationLogLength: context.operationLog.length,
      });

      endLog({
        storedCount,
        memoryIds: context.storedMemoryIds.length,
        action: decision.action,
      });

      return {
        status: 'ok',
        index,
        storedCount,
        memoryIds: context.storedMemoryIds,
        notes: allNotes,
        decision,
      };
    } catch (error) {
      console.error('Memorize error:', error);

      endLog({ error: (error as Error).message });

      return {
        status: 'error',
        index,
        storedCount: 0,
        memoryIds: [],
        error: (error as Error).message,
      };
    }
  }
}
