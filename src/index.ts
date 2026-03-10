#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { handleMemoryOperation, handleProcessWithAnswers, type MemoryResult } from "./memory-ops.js";
import { tableExists } from "./db.js";

const server = new McpServer({
  name: "memory-mcp",
  version: "0.1.0",
});

async function validateTable(table: string): Promise<string | null> {
  const exists = await tableExists(table);
  if (!exists) {
    return `Table '${table}' does not exist. Use the setup-table command to create it first.`;
  }
  return null;
}

function formatResult(result: MemoryResult): { content: { type: "text"; text: string }[]; isError?: boolean } {
  const parts: string[] = [];

  if (result.rejected) {
    parts.push(`REJECTED [${result.rejected.category}]: ${result.rejected.reason}`);
  } else if (!result.success) {
    parts.push(`ERROR: ${result.message}`);
  } else {
    parts.push(result.message);
  }

  if (result.questions && result.questions.length > 0) {
    parts.push("\n--- Questions for memory refinement ---");
    for (const q of result.questions) {
      parts.push(`\nQ: ${q.question}`);
      parts.push(`   Context: ${q.context}`);
    }
    parts.push("\nCall the process tool again with your answers in the context field.");
  }

  return {
    content: [{ type: "text", text: parts.join("\n") }],
    ...((!result.success && !result.rejected) ? { isError: true } : {}),
  };
}

server.tool(
  "remember",
  "Store a new memory. Describe what you want to remember in plain English. The system will figure out how to store it based on the table structure.",
  {
    table: z.string().describe("The memory table to store into"),
    memory: z
      .string()
      .describe(
        "Plain English description of what to remember. Include all relevant details - who, what, when, context, etc."
      ),
  },
  async (args) => {
    const error = await validateTable(args.table);
    if (error) {
      return { content: [{ type: "text", text: error }] };
    }

    try {
      const result = await handleMemoryOperation("remember", args.memory, args.table);
      return formatResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("remember error:", msg);
      return { content: [{ type: "text", text: `Error storing memory: ${msg}` }] };
    }
  }
);

server.tool(
  "forget",
  "Delete or modify existing memories. Describe what you want to forget or change in plain English.",
  {
    table: z.string().describe("The memory table to modify"),
    description: z
      .string()
      .describe(
        "Plain English description of what to forget or change. Be specific about which memories to target."
      ),
  },
  async (args) => {
    const error = await validateTable(args.table);
    if (error) {
      return { content: [{ type: "text", text: error }] };
    }

    try {
      const result = await handleMemoryOperation("forget", args.description, args.table);
      return formatResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("forget error:", msg);
      return { content: [{ type: "text", text: `Error modifying memory: ${msg}` }] };
    }
  }
);

server.tool(
  "recall",
  "Recall memories without modifying them. Describe what you want to remember in plain English.",
  {
    table: z.string().describe("The memory table to search"),
    query: z
      .string()
      .describe(
        "Plain English description of what you want to recall. Can be a topic, a person, a time period, etc."
      ),
  },
  async (args) => {
    const error = await validateTable(args.table);
    if (error) {
      return { content: [{ type: "text", text: error }] };
    }

    try {
      const result = await handleMemoryOperation("recall", args.query, args.table);
      return formatResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("recall error:", msg);
      return { content: [{ type: "text", text: `Error recalling memories: ${msg}` }] };
    }
  }
);

server.tool(
  "process",
  "Review and refine existing memories. Analyzes all stored memories for quality, duplicates, and gaps, then asks clarifying questions. Call again with answers to apply refinements.",
  {
    table: z.string().describe("The memory table to process"),
    context: z
      .string()
      .optional()
      .describe(
        "Optional context or focus area for processing (e.g., 'focus on user preferences' or 'clean up old entries'). When following up on questions, provide the answers here."
      ),
  },
  async (args) => {
    const error = await validateTable(args.table);
    if (error) {
      return { content: [{ type: "text", text: error }] };
    }

    try {
      const message = args.context || "Review all memories and suggest improvements.";
      const result = await handleMemoryOperation("process", message, args.table);
      return formatResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("process error:", msg);
      return { content: [{ type: "text", text: `Error processing memories: ${msg}` }] };
    }
  }
);

server.tool(
  "process_answers",
  "Provide answers to questions raised by the process tool. Pass the original questions and your answers; the system will apply memory refinements based on the answers.",
  {
    table: z.string().describe("The memory table being processed"),
    questions: z
      .array(
        z.object({
          question: z.string(),
          context: z.string(),
        })
      )
      .describe("The questions returned by the previous process call"),
    answers: z
      .string()
      .describe("Your answers to the questions, in plain English"),
  },
  async (args) => {
    const error = await validateTable(args.table);
    if (error) {
      return { content: [{ type: "text", text: error }] };
    }

    try {
      const result = await handleProcessWithAnswers(
        args.table,
        args.questions,
        args.answers
      );
      return formatResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("process_answers error:", msg);
      return {
        content: [{ type: "text", text: `Error applying process answers: ${msg}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Memory MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
