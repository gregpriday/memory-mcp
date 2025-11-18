import type { ChatMessage, ToolDef, LLMResponse } from '../../src/llm/LLMClient.js';

/**
 * ScriptedLLMClient
 * Test double for LLMClient that allows queueing deterministic responses.
 * Useful for testing complex operations like refine_memories where the LLM
 * responses need to be controlled precisely.
 */
export class ScriptedLLMClient {
  private chatResponses: LLMResponse[] = [];
  private simpleChatResponses: string[] = [];
  private currentChatIndex = 0;
  private currentSimpleChatIndex = 0;
  private model: string;
  private analysisModel: string;

  constructor(model = 'scripted-llm-model', analysisModel = 'scripted-analysis-model') {
    this.model = model;
    this.analysisModel = analysisModel;
  }

  /**
   * Queue a response for the next chatWithTools call.
   * Responses are consumed in FIFO order.
   */
  queueChatResponse(response: LLMResponse): void {
    this.chatResponses.push(response);
  }

  /**
   * Queue a response for the next simpleChat call.
   * Responses are consumed in FIFO order.
   */
  queueSimpleChatResponse(response: string): void {
    this.simpleChatResponses.push(response);
  }

  /**
   * Chat with tools - returns the next queued response.
   * If no responses are queued, throws an error.
   */
  async chatWithTools(
    _messages: ChatMessage[],
    _tools: ToolDef[],
    _options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      jsonMode?: boolean;
    } = {}
  ): Promise<LLMResponse> {
    if (this.currentChatIndex >= this.chatResponses.length) {
      throw new Error(
        `ScriptedLLMClient: No more chat responses queued (called ${this.currentChatIndex + 1} times, ${this.chatResponses.length} queued)`
      );
    }

    const response = this.chatResponses[this.currentChatIndex];
    this.currentChatIndex++;
    return response;
  }

  /**
   * Simple chat - returns the next queued response.
   * If no responses are queued, returns empty JSON object.
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
    if (this.currentSimpleChatIndex >= this.simpleChatResponses.length) {
      // Default fallback for simpleChat (e.g., analyze_text tool)
      return JSON.stringify({ memories: [] });
    }

    const response = this.simpleChatResponses[this.currentSimpleChatIndex];
    this.currentSimpleChatIndex++;
    return response;
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
   * Query expansion - returns empty array for tests
   */
  async expandQuery(_query: string, _count: number = 2): Promise<string[]> {
    return [];
  }

  /**
   * Reset the client state for a new test
   */
  reset(): void {
    this.chatResponses = [];
    this.simpleChatResponses = [];
    this.currentChatIndex = 0;
    this.currentSimpleChatIndex = 0;
  }

  /**
   * Get the number of remaining queued chat responses
   */
  getRemainingChatResponses(): number {
    return this.chatResponses.length - this.currentChatIndex;
  }

  /**
   * Get the number of chat calls made so far
   */
  getChatCallCount(): number {
    return this.currentChatIndex;
  }
}
