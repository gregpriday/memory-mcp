import OpenAI from "openai";

export const MODEL_FULL = "gpt-5";
// MODEL_MINI available for lower-cost operations if needed in future
export const MODEL_MINI = "gpt-5-mini";

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

// Tool definitions for the LLM to use when processing memory operations
const memoryTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_memories",
      description:
        "Search for memories using semantic similarity (vector search). Use this when you need to find memories related to a concept, topic, or entity.",
      parameters: {
        type: "object",
        properties: {
          search_text: {
            type: "string",
            description:
              "The text to search for semantically. This will be converted to an embedding and compared against stored memories.",
          },
          limit: {
            type: ["number", "null"],
            description:
              "Maximum number of results to return. Pass null to use the default of 10.",
          },
          sql_filter: {
            type: ["string", "null"],
            description:
              "Optional SQL WHERE clause filter on exact column values (e.g., \"category = 'user_info'\"). Only equality and simple AND/OR comparisons on known columns are allowed. Do not include the WHERE keyword. Pass null for no filter.",
          },
        },
        required: ["search_text", "limit", "sql_filter"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "sql_query",
      description:
        "Execute a direct SQL SELECT query against the memories table. Use this for exact lookups, date-based queries, counting, or when you need precise filtering that vector search alone can't provide.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The full SQL SELECT query to execute. The table name will be provided in context. Only SELECT queries are allowed.",
          },
          explanation: {
            type: "string",
            description: "Brief explanation of what this query does.",
          },
        },
        required: ["query", "explanation"],
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
  | { name: "search_memories"; args: { search_text: string; limit?: number; sql_filter?: string } }
  | { name: "sql_query"; args: { query: string; explanation: string } }
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

function buildSystemPrompt(
  operation: MemoryOperation,
  tableSchema: string,
  tableName: string
): string {
  const baseContext = `You are a memory management assistant. You operate on a memories database table called "${tableName}".

Here is the table schema:
${tableSchema}

The table always has these core columns:
- id: INTEGER PRIMARY KEY (auto-increment)
- memory: TEXT (the main memory content)
- embedding: FLOAT32(1536) (vector embedding for semantic search - you don't need to set this, it's handled automatically)
- created_at: TEXT (ISO 8601 timestamp, set automatically on insert)

Any other columns in the schema are freeform fields that can be used to categorize and filter memories.`;

  switch (operation) {
    case "remember":
      return `${baseContext}

Your task is to STORE a new memory. The user will describe what they want to remember.

Instructions:
1. First, use search_memories to check if a similar memory already exists.
2. If a very similar memory exists, use update_memory to update it instead of creating a duplicate.
3. If the memory is new, use insert_memory to store it.
4. Extract any relevant field values from the user's description and populate the freeform fields.
5. Keep memory text concise but complete - capture the essential information.
6. After performing the operation, respond with a brief confirmation of what was done.

REJECTION RULES - You MUST reject the memory using reject_operation if ANY of these apply:
- The memory is nonsensical, garbled, or clearly not meaningful information
- The memory directly contradicts an existing memory without acknowledging the change
- The memory is an exact or near-exact duplicate of an existing one (use search first!)
- The memory contains insufficient detail to be useful when recalled later
- The memory appears to be test data, placeholder text, or junk content
- The memory is clearly inappropriate or harmful content

When rejecting, always provide a specific reason and category. A rejection is a valid and expected outcome.`;

    case "forget":
      return `${baseContext}

Your task is to REMOVE or MODIFY memories. The user will describe what they want to forget or change.

Instructions:
1. First, search for the relevant memories using search_memories or sql_query.
2. Identify which memories should be deleted or modified.
3. Use delete_memory to remove memories, or update_memory to modify them.
4. Be careful not to delete unrelated memories.
5. If the request is ambiguous, err on the side of caution and use reject_operation.
6. After performing the operation, respond with a brief confirmation of what was done.`;

    case "recall":
      return `${baseContext}

Your task is to RECALL memories. The user will describe what they want to remember. Do NOT modify any data.

Instructions:
1. Use search_memories for semantic search when the query is conceptual.
2. Use sql_query for precise lookups (by date, specific field values, counts, etc.).
3. You may combine both approaches for comprehensive results.
4. Present the recalled memories in a clear, useful format.
5. If no relevant memories are found, say so clearly.
6. Do NOT use insert_memory, update_memory, or delete_memory during a recall operation.`;

    case "process":
      return `${baseContext}

Your task is to PROCESS and REFINE existing memories. Review stored memories and improve their quality.

Instructions:
1. Start by recalling ALL memories using sql_query (SELECT * FROM ${tableName} ORDER BY created_at DESC).
2. Analyze the memories for:
   - Duplicates or near-duplicates that should be merged
   - Memories that are vague and could benefit from more detail
   - Memories that may be outdated or contradictory
   - Missing field values that could be inferred or asked about
   - Memories that could be better organized or categorized
3. Use ask_question to ask the user clarifying questions that would help improve memory quality.
   - Group related questions together rather than asking one at a time
   - Provide context about which memories the question relates to
   - Focus on the most impactful improvements first
4. Based on user answers (provided as follow-up context), use update_memory to refine memories or delete_memory to remove duplicates/outdated entries.
5. You may also use insert_memory if the user's answers reveal new information worth storing.
6. After processing, summarize what was changed, merged, or deleted.

The goal is to maintain a clean, high-quality memory store with no redundancy and maximum usefulness.`;
  }
}

function getToolsForOperation(operation: MemoryOperation): OpenAI.Chat.Completions.ChatCompletionTool[] {
  switch (operation) {
    case "recall":
      return memoryTools.filter(
        (t) =>
          t.function.name === "search_memories" ||
          t.function.name === "sql_query" ||
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
      return MODEL_FULL; // Full model for the complex analysis in process
    case "remember":
    case "forget":
    case "recall":
      return MODEL_FULL; // Full model for all operations since token costs are not significant
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
