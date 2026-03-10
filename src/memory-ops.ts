import OpenAI from "openai";
import { executeQuery, getTableSchema, getTableColumns, getTableMeta } from "./db.js";
import { generateEmbedding } from "./embeddings.js";
import {
  processMemoryOperation,
  processWithToolResults,
  type ToolCall,
  type LLMResult,
  type MemoryOperation,
} from "./llm.js";
import {
  buildSelectQuery,
  buildVectorSearchQuery,
  type QueryFilter,
} from "./query-builder.js";

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

/**
 * Build the text to embed from multiple fields.
 * Concatenates field values with labels for context.
 * Example: "title: My Project\nbody: A description of the project"
 */
function buildEmbeddingText(
  embeddedFields: string[],
  fieldValues: Record<string, string | number | null>
): string {
  if (embeddedFields.length === 1) {
    // Single field — just use its value directly
    const value = fieldValues[embeddedFields[0]];
    return value != null ? String(value) : "";
  }

  // Multiple fields — concatenate with labels
  const parts: string[] = [];
  for (const field of embeddedFields) {
    const value = fieldValues[field];
    if (value != null && String(value).length > 0) {
      parts.push(`${field}: ${value}`);
    }
  }
  return parts.join("\n");
}

async function getValidColumns(tableName: string): Promise<string[]> {
  const columns = await getTableColumns(tableName);
  return columns.map((c) => c.name).filter((c) => c !== "embedding");
}

async function executeToolCall(
  toolCall: ToolCall,
  tableName: string
): Promise<string> {
  switch (toolCall.name) {
    case "search_memories": {
      const { search_text, filters } = toolCall.args;
      const limit = toolCall.args.limit ?? 10;
      const embedding = await generateEmbedding(search_text);
      const vectorStr = JSON.stringify(embedding);

      const validColumns = await getValidColumns(tableName);

      const parsedFilters: QueryFilter[] | undefined =
        filters && filters.length > 0 ? filters : undefined;

      const query = buildVectorSearchQuery(
        tableName,
        validColumns,
        vectorStr,
        limit,
        parsedFilters,
        validColumns
      );

      const result = await executeQuery(query.sql, query.params);
      return JSON.stringify(result.rows);
    }

    case "structured_query": {
      const { filters, order_by, limit } = toolCall.args;
      const validColumns = await getValidColumns(tableName);

      const query = buildSelectQuery(
        tableName,
        validColumns,
        {
          filters: filters ?? undefined,
          order_by: order_by ?? undefined,
          limit: limit ?? undefined,
        },
        validColumns
      );

      const result = await executeQuery(query.sql, query.params);
      return JSON.stringify(result.rows);
    }

    case "insert_memory": {
      const { memory, fields: fieldsStr } = toolCall.args;
      const fields = fieldsStr ? JSON.parse(fieldsStr) : {};

      // Get embedded fields config to determine what to embed
      const meta = await getTableMeta(tableName);
      const allFieldValues: Record<string, string | number | null> = {
        memory,
        ...fields,
      };

      // Generate embedding from the configured fields
      const embeddingText = buildEmbeddingText(meta.embeddedFields, allFieldValues);
      const embedding = await generateEmbedding(embeddingText);
      const vectorStr = JSON.stringify(embedding);

      // Build insert
      const insertFields: Record<string, string | number | null> = {
        memory,
        created_at: new Date().toISOString(),
        ...fields,
      };

      const columns = [...Object.keys(insertFields), "embedding"];
      const placeholders = [
        ...Object.keys(insertFields).map(() => "?"),
        "vector32(?)",
      ];
      const values = [...Object.values(insertFields), vectorStr];

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
      }

      for (const [key, value] of Object.entries(fields)) {
        updates.push(`${key} = ?`);
        values.push(value as string | number | null);
      }

      // Re-generate embedding if any embedded fields changed
      if (memory && memory.length > 0) {
        const meta = await getTableMeta(tableName);

        // Fetch current row to get all embedded field values
        const currentRow = await executeQuery(
          `SELECT * FROM ${tableName} WHERE id = ?`,
          [id]
        );

        if (currentRow.rows.length > 0) {
          const currentValues = currentRow.rows[0] as Record<string, unknown>;
          const allFieldValues: Record<string, string | number | null> = {};

          for (const ef of meta.embeddedFields) {
            if (ef === "memory") {
              allFieldValues[ef] = memory; // Use new memory value
            } else if (ef in fields) {
              allFieldValues[ef] = fields[ef] as string | number | null;
            } else {
              allFieldValues[ef] = currentValues[ef] as string | number | null;
            }
          }

          const embeddingText = buildEmbeddingText(meta.embeddedFields, allFieldValues);
          const embedding = await generateEmbedding(embeddingText);
          const vectorStr = JSON.stringify(embedding);
          updates.push("embedding = vector32(?)");
          values.push(vectorStr);
        }
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
