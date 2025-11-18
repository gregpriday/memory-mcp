import type { ChatMessage, ToolDef, LLMResponse } from '../../src/llm/LLMClient.js';
import type { MemoryMetadata, SearchResult } from '../../src/memory/types.js';

/**
 * FakeRecallLLMClient
 * Test double for LLMClient that simulates the recall tool loop
 * without calling OpenAI API. Provides deterministic responses for testing.
 */
export class FakeRecallLLMClient {
  private callCount = 0;
  private model: string;
  private analysisModel: string;

  constructor(model = 'fake-llm-model', analysisModel = 'fake-analysis-model') {
    this.model = model;
    this.analysisModel = analysisModel;
  }

  /**
   * Simulate chat with tools for the recall operation.
   * First call: Returns tool_call for search_memories
   * Second call: Returns final answer with memories from tool result
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

    // First call: Agent decides to call search_memories tool
    if (this.callCount === 1) {
      // Extract query and index from user message
      const userMessage = messages.find((m) => m.role === 'user');
      const payload = this.parsePayload(userMessage?.content || '');
      const query = payload.query || 'test query';
      const index = payload.index || 'default';
      const limit = payload.limit || 10;
      const filterExpression = payload.baseFilterExpression;

      return {
        content: null,
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-fake-search-1',
            name: 'search_memories',
            arguments: JSON.stringify({
              index,
              query,
              limit,
              ...(filterExpression && { filterExpression }),
            }),
          },
        ],
      };
    }

    // Second call: Agent returns final answer after tool execution
    if (this.callCount === 2) {
      // Find the tool result in messages
      const toolResult = messages.find((m) => m.role === 'tool');
      let memories: Array<{ id: string; text: string; score?: number; metadata?: MemoryMetadata }> =
        [];
      let answer = 'No results found';

      if (toolResult?.content) {
        try {
          // Parse the search results from tool response
          const searchResults = JSON.parse(toolResult.content);
          if (Array.isArray(searchResults)) {
            // Convert SearchResult[] to RecallResult.memories format
            memories = searchResults.map((result) => ({
              id: result.id,
              text: result.content?.text || result.content || '',
              score: result.score,
              metadata: result.metadata,
            }));

            // Generate answer based on results
            if (memories.length > 0) {
              answer = `Found ${memories.length} relevant memories`;
            }
          }
        } catch (error) {
          console.error('Failed to parse tool result:', error);
        }
      }

      return {
        content: JSON.stringify({
          answer,
          memories,
        }),
        finishReason: 'stop',
        toolCalls: [],
      };
    }

    // Fallback for unexpected additional calls
    return {
      content: JSON.stringify({
        answer: 'Error: Unexpected additional tool loop iteration',
        memories: [],
      }),
      finishReason: 'stop',
      toolCalls: [],
    };
  }

  /**
   * Simple chat for analysis tasks (e.g., query expansion).
   * Returns empty response since tests don't use advanced features.
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
    // Return empty JSON for analysis operations
    return JSON.stringify({});
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
   * Expand query for query expansion feature.
   * Returns empty array since tests don't use query expansion.
   */
  async expandQuery(_query: string): Promise<string[]> {
    return [];
  }

  /**
   * Reset the call counter for a new test
   */
  reset(): void {
    this.callCount = 0;
  }

  /**
   * Parse the JSON payload from the user message.
   * The RecallOperation sends a structured JSON payload with query, index, etc.
   */
  private parsePayload(content: string): {
    query?: string;
    index?: string;
    limit?: number;
    baseFilterExpression?: string;
    responseMode?: string;
    prefetchedResults?: SearchResult[];
  } {
    try {
      const parsed = JSON.parse(content);
      return {
        query: parsed.query,
        index: parsed.index,
        limit: parsed.limit,
        baseFilterExpression: parsed.baseFilterExpression,
        responseMode: parsed.responseMode,
        prefetchedResults: parsed.prefetchedResults,
      };
    } catch {
      // Not JSON or parsing failed, return empty object
      return {};
    }
  }
}
