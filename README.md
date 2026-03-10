# Memory MCP

A Model Context Protocol (MCP) server that gives AI assistants persistent, semantic memory. Backed by [Turso](https://turso.tech) (libSQL) for storage with vector search, and [OpenAI](https://openai.com) for embeddings and LLM-powered query generation.

All interactions are in plain English. The server uses GPT-5 with function calling to translate natural language into the right database operations automatically.

## Features

- **Remember** — Store new memories with automatic duplicate detection, field extraction, and quality validation
- **Forget** — Remove or modify memories by describing what to change
- **Recall** — Search memories semantically or with structured queries, without modifying data
- **Process** — Review and refine stored memories: merge duplicates, fill gaps, ask clarifying questions
- **Rejection system** — The LLM will reject nonsensical, duplicate, contradictory, or low-quality memories with a structured reason and category
- **Vector search** — Semantic similarity search using OpenAI embeddings (text-embedding-3-small, 1536 dimensions) with libSQL DiskANN indexes
- **Table isolation** — Each use case gets its own table with custom freeform columns, all in one database
- **Claude Code integration** — Slash commands for table management (`/setup-table`, `/list-tables`, `/drop-table`)

## How It Works

```
┌─────────────┐     plain English      ┌─────────────┐     function calls     ┌───────────┐
│  MCP Client │ ──────────────────────► │   GPT-5     │ ──────────────────────► │  Turso DB │
│  (Claude)   │ ◄────────────────────── │  + prompts  │ ◄────────────────────── │  (libSQL) │
└─────────────┘     structured result   └─────────────┘     SQL + vectors      └───────────┘
```

1. The MCP client sends a plain English request (e.g., "remember that user octocat prefers concise replies")
2. The server loads the table schema and builds a system prompt with operation-specific instructions
3. GPT-5 decides which internal tools to call (search, insert, update, delete, reject, or ask questions)
4. An agentic loop executes tool calls against Turso, feeds results back to the LLM, and repeats for up to 5 rounds
5. The final response is returned to the MCP client with success/rejection/questions status

## Architecture

```
src/
├── index.ts           # MCP server entry point — tool definitions
├── llm.ts             # OpenAI wrapper — models, tool schemas, prompt loading
├── memory-ops.ts      # Agentic loop — tool execution, rejection, questions
├── db.ts              # Turso/libSQL client — queries, schema inspection
├── embeddings.ts      # OpenAI embeddings — text-embedding-3-small
├── table-setup.ts     # Table lifecycle — create, drop, list
└── prompts/
    ├── base.txt       # Shared context (table schema, column descriptions)
    ├── remember.txt   # Store operation instructions + rejection rules
    ├── forget.txt     # Delete/modify operation instructions
    ├── recall.txt     # Read-only search instructions
    └── process.txt    # Memory refinement and question-asking instructions
```

System prompts are stored as plain text files for easy editing and version control. They use `{{TABLE_NAME}}` and `{{TABLE_SCHEMA}}` placeholders that are replaced at runtime.

## Requirements

- Node.js 18+
- A [Turso](https://turso.tech) database (or any libSQL-compatible endpoint)
- An [OpenAI](https://platform.openai.com) API key

## Installation

```bash
git clone <repo-url>
cd memory
npm install
npm run build
```

## Environment Variables

Create a `.env` file (see `.env.example`):

```
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-turso-auth-token
OPENAI_API_KEY=sk-your-openai-api-key
```

## Creating Memory Tables

Each use case needs its own table. Use the Claude Code `/setup-table` command for an interactive setup, or create tables programmatically:

```typescript
import { createMemoryTable } from "./src/table-setup.js";

await createMemoryTable("github_users", [
  { name: "username", type: "TEXT" },
  { name: "category", type: "TEXT" },
  { name: "importance", type: "TEXT" },
]);
```

Every table automatically gets these core columns:

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | Auto-incrementing ID |
| `memory` | TEXT NOT NULL | The memory content |
| `embedding` | FLOAT32(1536) | Vector embedding for semantic search |
| `created_at` | TEXT NOT NULL | ISO 8601 timestamp |

Plus whatever freeform columns you define (TEXT, INTEGER, or REAL).

## MCP Server Configuration

Add to your Claude Code MCP config (`.claude/mcp.json` or similar):

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/memory-mcp/build/index.js"],
      "env": {
        "TURSO_DATABASE_URL": "libsql://your-db.turso.io",
        "TURSO_AUTH_TOKEN": "your-token",
        "OPENAI_API_KEY": "sk-your-key"
      }
    }
  }
}
```

## Tool Reference

### `remember`

Store a new memory. The LLM searches for duplicates first, extracts freeform field values from context, and can reject bad input.

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | string | The memory table to store into |
| `memory` | string | Plain English description of what to remember |

**Rejection categories:** `nonsensical`, `contradictory`, `duplicate`, `inappropriate`, `insufficient_detail`, `other`

### `forget`

Delete or modify existing memories. Searches first, then removes or updates matching entries.

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | string | The memory table to modify |
| `description` | string | Plain English description of what to forget or change |

### `recall`

Read-only memory retrieval. Can use semantic vector search, SQL queries, or both.

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | string | The memory table to search |
| `query` | string | Plain English description of what to recall |

### `process`

Review and refine existing memories. Analyzes for duplicates, gaps, and outdated entries. Returns clarifying questions for the user.

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | string | The memory table to process |
| `context` | string? | Optional focus area or instructions |

### `process_answers`

Follow-up to `process`. Provide answers to the questions it raised, and the system applies the refinements.

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | string | The memory table being processed |
| `questions` | array | The questions from the previous `process` call |
| `answers` | string | Your answers in plain English |

## Processing Workflow

The `process` → `process_answers` flow works in two phases:

**Phase 1: Analysis** (`process`)
1. The LLM fetches all memories from the table
2. It identifies duplicates, vague entries, missing fields, and contradictions
3. It generates clarifying questions with context about which memories they relate to
4. Questions are returned to the caller — no mutations happen yet

**Phase 2: Refinement** (`process_answers`)
1. The caller provides answers to the questions
2. The LLM uses the answers to merge duplicates, update vague memories, fill in fields, and delete outdated entries
3. A summary of changes is returned

## Development and Testing

```bash
# Run unit tests (mocked, no API keys needed)
npm test

# Run integration tests (requires OPENAI_API_KEY)
npm run test:integration

# Run all tests
npm run test:all

# Development mode
npm run dev

# Build
npm run build
```

### Test Structure

- `tests/db.test.ts` — Database operations with in-memory libSQL
- `tests/table-setup.test.ts` — Table creation, indexing, and lifecycle
- `tests/llm.test.ts` — System prompt content, tool filtering per operation, strict-mode schema validation
- `tests/memory-ops.test.ts` — Agentic loop, rejection handling, process mutation guard, round exhaustion
- `tests/integration/openai.test.ts` — Real OpenAI API calls testing tool selection, rejection, multi-turn flows, and strict schema acceptance (skipped without `OPENAI_API_KEY`)

## Limitations and Safety Notes

- **SQL trust boundary** — The LLM generates SQL queries and filter clauses. While `sql_query` is restricted to `SELECT` statements, the model could theoretically craft queries that read across tables or use unexpected constructs. For sensitive deployments, consider adding schema-level query validation.
- **Process scalability** — The `process` operation fetches all memories from a table. For tables with many entries, this may hit token limits or become slow. Consider processing in batches for large tables.
- **Prompt injection** — Since the LLM interprets user input as natural language, adversarial inputs could potentially manipulate tool selection. The rejection system and tool filtering per operation mitigate this but don't eliminate it.
- **Embedding consistency** — Memories are embedded with `text-embedding-3-small`. Changing the embedding model requires re-embedding all existing memories.

## Claude Code Commands

These commands are available when working in this repo with Claude Code:

- `/setup-table <name>` — Interactive table creation with suggested columns based on your use case
- `/list-tables` — Show all memory tables, their schemas, and row counts
- `/drop-table <name>` — Delete a memory table (asks for confirmation first)
