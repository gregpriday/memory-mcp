# Memory MCP

A memory MCP server that stores and retrieves memories using Turso (libSQL) with vector search and OpenAI for embeddings and LLM-powered query generation.

## Architecture

- **MCP Tools**: `remember`, `forget`, `recall`, `process` - all take plain English + a table name
- **LLM Layer** (`src/llm.ts`): Uses OpenAI (gpt-5) with function calling to translate natural language into database operations
- **Embeddings** (`src/embeddings.ts`): Uses text-embedding-3-small (1536 dimensions) for semantic search
- **Database** (`src/db.ts`): Turso/libSQL with FLOAT32 vector columns and DiskANN indexes
- **Table Setup** (`src/table-setup.ts`): Creates memory tables with core + freeform columns

## Environment Variables

- `TURSO_DATABASE_URL` - Turso database URL
- `TURSO_AUTH_TOKEN` - Turso auth token
- `OPENAI_API_KEY` - OpenAI API key

## Commands

- `npm run build` - Compile TypeScript
- `npm run dev` - Run with tsx (development)
- `npm test` - Run tests with vitest
- `npm start` - Run compiled server

## Claude Code Commands

- `/setup-table <name>` - Create a new memory table interactively
- `/list-tables` - List all memory tables and their schemas
- `/drop-table <name>` - Drop a memory table (with confirmation)

## Table Structure

Every memory table has these fixed columns:
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `memory` TEXT NOT NULL
- `embedding` FLOAT32(1536)
- `created_at` TEXT NOT NULL

Plus user-defined freeform columns (TEXT, INTEGER, REAL).
