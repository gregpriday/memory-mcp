import type { ChatMessage, ToolDef, LLMResponse } from '../../src/llm/LLMClient.js';

/**
 * FakeLLMClient
 * Test double for LLMClient that simulates the memorize tool loop
 * without calling OpenAI API. Provides deterministic responses for testing.
 */
export class FakeLLMClient {
  private callCount = 0;
  private model: string;
  private analysisModel: string;
  public lastPreviousResponseId?: string; // Track for testing CoT persistence

  constructor(model = 'fake-llm-model', analysisModel = 'fake-analysis-model') {
    this.model = model;
    this.analysisModel = analysisModel;
  }

  /**
   * Simulate chat with tools for the memorize operation.
   * First call: Returns tool_call for upsert_memories
   * Second call: Returns final decision with STORED status
   */
  async chatWithTools(
    messages: ChatMessage[],
    tools: ToolDef[],
    _options: {
      model?: string;
      maxTokens?: number;
      previousResponseId?: string;
      reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
      verbosity?: 'low' | 'medium' | 'high';
      jsonMode?: boolean;
    } = {}
  ): Promise<LLMResponse> {
    this.callCount++;
    // Track previousResponseId for testing CoT persistence
    this.lastPreviousResponseId = _options.previousResponseId;

    // First call: Agent decides to call upsert_memories tool
    if (this.callCount === 1) {
      // Extract input text and index from messages
      const userMessage = messages.find((m) => m.role === 'user');
      const payload = this.parsePayload(userMessage?.content || '');
      const inputText = payload.instruction || 'Remember this single test memory';
      const indexName = payload.index || 'test-index';
      // Use deterministic timestamp for testing (2025-02-04T10:00:00Z)
      const deterministicTimestamp = '2025-02-04T10:00:00Z';

      return {
        responseId: 'fake-response-1',
        content: null,
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-fake-upsert-1',
            name: 'upsert_memories',
            arguments: JSON.stringify({
              index: indexName,
              memories: [
                {
                  text: inputText,
                  metadata: {
                    topic: 'testing',
                    importance: 'high',
                    memoryType: 'semantic',
                  },
                  timestamp: deterministicTimestamp,
                },
              ],
              defaultMetadata: payload.defaultMetadata || {
                source: 'user',
              },
            }),
          },
        ],
      };
    }

    // Second call: Agent returns final decision after tool execution
    if (this.callCount === 2) {
      // Check if there's a tool result in the messages
      const toolResult = messages.find((m) => m.role === 'tool');
      const hasStoredMemory = toolResult && toolResult.content?.includes('memory_ids');

      return {
        responseId: 'fake-response-2',
        content: JSON.stringify({
          decision: {
            action: 'STORED',
            reason: hasStoredMemory
              ? 'Successfully stored test memory in database'
              : 'Stored single test memory',
          },
          notes: hasStoredMemory
            ? 'STORED: Stored 1 memory with ID from tool result'
            : 'STORED: Stored 1 memory',
        }),
        finishReason: 'stop',
        toolCalls: [],
      };
    }

    // Fallback for unexpected additional calls
    return {
      responseId: `fake-response-${this.callCount}`,
      content: JSON.stringify({
        decision: {
          action: 'ERROR',
          reason: 'Unexpected additional tool loop iteration',
        },
        notes: 'ERROR: Too many iterations',
      }),
      finishReason: 'stop',
      toolCalls: [],
    };
  }

  /**
   * Simple chat for analysis tasks (e.g., file content analysis).
   * Returns empty memories array since tests don't use file analysis.
   */
  async simpleChat(
    _systemPrompt: string,
    _userContent: string,
    _options: {
      model?: string;
      maxTokens?: number;
      reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
      verbosity?: 'low' | 'medium' | 'high';
    } = {}
  ): Promise<string> {
    // For file analysis in memorize operation, return empty memories
    return JSON.stringify({
      memories: [],
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
    this.lastPreviousResponseId = undefined;
  }

  /**
   * Parse the JSON payload from the user message.
   * The MemorizeOperation sends a structured JSON payload with instruction, index, etc.
   */
  private parsePayload(content: string): {
    instruction?: string;
    index?: string;
    defaultMetadata?: Record<string, unknown>;
    force?: boolean;
  } {
    try {
      const parsed = JSON.parse(content);
      return {
        instruction: parsed.instruction,
        index: parsed.index,
        defaultMetadata: parsed.defaultMetadata,
        force: parsed.force,
      };
    } catch {
      // Not JSON or parsing failed, return empty object
      return {};
    }
  }
}
