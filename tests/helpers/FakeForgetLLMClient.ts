import type { ChatMessage, ToolDef, LLMResponse } from '../../src/llm/LLMClient.js';

/**
 * FakeForgetLLMClient
 * Test double for LLMClient that simulates the forget tool loop
 * without calling OpenAI API. Provides deterministic responses for testing.
 */
export class FakeForgetLLMClient {
  private callCount = 0;
  private model: string;
  private analysisModel: string;

  constructor(model = 'fake-llm-model', analysisModel = 'fake-analysis-model') {
    this.model = model;
    this.analysisModel = analysisModel;
  }

  /**
   * Simulate chat with tools for the forget operation.
   * First call: Returns tool_call for delete_memories (unless dry-run)
   * Second call: Returns final decision with deletion results or plan
   */
  async chatWithTools(
    messages: ChatMessage[],
    tools: ToolDef[],
    _options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      jsonMode?: boolean;
    } = {}
  ): Promise<LLMResponse> {
    this.callCount++;

    // Extract payload from user message
    const userMessage = messages.find((m) => m.role === 'user');
    const payload = this.parsePayload(userMessage?.content || '');
    const isDryRun = payload.dryRun !== false; // Default to true
    const explicitIds = payload.explicitMemoryIds || [];
    const indexName = payload.index || 'test-index';

    // First call: Agent decides whether to call delete_memories tool
    if (this.callCount === 1) {
      // In dry-run mode, skip tool calls and go straight to plan
      if (isDryRun) {
        return {
          content: JSON.stringify({
            deletedCount: 0,
            deletedIds: [],
            plan: explicitIds.map((id: string) => ({
              id,
              reason: 'Would delete this memory',
              confidence: 'high',
            })),
            notes: 'DRY-RUN: No memories were deleted. Plan shows what would be deleted.',
          }),
          finishReason: 'stop',
          toolCalls: [],
        };
      }

      // In normal mode, emit delete_memories tool call
      return {
        content: null,
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-fake-delete-1',
            name: 'delete_memories',
            arguments: JSON.stringify({
              index: indexName,
              ids: explicitIds,
            }),
          },
        ],
      };
    }

    // Second call: Agent returns final decision after tool execution
    if (this.callCount === 2) {
      // Check if there's a tool result in the messages
      const toolResult = messages.find((m) => m.role === 'tool');
      let deletedCount = 0;
      let deletedIds: string[] = [];

      if (toolResult && toolResult.content) {
        try {
          const result = JSON.parse(toolResult.content);
          // The delete_memories tool returns { success, deletedCount, skippedSystemIds }
          // It doesn't return the actual IDs, so we'll use the explicitMemoryIds from the payload
          deletedCount = result.deletedCount || 0;
          // Reconstruct deleted IDs from the original explicit IDs (those that weren't system IDs)
          const originalIds = explicitIds;
          deletedIds = originalIds
            .filter((id: string) => !id.startsWith('sys_'))
            .slice(0, deletedCount);
        } catch {
          // Ignore parse errors
        }
      }

      return {
        content: JSON.stringify({
          deletedCount,
          deletedIds,
          notes:
            deletedCount > 0 ? `Deleted ${deletedCount} memory(s)` : 'No memories were deleted',
        }),
        finishReason: 'stop',
        toolCalls: [],
      };
    }

    // Fallback for unexpected additional calls
    return {
      content: JSON.stringify({
        deletedCount: 0,
        deletedIds: [],
        notes: 'ERROR: Too many iterations',
      }),
      finishReason: 'stop',
      toolCalls: [],
    };
  }

  /**
   * Simple chat for analysis tasks (not used in forget operation).
   */
  async simpleChat(
    _systemPrompt: string,
    _userContent: string,
    _options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
    } = {}
  ): Promise<string> {
    return JSON.stringify({
      notes: 'Analysis not used in forget operation',
    });
  }

  /**
   * Get the default model for agent operations
   */
  getDefaultModel(): string {
    return this.model;
  }

  /**
   * Get the default model for analysis operations
   */
  getAnalysisModel(): string {
    return this.analysisModel;
  }

  /**
   * Reset the call counter for a new test
   */
  reset(): void {
    this.callCount = 0;
  }

  /**
   * Parse the JSON payload from the user message.
   * The ForgetOperation sends a structured JSON payload with instruction, index, dryRun, explicitMemoryIds, etc.
   */
  private parsePayload(content: string): {
    instruction?: string;
    index?: string;
    filters?: Record<string, unknown>;
    dryRun?: boolean;
    explicitMemoryIds?: string[];
  } {
    try {
      const parsed = JSON.parse(content);
      return {
        instruction: parsed.instruction,
        index: parsed.index,
        filters: parsed.filters,
        dryRun: parsed.dryRun,
        explicitMemoryIds: parsed.explicitMemoryIds,
      };
    } catch {
      // Not JSON or parsing failed, return empty object
      return {};
    }
  }
}
