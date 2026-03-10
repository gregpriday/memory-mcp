import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the dependencies
vi.mock("../src/db.js", () => ({
  getTableSchema: vi.fn().mockResolvedValue(
    "CREATE TABLE test (id INTEGER PRIMARY KEY, memory TEXT, embedding FLOAT32(1536), created_at TEXT, category TEXT)"
  ),
  executeQuery: vi.fn().mockResolvedValue({ rows: [], lastInsertRowid: 1n }),
  getTableColumns: vi.fn().mockResolvedValue([
    { name: "id", type: "INTEGER" },
    { name: "memory", type: "TEXT" },
    { name: "embedding", type: "FLOAT32(1536)" },
    { name: "created_at", type: "TEXT" },
    { name: "category", type: "TEXT" },
  ]),
  getTableMeta: vi.fn().mockResolvedValue({ tableName: "test", embeddedFields: ["memory"] }),
  tableExists: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/embeddings.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
}));

vi.mock("openai", () => {
  const mockCreate = vi.fn();
  return {
    default: class {
      chat = { completions: { create: mockCreate } };
    },
    __mockCreate: mockCreate,
  };
});

describe("Memory operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
  });

  it("should handle a simple remember operation", async () => {
    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_0_0",
                type: "function",
                function: {
                  name: "insert_memory",
                  arguments: JSON.stringify({
                    memory: "User prefers dark mode",
                    fields: '{"category": "preferences"}',
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: "Memory stored: User prefers dark mode (category: preferences)",
            tool_calls: null,
          },
        },
      ],
    });

    const { handleMemoryOperation } = await import("../src/memory-ops.js");
    const result = await handleMemoryOperation(
      "remember",
      "Remember that the user prefers dark mode",
      "test"
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain("dark mode");
    expect(result.rejected).toBeUndefined();
  });

  it("should handle rejection with structured data", async () => {
    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_0_0",
                type: "function",
                function: {
                  name: "reject_operation",
                  arguments: JSON.stringify({
                    reason: "This memory is nonsensical and contains no meaningful information.",
                    category: "nonsensical",
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    const { handleMemoryOperation } = await import("../src/memory-ops.js");
    const result = await handleMemoryOperation(
      "remember",
      "Remember asdfghjkl",
      "test"
    );

    expect(result.success).toBe(false);
    expect(result.rejected).toBeDefined();
    expect(result.rejected!.reason).toContain("nonsensical");
    expect(result.rejected!.category).toBe("nonsensical");
    expect(result.message).toContain("rejected");
  });

  it("should handle rejection for duplicate memory", async () => {
    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_0_0",
                type: "function",
                function: {
                  name: "reject_operation",
                  arguments: JSON.stringify({
                    reason: "An identical memory already exists (ID #5).",
                    category: "duplicate",
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    const { handleMemoryOperation } = await import("../src/memory-ops.js");
    const result = await handleMemoryOperation(
      "remember",
      "Remember something that already exists",
      "test"
    );

    expect(result.success).toBe(false);
    expect(result.rejected!.category).toBe("duplicate");
  });

  it("should handle recall with no tool calls (direct response)", async () => {
    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: "No relevant memories found.",
            tool_calls: null,
          },
        },
      ],
    });

    const { handleMemoryOperation } = await import("../src/memory-ops.js");
    const result = await handleMemoryOperation(
      "recall",
      "What do I know about quantum physics?",
      "test"
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain("No relevant memories");
  });

  it("should handle multi-round tool calls", async () => {
    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_0_0",
                type: "function",
                function: {
                  name: "search_memories",
                  arguments: JSON.stringify({ search_text: "dark mode" }),
                },
              },
            ],
          },
        },
      ],
    });

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1_0",
                type: "function",
                function: {
                  name: "insert_memory",
                  arguments: JSON.stringify({
                    memory: "User switched from dark to light mode",
                    fields: '{"category": "preferences"}',
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: "Stored: User switched from dark to light mode",
            tool_calls: null,
          },
        },
      ],
    });

    const { handleMemoryOperation } = await import("../src/memory-ops.js");
    const result = await handleMemoryOperation(
      "remember",
      "User now prefers light mode instead of dark mode",
      "test"
    );

    expect(result.success).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });
});

describe("Process operation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
  });

  it("should collect questions during process and return them", async () => {
    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    // LLM first queries all memories, then asks questions
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_0_0",
                type: "function",
                function: {
                  name: "structured_query",
                  arguments: JSON.stringify({
                    filters: null,
                    order_by: { field: "created_at", direction: "desc" },
                    limit: null,
                    explanation: "Fetch all memories for review",
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: "I found some memories that could use refinement.",
            tool_calls: [
              {
                id: "call_1_0",
                type: "function",
                function: {
                  name: "ask_question",
                  arguments: JSON.stringify({
                    question: "Is the user still using dark mode?",
                    context: "Memory #1 says 'prefers dark mode' but it's 6 months old.",
                  }),
                },
              },
              {
                id: "call_1_1",
                type: "function",
                function: {
                  name: "ask_question",
                  arguments: JSON.stringify({
                    question: "What editor does the user primarily use?",
                    context: "Memory #3 mentions VS Code and #4 mentions Vim. Need clarification.",
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    const { handleMemoryOperation } = await import("../src/memory-ops.js");
    const result = await handleMemoryOperation(
      "process",
      "Review all memories and suggest improvements",
      "test"
    );

    expect(result.success).toBe(true);
    expect(result.questions).toBeDefined();
    expect(result.questions!.length).toBe(2);
    expect(result.questions![0].question).toContain("dark mode");
    expect(result.questions![1].question).toContain("editor");
    expect(result.questions![0].context).toContain("Memory #1");
  });

  it("should handle process with no questions needed", async () => {
    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: "All memories look good. No refinements needed.",
            tool_calls: null,
          },
        },
      ],
    });

    const { handleMemoryOperation } = await import("../src/memory-ops.js");
    const result = await handleMemoryOperation(
      "process",
      "Review all memories",
      "test"
    );

    expect(result.success).toBe(true);
    expect(result.questions).toBeUndefined();
    expect(result.message).toContain("No refinements needed");
  });

  it("should NOT execute mutations when ask_question appears in the same round", async () => {
    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;
    const { executeQuery } = await import("../src/db.js");

    // LLM asks a question AND tries to delete a memory in the same round
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_0_0",
                type: "function",
                function: {
                  name: "ask_question",
                  arguments: JSON.stringify({
                    question: "Is memory #2 still accurate?",
                    context: "Memory #2 looks outdated",
                  }),
                },
              },
              {
                id: "call_0_1",
                type: "function",
                function: {
                  name: "delete_memory",
                  arguments: JSON.stringify({ id: 2, reason: "Seems outdated" }),
                },
              },
            ],
          },
        },
      ],
    });

    const { handleMemoryOperation } = await import("../src/memory-ops.js");
    const result = await handleMemoryOperation(
      "process",
      "Review all memories",
      "test"
    );

    // Should stop immediately with questions, NOT execute the delete
    expect(result.success).toBe(true);
    expect(result.questions).toBeDefined();
    expect(result.questions!.length).toBe(1);
    // executeQuery should NOT have been called for a DELETE
    const calls = (executeQuery as ReturnType<typeof vi.fn>).mock.calls;
    const deleteCalls = calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).toUpperCase().startsWith("DELETE")
    );
    expect(deleteCalls.length).toBe(0);
  });
});

describe("Agentic loop edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
  });

  it("should treat max-round exhaustion with pending tool calls as failure", async () => {
    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    // Return tool calls every single round — never settles
    const neverSettles = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_x",
                type: "function",
                function: {
                  name: "structured_query",
                  arguments: JSON.stringify({
                    filters: null,
                    order_by: null,
                    limit: null,
                    explanation: "fetch all",
                  }),
                },
              },
            ],
          },
        },
      ],
    };
    // MAX_TOOL_ROUNDS=5 — initial call + 5 follow-up calls = 6 total LLM calls
    for (let i = 0; i < 7; i++) {
      mockCreate.mockResolvedValueOnce(neverSettles);
    }

    const { handleMemoryOperation } = await import("../src/memory-ops.js");
    const result = await handleMemoryOperation("recall", "find everything", "test");

    expect(result.success).toBe(false);
    expect(result.message).toContain("maximum tool-call rounds");
  });

  it("should catch rejection returned in the final round response", async () => {
    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    // Round 1: search
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_0_0",
                type: "function",
                function: {
                  name: "search_memories",
                  arguments: JSON.stringify({
                    search_text: "test",
                    limit: null,
                    sql_filter: null,
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    // Final LLM response after search: reject the operation
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1_0",
                type: "function",
                function: {
                  name: "reject_operation",
                  arguments: JSON.stringify({
                    reason: "An identical memory already exists (ID #1).",
                    category: "duplicate",
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    const { handleMemoryOperation } = await import("../src/memory-ops.js");
    const result = await handleMemoryOperation("remember", "remember something", "test");

    expect(result.success).toBe(false);
    expect(result.rejected).toBeDefined();
    expect(result.rejected!.category).toBe("duplicate");
  });
});
