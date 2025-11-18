import OpenAI from 'openai';
import type {
  ResponseCreateParamsNonStreaming,
  Response,
  ResponseInput,
  ResponseInputItem,
} from 'openai/resources/responses/responses';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface LLMResponse {
  responseId: string;
  content: string | null;
  toolCalls?: ToolCall[];
  finishReason: string;
}

/**
 * LLMClient
 * Wrapper around OpenAI SDK for chat completions and tool calling
 */
export class LLMClient {
  private openai: OpenAI;
  private defaultModel: string;
  private defaultAnalysisModel: string;

  constructor(apiKey: string, defaultModel = 'gpt-5-mini', analysisModel = 'gpt-5-mini') {
    this.openai = new OpenAI({ apiKey });
    this.defaultModel = process.env.MEMORY_MODEL || defaultModel;
    this.defaultAnalysisModel = process.env.MEMORY_ANALYSIS_MODEL || analysisModel;
  }

  /**
   * Convert our ChatMessage format to Responses API input format
   */
  private toResponseInput(messages: ChatMessage[]): ResponseInput {
    const input: ResponseInput = [];

    for (const message of messages) {
      if (message.role === 'tool') {
        if (!message.tool_call_id) {
          throw new Error('Tool messages must include tool_call_id');
        }
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id,
          output: message.content ?? '',
        });
        continue;
      }

      input.push({
        role: message.role,
        content: message.content ?? '',
      } as ResponseInputItem);

      if (message.role === 'assistant' && message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          input.push({
            type: 'function_call',
            id: toolCall.id,
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          });
        }
      }
    }

    return input;
  }

  /**
   * Convert our ToolDef format to Responses API tool format
   */
  private toResponseTools(tools: ToolDef[]): ResponseCreateParamsNonStreaming['tools'] {
    return tools.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: true,
    }));
  }

  /**
   * Extract content and tool calls from Responses API output
   */
  private extractResponseContent(response: Response): {
    content: string | null;
    toolCalls?: ToolCall[];
  } {
    const toolCalls: ToolCall[] = [];

    for (const item of response.output) {
      if (item.type === 'function_call') {
        toolCalls.push({
          id: item.id ?? item.call_id,
          name: item.name,
          arguments: item.arguments,
        });
      }
    }

    return {
      content: response.output_text?.length ? response.output_text : null,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  }

  /**
   * Chat completion with tool calling support using Responses API
   */
  async chatWithTools(
    messages: ChatMessage[],
    tools: ToolDef[],
    options: {
      model?: string;
      maxTokens?: number;
      previousResponseId?: string;
      reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
      verbosity?: 'low' | 'medium' | 'high';
      jsonMode?: boolean;
    } = {}
  ): Promise<LLMResponse> {
    const model = options.model ?? this.defaultModel;
    const reasoningEffort =
      options.reasoningEffort ??
      (process.env.MEMORY_MODEL_REASONING_EFFORT as
        | 'none'
        | 'low'
        | 'medium'
        | 'high'
        | undefined) ??
      'none';
    const verbosity =
      options.verbosity ??
      (process.env.MEMORY_MODEL_VERBOSITY as 'low' | 'medium' | 'high' | undefined) ??
      'medium';

    const requestBody: ResponseCreateParamsNonStreaming = {
      model,
      tools: tools.length ? this.toResponseTools(tools) : undefined,
      reasoning: { effort: reasoningEffort },
      text: {
        verbosity: verbosity,
        ...(options.jsonMode && { format: { type: 'json_object' } }),
      },
      ...(options.maxTokens && { max_output_tokens: options.maxTokens }),
      ...(options.previousResponseId
        ? { previous_response_id: options.previousResponseId }
        : { input: this.toResponseInput(messages) }),
    };

    try {
      const response = await this.openai.responses.create(requestBody);
      const parsed = this.extractResponseContent(response);

      return {
        responseId: response.id,
        content: parsed.content,
        toolCalls: parsed.toolCalls,
        finishReason: response.incomplete_details?.reason ?? response.status ?? 'completed',
      };
    } catch (error) {
      console.error('LLM API error:', error);
      throw new Error(`LLM request failed: ${(error as Error).message}`);
    }
  }

  /**
   * Simple chat without tool calling (useful for analysis tasks) using Responses API
   */
  async simpleChat(
    systemPrompt: string,
    userContent: string,
    options: {
      model?: string;
      maxTokens?: number;
      reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
      verbosity?: 'low' | 'medium' | 'high';
    } = {}
  ): Promise<string> {
    const model = options.model ?? this.defaultAnalysisModel;
    const reasoningEffort = options.reasoningEffort ?? 'none'; // Fast for analysis tasks
    const verbosity = options.verbosity ?? 'low'; // Concise for analysis

    const requestBody: ResponseCreateParamsNonStreaming = {
      model,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      reasoning: { effort: reasoningEffort },
      text: { verbosity: verbosity },
      ...(options.maxTokens && { max_output_tokens: options.maxTokens }),
    };

    try {
      const response = await this.openai.responses.create(requestBody);
      return response.output_text || '';
    } catch (error) {
      console.error('LLM API error:', error);
      throw new Error(`LLM request failed: ${(error as Error).message}`);
    }
  }

  /**
   * Get the default model for agent operations
   */
  getDefaultModel(): string {
    return this.defaultModel;
  }

  /**
   * Get the default model for analysis operations
   */
  getAnalysisModel(): string {
    return this.defaultAnalysisModel;
  }

  /**
   * Expand a query into semantic variations for improved recall accuracy.
   * Uses a fast model (gpt-5-mini) to generate alternative phrasings of the same query.
   *
   * @param query - The original user query to expand
   * @param count - Number of variations to generate (default: 2)
   * @returns Promise resolving to array of query variations (does not include original query)
   *
   * @example
   * ```typescript
   * const variations = await llmClient.expandQuery("What are the email rules?", 2);
   * // Returns: ["email style guide formatting", "email communication preferences"]
   * ```
   */
  async expandQuery(query: string, count: number = 2): Promise<string[]> {
    const systemPrompt = `You are a query expansion assistant. Given a user query, generate ${count} alternative phrasings that capture the same semantic intent using different keywords.

Focus on:
- Synonyms and related terms
- Different ways to express the same concept
- Domain-specific terminology variations
- More specific or more general phrasings

Return ONLY a JSON array of strings with ${count} variations. Do not include explanations or the original query.

Example:
User: "What are the email rules?"
Assistant: ["email style guide formatting preferences", "email communication template structure"]`;

    try {
      const response = await this.openai.responses.create({
        model: this.defaultAnalysisModel,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        reasoning: { effort: 'none' }, // Fast response for query expansion
        text: {
          verbosity: 'low', // Concise variations
          format: { type: 'json_object' },
        },
      });

      const content = response.output_text || '{"variations": []}';
      const parsed = JSON.parse(content);

      // Handle both array and object responses
      let variations: string[];
      if (Array.isArray(parsed)) {
        variations = parsed;
      } else if (parsed.variations && Array.isArray(parsed.variations)) {
        variations = parsed.variations;
      } else {
        console.error('Query expansion returned unexpected format:', content);
        return [];
      }

      // Validate and filter variations
      const validVariations = variations
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => v.trim())
        .slice(0, count);

      return validVariations;
    } catch (error) {
      console.error('Query expansion failed:', error);
      // Return empty array on failure - caller will fall back to original query only
      return [];
    }
  }
}
