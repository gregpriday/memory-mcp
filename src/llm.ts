import OpenAI from "openai";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { QueryFilter, OrderBy } from "./query-builder.js";

export const MODEL_FULL = "gpt-5";
// MODEL_MINI available for lower-cost operations if needed in future
export const MODEL_MINI = "gpt-5-mini";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, "prompts");

function loadPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.txt`), "utf-8");
}

// Cache prompts on first load
const promptCache = new Map<string, string>();

function getPrompt(name: string): string {
  if (!promptCache.has(name)) {
    promptCache.set(name, loadPrompt(name));
  }
  return promptCache.get(name)!;
}

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (openaiClient) return openaiClient;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required");
  }

  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

// Structured filter schema — shared between search_memories and structured_query
const filterSchema: OpenAI.Chat.Completions.ChatCompletionTool["function"]["parameters"] = {
  type: "object",
  properties: {
    field: {
      type: "string",
      description: "The column name to filter on (must be a valid column in the table schema).",
    },
    operator: {
      type: "string",
      enum: ["eq", "neq", "gt", "gte", "lt", "lte", "like", "in", "is_null", "is_not_null"],
      description: "The comparison operator.",
    },
    value: {
      type: ["string", "number", "null"],
      description:
        "The value to compare against. For 'in' operator, pass a comma-separated string that will be split. For 'is_null'/'is_not_null', pass null.",
    },
  },
  required: ["field", "operator", "value"],
  additionalProperties: false,
};

// Tool definitions for the LLM to use when processing memory operations
const memoryTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_memories",
      description:
        "Search for memories using semantic similarity (vector search). Use this when you need to find memories related to a concept, topic, or entity. Results are ranked by semantic similarity.",
      parameters: {
        type: "object",
        properties: {
          search_text: {
            type: "string",
            description:
              "The text to search for semantically. This will be converted to an embedding and compared against stored memory embeddings.",
          },
          limit: {
            type: ["number", "null"],
            description:
              "Maximum number of results to return. Pass null to use the default of 10.",
          },
          filters: {
            type: ["array", "null"],
            items: filterSchema,
            description:
              "Optional structured filters to narrow results by column values (e.g., filter by category, subject, date). Pass null for no filters.",
          },
        },
        required: ["search_text", "limit", "filters"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "structured_query",
      description:
        "Query memories using structured filters. Use this for exact lookups, date-based queries, counting, or when you need precise filtering without semantic search. Only SELECT operations are supported.",
      parameters: {
        type: "object",
        properties: {
          filters: {
            type: ["array", "null"],
            items: filterSchema,
            description:
              "Structured filters to apply. Each filter specifies a field, operator, and value. Pass null to select all rows.",
          },
          order_by: {
            type: ["object", "null"],
            properties: {
              field: { type: "string", description: "Column to sort by." },
              direction: {
                type: "string",
                enum: ["asc", "desc"],
                description: "Sort direction.",
              },
            },
            required: ["field", "direction"],
            additionalProperties: false,
            description: "Optional ordering. Pass null for default order.",
          },
          limit: {
            type: ["number", "null"],
            description:
              "Maximum number of rows to return. Pass null for no limit.",
          },
          explanation: {
            type: "string",
            description: "Brief explanation of what this query does.",
          },
        },
        required: ["filters", "order_by", "limit", "explanation"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "insert_memory",
      description:
        "Insert a new memory into the database. Use this to store new information.",
      parameters: {
        type: "object",
        properties: {
          memory: {
            type: "string",
            description: "The memory content to store.",
          },
          fields: {
            type: "string",
            description:
              'JSON object of additional field values to store, matching the table schema. E.g., \'{"category": "user_info", "subject": "John Doe"}\'',
          },
        },
        required: ["memory", "fields"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "update_memory",
      description:
        "Update an existing memory by its ID. Use this to modify or correct stored information.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "number",
            description: "The ID of the memory to update.",
          },
          memory: {
            type: "string",
            description: "The new memory content. Pass empty string to keep unchanged.",
          },
          fields: {
            type: "string",
            description:
              'JSON object of field values to update. E.g., \'{"category": "updated_info"}\'',
          },
        },
        required: ["id", "memory", "fields"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "delete_memory",
      description:
        "Delete a memory by its ID. Use this to remove outdated or incorrect information.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "number",
            description: "The ID of the memory to delete.",
          },
          reason: {
            type: "string",
            description: "Brief explanation of why this memory is being deleted.",
          },
        },
        required: ["id", "reason"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "reject_operation",
      description:
        "Reject the requested operation if it seems clearly wrong, nonsensical, contradictory, or would corrupt existing memories. Be specific about what is wrong.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Clear explanation of why this memory is being rejected.",
          },
          category: {
            type: "string",
            enum: ["nonsensical", "contradictory", "duplicate", "inappropriate", "insufficient_detail", "other"],
            description: "The category of rejection.",
          },
        },
        required: ["reason", "category"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "ask_question",
      description:
        "Ask the user a clarifying question to improve memory quality. Use during process operations to refine and update memories.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask the user.",
          },
          context: {
            type: "string",
            description: "Brief context about which memories this question relates to and why the answer would help.",
          },
        },
        required: ["question", "context"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];

export type ToolCall =
  | { name: "search_memories"; args: { search_text: string; limit?: number | null; filters?: QueryFilter[] | null } }
  | { name: "structured_query"; args: { filters?: QueryFilter[] | null; order_by?: OrderBy | null; limit?: number | null; explanation: string } }
  | { name: "insert_memory"; args: { memory: string; fields: string } }
  | { name: "update_memory"; args: { id: number; memory: string; fields: string } }
  | { name: "delete_memory"; args: { id: number; reason: string } }
  | { name: "reject_operation"; args: { reason: string; category: string } }
  | { name: "ask_question"; args: { question: string; context: string } };

export interface LLMResult {
  toolCalls: ToolCall[];
  textResponse: string | null;
}

export type MemoryOperation = "remember" | "forget" | "recall" | "process";

export function buildSystemPrompt(
  operation: MemoryOperation,
  tableSchema: string,
  tableName: string
): string {
  const basePrompt = getPrompt("base")
    .replace(/\{\{TABLE_NAME\}\}/g, tableName)
    .replace(/\{\{TABLE_SCHEMA\}\}/g, tableSchema);

  const operationPrompt = getPrompt(operation)
    .replace(/\{\{TABLE_NAME\}\}/g, tableName)
    .replace(/\{\{TABLE_SCHEMA\}\}/g, tableSchema);

  return `${basePrompt}\n\n${operationPrompt}`;
}

function getToolsForOperation(operation: MemoryOperation): OpenAI.Chat.Completions.ChatCompletionTool[] {
  switch (operation) {
    case "recall":
      return memoryTools.filter(
        (t) =>
          t.function.name === "search_memories" ||
          t.function.name === "structured_query" ||
          t.function.name === "reject_operation"
      );
    case "process":
      // Process gets everything including ask_question
      return memoryTools;
    case "remember":
    case "forget":
      // Remember/forget get everything except ask_question
      return memoryTools.filter((t) => t.function.name !== "ask_question");
  }
}

function getModelForOperation(operation: MemoryOperation): string {
  switch (operation) {
    case "process":
      return MODEL_FULL;
    case "remember":
    case "forget":
    case "recall":
      return MODEL_FULL;
  }
}

export async function processMemoryOperation(
  operation: MemoryOperation,
  userMessage: string,
  tableSchema: string,
  tableName: string
): Promise<LLMResult> {
  const openai = getOpenAI();
  const systemPrompt = buildSystemPrompt(operation, tableSchema, tableName);
  const availableTools = getToolsForOperation(operation);
  const model = getModelForOperation(operation);

  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    tools: availableTools,
    tool_choice: "auto",
  });

  const message = response.choices[0].message;
  const toolCalls: ToolCall[] = [];

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      toolCalls.push({ name: tc.function.name, args } as ToolCall);
    }
  }

  return {
    toolCalls,
    textResponse: message.content,
  };
}

export async function processWithToolResults(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  operation: MemoryOperation,
  tableSchema: string,
  tableName: string
): Promise<LLMResult> {
  const openai = getOpenAI();
  const systemPrompt = buildSystemPrompt(operation, tableSchema, tableName);
  const availableTools = getToolsForOperation(operation);
  const model = getModelForOperation(operation);

  const fullMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  const response = await openai.chat.completions.create({
    model,
    messages: fullMessages,
    tools: availableTools,
    tool_choice: "auto",
  });

  const message = response.choices[0].message;
  const toolCalls: ToolCall[] = [];

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      toolCalls.push({ name: tc.function.name, args } as ToolCall);
    }
  }

  return {
    toolCalls,
    textResponse: message.content,
  };
}
