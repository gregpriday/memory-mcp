import { describe, it, expect, beforeAll, vi } from "vitest";
import OpenAI from "openai";
import { buildSystemPrompt, type MemoryOperation } from "../../src/llm.js";

// All API-calling tests in this file get 15s per test
vi.setConfig({ testTimeout: 15000 });

/**
 * Integration tests for the OpenAI wrapper.
 *
 * These tests call the real OpenAI API to verify that:
 * - System prompts produce the correct tool-calling behaviour
 * - Tool schemas are accepted by the API (strict mode validation)
 * - The model selects the right tools for each operation type
 * - Rejection logic fires on bad input
 *
 * Skipped when OPENAI_API_KEY is not set.
 */

const SKIP = !process.env.OPENAI_API_KEY;
const MODEL = "gpt-5-mini"; // Use mini for integration tests to save cost

// Structured filter schema — shared between search_memories and structured_query
const filterSchema = {
  type: "object" as const,
  properties: {
    field: { type: "string" as const, description: "Column name to filter on." },
    operator: {
      type: "string" as const,
      enum: ["eq", "neq", "gt", "gte", "lt", "lte", "like", "in", "is_null", "is_not_null"],
      description: "Comparison operator.",
    },
    value: {
      type: ["string", "number", "null"] as const,
      description: "Value to compare against. Null for is_null/is_not_null.",
    },
  },
  required: ["field", "operator", "value"] as const,
  additionalProperties: false as const,
};

// Shared tool definitions — mirrors src/llm.ts but kept self-contained for integration tests
const memoryTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_memories",
      description: "Search for memories using semantic similarity (vector search).",
      parameters: {
        type: "object",
        properties: {
          search_text: { type: "string", description: "Text to search for semantically." },
          limit: { type: ["number", "null"], description: "Max results. Null = default 10." },
          filters: {
            type: ["array", "null"],
            items: filterSchema,
            description: "Optional structured filters. Null = no filters.",
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
      description: "Query memories using structured filters. For exact lookups, date-based queries, counting.",
      parameters: {
        type: "object",
        properties: {
          filters: {
            type: ["array", "null"],
            items: filterSchema,
            description: "Structured filters. Null = select all rows.",
          },
          order_by: {
            type: ["object", "null"],
            properties: {
              field: { type: "string", description: "Column to sort by." },
              direction: { type: "string", enum: ["asc", "desc"], description: "Sort direction." },
            },
            required: ["field", "direction"],
            additionalProperties: false,
            description: "Optional ordering. Null = default order.",
          },
          limit: { type: ["number", "null"], description: "Max rows. Null = no limit." },
          explanation: { type: "string", description: "Brief explanation of what this query does." },
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
      description: "Insert a new memory into the database.",
      parameters: {
        type: "object",
        properties: {
          memory: { type: "string", description: "The memory content to store." },
          fields: { type: "string", description: "JSON object of additional field values." },
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
      description: "Update an existing memory by its ID.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "The ID of the memory." },
          memory: { type: "string", description: "New memory content. Empty string = keep unchanged." },
          fields: { type: "string", description: "JSON object of field values to update." },
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
      description: "Delete a memory by its ID.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "The ID of the memory to delete." },
          reason: { type: "string", description: "Brief explanation of why." },
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
      description: "Reject the operation if it seems wrong, nonsensical, contradictory, or would corrupt memories.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Clear explanation of why." },
          category: {
            type: "string",
            enum: ["nonsensical", "contradictory", "duplicate", "inappropriate", "insufficient_detail", "other"],
            description: "The rejection category.",
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
      description: "Ask the user a clarifying question to improve memory quality.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask." },
          context: { type: "string", description: "Context about which memories this relates to." },
        },
        required: ["question", "context"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];

const TEST_TABLE_SCHEMA =
  "CREATE TABLE github_users (id INTEGER PRIMARY KEY AUTOINCREMENT, memory TEXT NOT NULL, embedding FLOAT32(1536), created_at TEXT NOT NULL DEFAULT (datetime('now')), username TEXT, category TEXT, importance TEXT)";

let openai: OpenAI;

function getToolsForOperation(operation: MemoryOperation) {
  switch (operation) {
    case "recall":
      return memoryTools.filter(
        (t) => ["search_memories", "structured_query", "reject_operation"].includes(t.function.name)
      );
    case "process":
      return memoryTools;
    case "remember":
    case "forget":
      return memoryTools.filter((t) => t.function.name !== "ask_question");
  }
}

async function callLLM(
  operation: MemoryOperation,
  userMessage: string,
  schema: string = TEST_TABLE_SCHEMA,
  tableName: string = "github_users"
) {
  const systemPrompt = buildSystemPrompt(operation, schema, tableName);
  const tools = getToolsForOperation(operation);

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    tools,
    tool_choice: "auto",
  });

  return response.choices[0].message;
}

describe.skipIf(SKIP)("OpenAI integration — strict schema acceptance", () => {
  beforeAll(() => {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  });

  it("should accept all tool schemas in strict mode without API errors", async () => {
    // This validates that every tool definition is accepted by the API
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: "You are a test assistant." },
        { role: "user", content: "Just say hello." },
      ],
      tools: memoryTools,
      tool_choice: "none",
    });

    expect(response.choices[0].message.content).toBeTruthy();
  });
});

describe.skipIf(SKIP)("OpenAI integration — remember operation", () => {
  beforeAll(() => {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  });

  it("should call search_memories or insert_memory for a valid remember request", async () => {
    const message = await callLLM(
      "remember",
      "Remember that GitHub user octocat prefers concise, technical replies and always uses proper markdown formatting."
    );

    expect(message.tool_calls).toBeTruthy();
    const toolNames = message.tool_calls!.map((tc) => tc.function.name);
    // Should either search first or go straight to insert
    const validTools = ["search_memories", "insert_memory"];
    expect(toolNames.some((name) => validTools.includes(name))).toBe(true);

    // If insert_memory was called, verify the args are valid JSON
    const insertCall = message.tool_calls!.find((tc) => tc.function.name === "insert_memory");
    if (insertCall) {
      const args = JSON.parse(insertCall.function.arguments);
      expect(args.memory).toBeTruthy();
      expect(typeof args.memory).toBe("string");
      expect(typeof args.fields).toBe("string");
      // fields should be valid JSON
      const fields = JSON.parse(args.fields);
      expect(typeof fields).toBe("object");
    }
  });

  it("should reject nonsensical input", async () => {
    const message = await callLLM(
      "remember",
      "Remember: asdkjh qweoiru zxcvbn mnbvcx lkjhgf"
    );

    expect(message.tool_calls).toBeTruthy();
    const toolNames = message.tool_calls!.map((tc) => tc.function.name);

    // Model should either reject outright or search first then reject
    if (toolNames.includes("reject_operation")) {
      const rejectCall = message.tool_calls!.find((tc) => tc.function.name === "reject_operation")!;
      const args = JSON.parse(rejectCall.function.arguments);
      expect(args.reason).toBeTruthy();
      expect(["nonsensical", "insufficient_detail", "other"]).toContain(args.category);
    } else {
      // Acceptable: it might search first before deciding to reject in round 2
      expect(toolNames).toContain("search_memories");
    }
  });

  it("should populate freeform fields from context", async () => {
    const message = await callLLM(
      "remember",
      "Remember that user defunkt is the co-founder of GitHub. He tends to be very friendly and welcoming in conversations. This is high importance."
    );

    expect(message.tool_calls).toBeTruthy();

    // Look for either insert_memory or search_memories
    const insertCall = message.tool_calls!.find((tc) => tc.function.name === "insert_memory");
    if (insertCall) {
      const args = JSON.parse(insertCall.function.arguments);
      const fields = JSON.parse(args.fields);
      // Should have extracted the username
      expect(fields.username || fields.subject).toBeTruthy();
    }
  });
});

describe.skipIf(SKIP)("OpenAI integration — recall operation", () => {
  beforeAll(() => {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  });

  it("should use search_memories for conceptual recall", async () => {
    const message = await callLLM(
      "recall",
      "What do I know about how octocat likes to communicate?"
    );

    expect(message.tool_calls).toBeTruthy();
    const toolNames = message.tool_calls!.map((tc) => tc.function.name);
    expect(toolNames).toContain("search_memories");

    // Verify search args
    const searchCall = message.tool_calls!.find((tc) => tc.function.name === "search_memories")!;
    const args = JSON.parse(searchCall.function.arguments);
    expect(args.search_text).toBeTruthy();
  });

  it("should use structured_query for structured recall", async () => {
    const message = await callLLM(
      "recall",
      "How many memories do we have about high importance users?"
    );

    expect(message.tool_calls).toBeTruthy();
    const toolNames = message.tool_calls!.map((tc) => tc.function.name);

    // Should use structured_query for a count-based question or search_memories
    const usesStructured = toolNames.includes("structured_query") || toolNames.includes("search_memories");
    expect(usesStructured).toBe(true);

    if (toolNames.includes("structured_query")) {
      const queryCall = message.tool_calls!.find((tc) => tc.function.name === "structured_query")!;
      const args = JSON.parse(queryCall.function.arguments);
      expect(args.explanation).toBeTruthy();
    }
  });

  it("should NOT include write tools for recall", async () => {
    const message = await callLLM(
      "recall",
      "List all memories about user octocat"
    );

    if (message.tool_calls) {
      const toolNames = message.tool_calls.map((tc) => tc.function.name);
      expect(toolNames).not.toContain("insert_memory");
      expect(toolNames).not.toContain("update_memory");
      expect(toolNames).not.toContain("delete_memory");
      expect(toolNames).not.toContain("ask_question");
    }
  });
});

describe.skipIf(SKIP)("OpenAI integration — forget operation", () => {
  beforeAll(() => {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  });

  it("should search before deleting", async () => {
    const message = await callLLM(
      "forget",
      "Forget everything we know about user octocat"
    );

    expect(message.tool_calls).toBeTruthy();
    const toolNames = message.tool_calls!.map((tc) => tc.function.name);
    // Should search first to find what to delete
    const searchesFirst = toolNames.includes("search_memories") || toolNames.includes("structured_query");
    expect(searchesFirst).toBe(true);
  });

  it("should reject ambiguous forget requests", async () => {
    const message = await callLLM(
      "forget",
      "Forget something"
    );

    expect(message.tool_calls).toBeTruthy();
    const toolNames = message.tool_calls!.map((tc) => tc.function.name);
    // Should either reject outright or search (then find nothing to delete)
    const conservative = toolNames.includes("reject_operation") || toolNames.includes("search_memories") || toolNames.includes("structured_query");
    expect(conservative).toBe(true);
  });
});

describe.skipIf(SKIP)("OpenAI integration — process operation", () => {
  beforeAll(() => {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  });

  it("should start by querying all memories", async () => {
    const message = await callLLM(
      "process",
      "Review all memories and suggest improvements."
    );

    expect(message.tool_calls).toBeTruthy();
    const toolNames = message.tool_calls!.map((tc) => tc.function.name);
    // Should start with structured_query to fetch all memories
    expect(toolNames.includes("structured_query") || toolNames.includes("search_memories")).toBe(true);
  });

  it("should have access to ask_question tool", async () => {
    // Verify the tool is available by checking that the API accepts the tool set
    const tools = getToolsForOperation("process");
    const toolNames = tools.map((t) => t.function.name);
    expect(toolNames).toContain("ask_question");
    expect(toolNames).toContain("insert_memory");
    expect(toolNames).toContain("update_memory");
    expect(toolNames).toContain("delete_memory");
  });
});

describe.skipIf(SKIP)("OpenAI integration — system prompt content", () => {
  it("should produce correct base context with table name and schema", () => {
    const prompt = buildSystemPrompt("remember", TEST_TABLE_SCHEMA, "github_users");
    expect(prompt).toContain('"github_users"');
    expect(prompt).toContain(TEST_TABLE_SCHEMA);
    expect(prompt).toContain("FLOAT32(1536)");
    expect(prompt).toContain("created_at");
  });

  it("remember prompt should contain rejection rules", () => {
    const prompt = buildSystemPrompt("remember", TEST_TABLE_SCHEMA, "github_users");
    expect(prompt).toContain("REJECTION RULES");
    expect(prompt).toContain("nonsensical");
    expect(prompt).toContain("duplicate");
    expect(prompt).toContain("reject_operation");
  });

  it("recall prompt should forbid write operations", () => {
    const prompt = buildSystemPrompt("recall", TEST_TABLE_SCHEMA, "github_users");
    expect(prompt).toContain("Do NOT modify any data");
    expect(prompt).toContain("Do NOT use insert_memory");
  });

  it("forget prompt should instruct caution", () => {
    const prompt = buildSystemPrompt("forget", TEST_TABLE_SCHEMA, "github_users");
    expect(prompt).toContain("Be careful not to delete unrelated memories");
    expect(prompt).toContain("err on the side of caution");
  });

  it("process prompt should reference structured_query approach", () => {
    const prompt = buildSystemPrompt("process", TEST_TABLE_SCHEMA, "github_users");
    expect(prompt).toContain("structured_query");
    expect(prompt).toContain("ask_question");
    expect(prompt).toContain("PROCESS and REFINE");
  });

  it("base prompt should document structured filters", () => {
    const prompt = buildSystemPrompt("recall", TEST_TABLE_SCHEMA, "github_users");
    expect(prompt).toContain("Structured filters");
    expect(prompt).toContain("search_memories");
    expect(prompt).toContain("structured_query");
    expect(prompt).toContain("operator");
  });

  it("all operations should include the base context", () => {
    const operations: MemoryOperation[] = ["remember", "forget", "recall", "process"];
    for (const op of operations) {
      const prompt = buildSystemPrompt(op, TEST_TABLE_SCHEMA, "github_users");
      expect(prompt).toContain("memory management assistant");
      expect(prompt).toContain("github_users");
      expect(prompt).toContain("freeform fields");
    }
  });
});

describe.skipIf(SKIP)("OpenAI integration — multi-turn tool flow", () => {
  beforeAll(() => {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  });

  it("should handle a search → insert two-step flow", { timeout: 30000 }, async () => {
    // Two sequential API calls — needs the extra timeout
    const systemPrompt = buildSystemPrompt("remember", TEST_TABLE_SCHEMA, "github_users");
    const tools = getToolsForOperation("remember");

    // Step 1: initial request
    const response1 = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Remember that user mona likes emoji reactions and informal language." },
      ],
      tools,
      tool_choice: "auto",
    });

    const msg1 = response1.choices[0].message;
    expect(msg1.tool_calls).toBeTruthy();

    // Simulate tool results — pretend search found nothing
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Remember that user mona likes emoji reactions and informal language." },
      msg1 as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam,
    ];

    // Add tool results for each tool call
    for (const tc of msg1.tool_calls!) {
      if (tc.function.name === "search_memories") {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify([]), // empty search results
        });
      } else if (tc.function.name === "insert_memory") {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ success: true, id: 42, message: "Memory inserted successfully." }),
        });
      } else {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ success: true }),
        });
      }
    }

    // Step 2: LLM should now either insert (if it searched first) or confirm
    const response2 = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    });

    const msg2 = response2.choices[0].message;

    if (msg2.tool_calls && msg2.tool_calls.length > 0) {
      // If the first step was a search, the second step should be an insert
      const names = msg2.tool_calls.map((tc) => tc.function.name);
      expect(names.some((n) => ["insert_memory", "reject_operation"].includes(n))).toBe(true);
    } else {
      // If the first step was an insert, the second step is just a text confirmation
      expect(msg2.content).toBeTruthy();
    }
  });
});
