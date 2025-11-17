import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

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
   * Convert our ChatMessage format to OpenAI format
   */
  private toOpenAIMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: msg.content || '',
          tool_call_id: msg.tool_call_id!,
        };
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        return {
          role: 'assistant',
          content: msg.content,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        } as ChatCompletionMessageParam;
      }
      return {
        role: msg.role,
        content: msg.content,
        ...(msg.name && { name: msg.name }),
      } as ChatCompletionMessageParam;
    });
  }

  /**
   * Convert our ToolDef format to OpenAI ChatCompletionTool format
   */
  private toOpenAITools(tools: ToolDef[]): ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * Chat completion with tool calling support
   */
  async chatWithTools(
    messages: ChatMessage[],
    tools: ToolDef[],
    options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      jsonMode?: boolean;
    } = {}
  ): Promise<LLMResponse> {
    const model = options.model || this.defaultModel;
    const maxTokens = options.maxTokens;

    // Only set temperature if explicitly provided, otherwise use model default
    // Some models (like gpt-5-mini) only support their default temperature
    const completionOptions: any = {
      model,
      messages: this.toOpenAIMessages(messages),
      tools: this.toOpenAITools(tools),
    };

    // GPT-5 models use max_completion_tokens instead of max_tokens
    if (maxTokens) {
      if (model.startsWith('gpt-5')) {
        completionOptions.max_completion_tokens = maxTokens;
      } else {
        completionOptions.max_tokens = maxTokens;
      }
    }

    if (options.temperature !== undefined) {
      completionOptions.temperature = options.temperature;
    }

    // Enable JSON mode for structured responses
    if (options.jsonMode) {
      completionOptions.response_format = { type: 'json_object' };
    }

    try {
      const response = await this.openai.chat.completions.create(completionOptions);

      const choice = response.choices[0];
      const message = choice.message;

      return {
        content: message.content,
        toolCalls: message.tool_calls?.map((tc) => ({
          id: tc.id,
          name: (tc as any).function.name,
          arguments: (tc as any).function.arguments,
        })),
        finishReason: choice.finish_reason,
      };
    } catch (error) {
      console.error('LLM API error:', error);
      throw new Error(`LLM request failed: ${(error as Error).message}`);
    }
  }

  /**
   * Simple chat without tool calling (useful for analysis tasks)
   */
  async simpleChat(
    systemPrompt: string,
    userContent: string,
    options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
    } = {}
  ): Promise<string> {
    const model = options.model || this.defaultAnalysisModel;
    const maxTokens = options.maxTokens;

    // Only set temperature if explicitly provided, otherwise use model default
    // Some models (like gpt-5-mini) only support their default temperature
    const completionOptions: any = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    };

    // GPT-5 models use max_completion_tokens instead of max_tokens
    if (maxTokens) {
      if (model.startsWith('gpt-5')) {
        completionOptions.max_completion_tokens = maxTokens;
      } else {
        completionOptions.max_tokens = maxTokens;
      }
    }

    if (options.temperature !== undefined) {
      completionOptions.temperature = options.temperature;
    }

    try {
      const response = await this.openai.chat.completions.create(completionOptions);

      return response.choices[0].message.content || '';
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
   * Uses a cheap model (gpt-4o-mini) to generate alternative phrasings of the same query.
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
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7, // Allow some creativity for variation
      });

      const content = response.choices[0].message.content || '{"variations": []}';
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
