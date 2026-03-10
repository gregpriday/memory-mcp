import OpenAI from "openai";
import { executeQuery, getTableSchema } from "./db.js";
import { generateEmbedding } from "./embeddings.js";
import {
  processMemoryOperation,
  processWithToolResults,
  type ToolCall,
  type LLMResult,
  type MemoryOperation,
} from "./llm.js";

const MAX_TOOL_ROUNDS = 5;

export interface MemoryRejection {
  reason: string;
  category: string;
}

export interface MemoryQuestion {
  question: string;
  context: string;
}

export interface MemoryResult {
  success: boolean;
  message: string;
  rejected?: MemoryRejection;
  questions?: MemoryQuestion[];
  data?: Record<string, unknown>[];
}

async function executeToolCall(
  toolCall: ToolCall,
  tableName: string
): Promise<string> {
  switch (toolCall.name) {
    case "search_memories": {
      const { search_text, sql_filter } = toolCall.args;
      const limit = toolCall.args.limit ?? 10;
      const embedding = await generateEmbedding(search_text);
      const vectorStr = JSON.stringify(embedding);

      // Fetch column list once to build SELECT (exclude embedding blob)
      const schemaResult = await executeQuery(`PRAGMA table_info(${tableName})`, []);
      const columns = schemaResult.rows
        .map((r) => r.name as string)
        .filter((c) => c !== "embedding");

      let sql = `
        SELECT ${columns.map((c) => `m.${c}`).join(", ")},
          vector_distance_cos(m.embedding, vector32(?)) AS distance
        FROM vector_top_k('idx_${tableName}_embedding', vector32(?), ?) AS v
        JOIN ${tableName} AS m ON m.rowid = v.id
      `;

      const queryArgs: (string | number)[] = [vectorStr, vectorStr, limit];

      if (sql_filter) {
        sql += ` WHERE ${sql_filter}`;
      }

      sql += " ORDER BY distance ASC";

      const result = await executeQuery(sql, queryArgs);
      return JSON.stringify(result.rows);
    }

    case "sql_query": {
      const { query } = toolCall.args;
      // Validate it's a SELECT query
      const trimmed = query.trim().toUpperCase();
      if (!trimmed.startsWith("SELECT")) {
        return JSON.stringify({
          error: "Only SELECT queries are allowed in sql_query.",
        });
      }
      const result = await executeQuery(query);
      return JSON.stringify(result.rows);
    }

    case "insert_memory": {
      const { memory, fields: fieldsStr } = toolCall.args;
      const fields = fieldsStr ? JSON.parse(fieldsStr) : {};

      // Generate embedding
      const embedding = await generateEmbedding(memory);
      const vectorStr = JSON.stringify(embedding);

      // Build insert
      const allFields: Record<string, string | number | null> = {
        memory,
        created_at: new Date().toISOString(),
        ...fields,
      };

      const columns = [...Object.keys(allFields), "embedding"];
      const placeholders = [
        ...Object.keys(allFields).map(() => "?"),
        "vector32(?)",
      ];
      const values = [...Object.values(allFields), vectorStr];

      const sql = `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`;
      const result = await executeQuery(sql, values as (string | number | null)[]);

      return JSON.stringify({
        success: true,
        id: Number(result.lastInsertRowid),
        message: "Memory inserted successfully.",
      });
    }

    case "update_memory": {
      const { id, memory, fields: fieldsStr } = toolCall.args;
      const fields = fieldsStr ? JSON.parse(fieldsStr) : {};

      const updates: string[] = [];
      const values: (string | number | null)[] = [];

      if (memory && memory.length > 0) {
        updates.push("memory = ?");
        values.push(memory);

        // Re-generate embedding
        const embedding = await generateEmbedding(memory);
        const vectorStr = JSON.stringify(embedding);
        updates.push("embedding = vector32(?)");
        values.push(vectorStr);
      }

      for (const [key, value] of Object.entries(fields)) {
        updates.push(`${key} = ?`);
        values.push(value as string | number | null);
      }

      if (updates.length === 0) {
        return JSON.stringify({ success: true, message: "Nothing to update." });
      }

      values.push(id);
      const sql = `UPDATE ${tableName} SET ${updates.join(", ")} WHERE id = ?`;
      await executeQuery(sql, values);

      return JSON.stringify({ success: true, message: "Memory updated successfully." });
    }

    case "delete_memory": {
      const { id } = toolCall.args;
      await executeQuery(`DELETE FROM ${tableName} WHERE id = ?`, [id]);
      return JSON.stringify({ success: true, message: "Memory deleted successfully." });
    }

    case "reject_operation": {
      return JSON.stringify({
        rejected: true,
        reason: toolCall.args.reason,
        category: toolCall.args.category,
      });
    }

    case "ask_question": {
      // Questions are collected and returned to the caller, not executed against DB
      return JSON.stringify({
        question_asked: true,
        question: toolCall.args.question,
        context: toolCall.args.context,
      });
    }
  }
}

function checkForRejection(toolCalls: ToolCall[]): MemoryResult | null {
  const rejection = toolCalls.find((tc) => tc.name === "reject_operation");
  if (!rejection) return null;
  const args = rejection.args as { reason: string; category: string };
  return {
    success: false,
    message: `Operation rejected: ${args.reason}`,
    rejected: { reason: args.reason, category: args.category },
  };
}

export async function handleMemoryOperation(
  operation: MemoryOperation,
  userMessage: string,
  tableName: string
): Promise<MemoryResult> {
  const tableSchema = await getTableSchema(tableName);

  // Initial LLM call
  let result = await processMemoryOperation(
    operation,
    userMessage,
    tableSchema,
    tableName
  );

  // Agentic loop: execute tool calls and feed results back
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const collectedQuestions: MemoryQuestion[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // No tool calls — we're done
    if (result.toolCalls.length === 0) {
      const memResult: MemoryResult = {
        success: true,
        message: result.textResponse || "Operation completed.",
      };
      if (collectedQuestions.length > 0) memResult.questions = collectedQuestions;
      return memResult;
    }

    // Check for rejection before executing anything
    const rejectionResult = checkForRejection(result.toolCalls);
    if (rejectionResult) return rejectionResult;

    // Collect questions from this round
    for (const tc of result.toolCalls) {
      if (tc.name === "ask_question") {
        const args = tc.args as { question: string; context: string };
        collectedQuestions.push({ question: args.question, context: args.context });
      }
    }

    // For process: if any questions were asked this round, stop before executing
    // any mutating tool calls. Return questions for the user to answer first.
    if (collectedQuestions.length > 0 && operation === "process") {
      return {
        success: true,
        message: result.textResponse || "Questions generated for memory processing.",
        questions: collectedQuestions,
      };
    }

    // Build the assistant message with tool calls
    const assistantMessage: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: result.textResponse || "",
      tool_calls: result.toolCalls.map((tc, i) => ({
        id: `call_${round}_${i}`,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.args),
        },
      })),
    };
    messages.push(assistantMessage);

    // Execute each tool call and collect results
    const toolResults: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];
    for (let i = 0; i < result.toolCalls.length; i++) {
      const tc = result.toolCalls[i];
      try {
        const toolResult = await executeToolCall(tc, tableName);
        toolResults.push({
          role: "tool",
          tool_call_id: `call_${round}_${i}`,
          content: toolResult,
        });
      } catch (error) {
        toolResults.push({
          role: "tool",
          tool_call_id: `call_${round}_${i}`,
          content: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    }

    messages.push(...toolResults);

    // Call LLM again with tool results
    result = await processWithToolResults(
      messages,
      operation,
      tableSchema,
      tableName
    );
  }

  // Rounds exhausted: inspect the final response before giving up
  const rejectionResult = checkForRejection(result.toolCalls);
  if (rejectionResult) return rejectionResult;

  if (result.toolCalls.length > 0) {
    // Still has unresolved tool calls — treat as incomplete/failure
    return {
      success: false,
      message: "Operation did not complete: maximum tool-call rounds reached without a final response.",
    };
  }

  const memResult: MemoryResult = {
    success: true,
    message: result.textResponse || "Operation completed.",
  };
  if (collectedQuestions.length > 0) memResult.questions = collectedQuestions;
  return memResult;
}

export async function handleProcessWithAnswers(
  tableName: string,
  originalQuestions: MemoryQuestion[],
  answers: string
): Promise<MemoryResult> {
  const questionsText = originalQuestions
    .map((q, i) => `Q${i + 1}: ${q.question}\n(Context: ${q.context})`)
    .join("\n\n");

  const userMessage = `I previously asked you these questions about the memories:\n\n${questionsText}\n\nHere are the answers:\n${answers}\n\nPlease now update, merge, or refine the memories based on these answers.`;

  return handleMemoryOperation("process", userMessage, tableName);
}
