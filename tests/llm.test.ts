import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock OpenAI
vi.mock("openai", () => {
  const mockCreate = vi.fn();
  return {
    default: class {
      chat = { completions: { create: mockCreate } };
    },
    __mockCreate: mockCreate,
  };
});

describe("LLM system prompts", () => {
  it("should build correct system prompt for remember operation", async () => {
    const { processMemoryOperation } = await import("../src/llm.js");

    process.env.OPENAI_API_KEY = "test-key";

    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: "I'll store this memory.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "insert_memory",
                  arguments: JSON.stringify({
                    memory: "User likes TypeScript",
                    fields: '{"category": "preferences"}',
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    const result = await processMemoryOperation(
      "remember",
      "Remember that the user likes TypeScript",
      "CREATE TABLE test (id INTEGER PRIMARY KEY, memory TEXT, embedding FLOAT32(1536), created_at TEXT, category TEXT)",
      "test"
    );

    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].name).toBe("insert_memory");

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[0].role).toBe("system");
    expect(callArgs.messages[0].content).toContain("STORE a new memory");
    expect(callArgs.messages[0].content).toContain("test");
    // Should use gpt-5 model
    expect(callArgs.model).toBe("gpt-5");
  });

  it("should only provide read-only tools for recall operation", async () => {
    const { processMemoryOperation } = await import("../src/llm.js");

    process.env.OPENAI_API_KEY = "test-key";

    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: "Here are the memories.",
            tool_calls: null,
          },
        },
      ],
    });

    await processMemoryOperation(
      "recall",
      "What do I know about TypeScript?",
      "CREATE TABLE test (id INTEGER PRIMARY KEY, memory TEXT, embedding FLOAT32(1536), created_at TEXT)",
      "test"
    );

    const callArgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];
    const toolNames = callArgs.tools.map(
      (t: any) => t.function.name
    );

    expect(toolNames).toContain("search_memories");
    expect(toolNames).toContain("structured_query");
    expect(toolNames).toContain("reject_operation");
    expect(toolNames).not.toContain("insert_memory");
    expect(toolNames).not.toContain("update_memory");
    expect(toolNames).not.toContain("delete_memory");
    expect(toolNames).not.toContain("ask_question");
  });

  it("should exclude ask_question for remember operation", async () => {
    const { processMemoryOperation } = await import("../src/llm.js");

    process.env.OPENAI_API_KEY = "test-key";

    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "search_memories",
                  arguments: JSON.stringify({ search_text: "TypeScript", limit: null, filters: null }),
                },
              },
            ],
          },
        },
      ],
    });

    await processMemoryOperation(
      "remember",
      "Remember: user likes TypeScript",
      "CREATE TABLE test (id INTEGER PRIMARY KEY, memory TEXT, embedding FLOAT32(1536), created_at TEXT)",
      "test"
    );

    const callArgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];
    const toolNames = callArgs.tools.map(
      (t: any) => t.function.name
    );

    expect(toolNames).toContain("search_memories");
    expect(toolNames).toContain("structured_query");
    expect(toolNames).toContain("insert_memory");
    expect(toolNames).toContain("update_memory");
    expect(toolNames).toContain("delete_memory");
    expect(toolNames).toContain("reject_operation");
    expect(toolNames).not.toContain("ask_question");
  });

  it("should include all tools including ask_question for process operation", async () => {
    const { processMemoryOperation } = await import("../src/llm.js");

    process.env.OPENAI_API_KEY = "test-key";

    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: "Reviewing memories...",
            tool_calls: null,
          },
        },
      ],
    });

    await processMemoryOperation(
      "process",
      "Review all memories",
      "CREATE TABLE test (id INTEGER PRIMARY KEY, memory TEXT, embedding FLOAT32(1536), created_at TEXT)",
      "test"
    );

    const callArgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];
    const toolNames = callArgs.tools.map(
      (t: any) => t.function.name
    );

    expect(toolNames).toContain("search_memories");
    expect(toolNames).toContain("structured_query");
    expect(toolNames).toContain("insert_memory");
    expect(toolNames).toContain("update_memory");
    expect(toolNames).toContain("delete_memory");
    expect(toolNames).toContain("reject_operation");
    expect(toolNames).toContain("ask_question");
    // Process prompt should mention PROCESS and REFINE
    expect(callArgs.messages[0].content).toContain("PROCESS and REFINE");
  });
});

describe("Tool call parsing", () => {
  it("should parse search_memories tool call with structured filters", async () => {
    const { processMemoryOperation } = await import("../src/llm.js");

    process.env.OPENAI_API_KEY = "test-key";

    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "search_memories",
                  arguments: JSON.stringify({
                    search_text: "user preferences",
                    limit: 5,
                    filters: [{ field: "category", operator: "eq", value: "preferences" }],
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    const result = await processMemoryOperation(
      "recall",
      "What are the user's preferences?",
      "CREATE TABLE test (id INTEGER PRIMARY KEY, memory TEXT, embedding FLOAT32(1536), created_at TEXT, category TEXT)",
      "test"
    );

    expect(result.toolCalls[0].name).toBe("search_memories");
    const args = result.toolCalls[0].args as {
      search_text: string;
      limit: number;
      filters: any[];
    };
    expect(args.search_text).toBe("user preferences");
    expect(args.limit).toBe(5);
    expect(args.filters[0].field).toBe("category");
    expect(args.filters[0].operator).toBe("eq");
    expect(args.filters[0].value).toBe("preferences");
  });

  it("search_memories strict schema should require limit and filters (as nullable)", async () => {
    const { processMemoryOperation } = await import("../src/llm.js");
    process.env.OPENAI_API_KEY = "test-key";
    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok", tool_calls: null } }],
    });

    await processMemoryOperation("recall", "test", "CREATE TABLE t (id INTEGER PRIMARY KEY, memory TEXT)", "t");

    const callArgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];
    const searchTool = callArgs.tools.find((t: any) => t.function.name === "search_memories");
    expect(searchTool.function.strict).toBe(true);
    expect(searchTool.function.parameters.required).toContain("limit");
    expect(searchTool.function.parameters.required).toContain("filters");
    expect(searchTool.function.parameters.properties.limit.type).toContain("null");
    expect(searchTool.function.parameters.properties.filters.type).toContain("null");
  });

  it("should have structured_query tool instead of sql_query", async () => {
    const { processMemoryOperation } = await import("../src/llm.js");
    process.env.OPENAI_API_KEY = "test-key";
    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok", tool_calls: null } }],
    });

    await processMemoryOperation("recall", "test", "CREATE TABLE t (id INTEGER PRIMARY KEY, memory TEXT)", "t");

    const callArgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];
    const toolNames = callArgs.tools.map((t: any) => t.function.name);

    expect(toolNames).toContain("structured_query");
    expect(toolNames).not.toContain("sql_query");
  });

  it("should handle reject_operation with category", async () => {
    const { processMemoryOperation } = await import("../src/llm.js");

    process.env.OPENAI_API_KEY = "test-key";

    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "reject_operation",
                  arguments: JSON.stringify({
                    reason: "The memory contradicts existing data",
                    category: "contradictory",
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    const result = await processMemoryOperation(
      "remember",
      "Remember something contradictory",
      "CREATE TABLE test (id INTEGER PRIMARY KEY, memory TEXT, embedding FLOAT32(1536), created_at TEXT)",
      "test"
    );

    expect(result.toolCalls[0].name).toBe("reject_operation");
    const args = result.toolCalls[0].args as { reason: string; category: string };
    expect(args.reason).toBe("The memory contradicts existing data");
    expect(args.category).toBe("contradictory");
  });

  it("should parse ask_question tool call", async () => {
    const { processMemoryOperation } = await import("../src/llm.js");

    process.env.OPENAI_API_KEY = "test-key";

    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "ask_question",
                  arguments: JSON.stringify({
                    question: "What is the user's preferred programming language?",
                    context: "Memory #3 mentions coding but doesn't specify a language",
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    const result = await processMemoryOperation(
      "process",
      "Review all memories",
      "CREATE TABLE test (id INTEGER PRIMARY KEY, memory TEXT, embedding FLOAT32(1536), created_at TEXT)",
      "test"
    );

    expect(result.toolCalls[0].name).toBe("ask_question");
    const args = result.toolCalls[0].args as { question: string; context: string };
    expect(args.question).toContain("preferred programming language");
    expect(args.context).toContain("Memory #3");
  });
});

describe("Rejection rules in system prompt", () => {
  it("should include detailed rejection rules in remember prompt", async () => {
    const { processMemoryOperation } = await import("../src/llm.js");

    process.env.OPENAI_API_KEY = "test-key";

    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok", tool_calls: null } }],
    });

    await processMemoryOperation(
      "remember",
      "test",
      "CREATE TABLE t (id INTEGER PRIMARY KEY, memory TEXT)",
      "t"
    );

    const callArgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];
    const systemPrompt = callArgs.messages[0].content;

    expect(systemPrompt).toContain("REJECTION RULES");
    expect(systemPrompt).toContain("nonsensical");
    expect(systemPrompt).toContain("contradicts");
    expect(systemPrompt).toContain("duplicate");
    expect(systemPrompt).toContain("insufficient detail");
    expect(systemPrompt).toContain("reject_operation");
  });

  it("should include structured filter documentation in system prompt", async () => {
    const { processMemoryOperation } = await import("../src/llm.js");

    process.env.OPENAI_API_KEY = "test-key";

    const OpenAI = await import("openai");
    const mockCreate = (OpenAI as any).__mockCreate;

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok", tool_calls: null } }],
    });

    await processMemoryOperation(
      "recall",
      "test",
      "CREATE TABLE t (id INTEGER PRIMARY KEY, memory TEXT)",
      "t"
    );

    const callArgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];
    const systemPrompt = callArgs.messages[0].content;

    expect(systemPrompt).toContain("Structured filters");
    expect(systemPrompt).toContain("search_memories");
    expect(systemPrompt).toContain("structured_query");
    expect(systemPrompt).toContain("operator");
  });
});
