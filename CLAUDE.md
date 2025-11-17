# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Context

This is a **pre-release Memory MCP server** using PostgreSQL + pgvector for semantic memory storage. The project is a **complete rewrite** replacing a legacy Upstash backend. Since this is pre-release:

- **Breaking changes are acceptable** - no need to maintain backward compatibility
- **No documentation required for changes** - internal notes in CURRENT_STATE.md are sufficient
- **Legacy code can be removed freely** - don't preserve old patterns or references
- **Experimentation is encouraged** - the architecture is still being refined

## Commands

### Development

- `npm run dev` - Run MCP server in development mode with hot reload (tsx)
- `npm run build` - Compile TypeScript to dist/
- `npm run start` - Run compiled server from dist/

### Code Quality

- `npm run lint` - Check for linting issues
- `npm run lint:fix` - Auto-fix linting issues
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check if code is formatted

**Always run `npm run format` or `npm run lint:fix` before committing** to maintain code consistency.

### Database

Migrations must be run manually via `psql`:

```bash
psql "$DATABASE_URL" -f migrations/20250117000001_init_postgres_schema.sql
psql "$DATABASE_URL" -f migrations/seeds/01_test_data.sql  # Optional seed data
```

## Architecture Overview

### AI-First Design

This is an **agentic architecture** where an LLM (GPT-4/5) orchestrates memory operations using tools. The agent receives natural language commands and uses internal tools (search, upsert, delete, analyze) rather than exposing direct CRUD APIs.

### Layered Architecture

**MCP Layer** (`src/server/MemoryServer.ts`, `src/index.ts`)

- Exposes 6 MCP tools: memorize, recall, forget, refine_memories, create_index, list_indexes
- Each tool receives natural language input and delegates to MemoryController
- STDIO transport for Claude Desktop integration

**Controller Layer** (`src/memory/MemoryController.ts`)

- Orchestrates MemoryAgent with security boundaries (ProjectFileLoader, IndexResolver)
- Validates index access and file read permissions
- Routes tool calls to appropriate agent modes

**Agent Layer** (`src/llm/MemoryAgent.ts`)

- **MemoryAgent** is the core orchestrator - receives mode-specific prompts and uses tool runtime
- **Tool Runtime** (`src/llm/agent/runtime/ToolRuntime.ts`) provides 7 internal tools:
  - `search_memories`, `get_memories`, `upsert_memories`, `delete_memories`
  - `read_file`, `analyze_text` (GPT-4-mini for fast analysis), `list_relationships`
- **Operations** (`src/llm/agent/operations/memorize/`) contain complex flows like multi-chunk ingestion

**Repository Layer** (`src/memory/MemoryRepositoryPostgres.ts`)

- Pure data access against PostgreSQL with pgvector
- Embedding generation, semantic search, access tracking, relationship management
- Uses `PoolManager.ts` for connection pooling per project

### Multi-Project Architecture

The backend config (`src/config/backend.ts`) loads `config/projects.json` which maps `projectId → databaseUrl`. Each project has its own isolated Postgres database. The `MEMORY_ACTIVE_PROJECT` env var selects which project to use.

### Prompt System

Prompts are **composable** and **versioned** (see `prompts/README.md`):

- Base prompt (`memory-base.txt`) establishes agent persona
- Mode prompts (`memory-memorize.txt`, `memory-recall.txt`, etc.) guide specific operations
- Host context from `MEMORY_MCP_SYSTEM_MESSAGE` env var (inline or file path)
- Project context injected at runtime

**PromptManager** (`src/llm/PromptManager.ts`) composes these layers into final system messages.

### Memory Lifecycle & Refinement

Memories have dynamic priority scores that decay over time and boost with access. The **refine_memories** tool analyzes stored memories and generates consolidation/decay/cleanup actions:

- **UPDATE**: Reprioritize or add relationships
- **MERGE**: Consolidate duplicates
- **CREATE**: Generate summaries
- **DELETE**: Remove low-priority/obsolete memories

Validators (`src/validators/RefinementActionValidator.ts`, `MetadataValidator.ts`) enforce safety rules (e.g., can't delete system memories).

### Embedding & Dimension Alignment

`src/config/embedding.ts` maps model names to dimensions (text-embedding-3-small → 1536, 3-large → 3072). The schema's `vector(1536)` must match the configured model. Runtime validation throws clear errors on mismatch.

### Filter Grammar

`src/memory/postgres/FilterParser.ts` converts a simple filter DSL (`@metadata.tags contains "work"`) into SQL JSONB predicates. This allows natural language filters without exposing raw SQL.

## Key Implementation Patterns

### Index Resolution

Indexes are NOT files - they're rows in `memory_indexes` table. The server calls `repo.ensureIndex(name, description)` which creates or returns existing index. `IndexResolver.ts` validates index names and provides default index logic.

### Access Tracking

`searchMemories()` and `getMemory()` trigger fire-and-forget `updateAccessStats()` which increments `accessCount` and adjusts `currentPriority` using `PriorityCalculator.ts` (deterministic formula: recency × 0.4 + importance × 0.4 + usage × 0.2, clamped to [0.0, 1.0]).

### Diagnostics

`MemorySearchError.ts` provides structured error info with search status and diagnostics. Use this pattern for repository-level failures.

### Debug Flags

Debug categories in `src/config/debug.ts`:

- `MEMORY_DEBUG_MODE` - general debug logging
- `MEMORY_DEBUG_OPERATIONS` - operation start/end
- `MEMORY_DEBUG_VALIDATION` - validator details
- `MEMORY_DEBUG_ACCESS_TRACKING` - priority updates

## Important Files to Reference

- **prompts/README.md** - Prompt composition and versioning guide
- **src/memory/types.ts** - Core domain types (MemoryRecord, SearchResult, metadata schemas)
- **src/memory/IMemoryRepository.ts** - Repository contract (the only interface to storage)

## Common Gotchas

1. **Don't create IndexManager** - Legacy code used file-based index registry. Postgres stores indexes in DB.
2. **Embeddings must match schema** - If you change embedding model, update both migration and env vars.
3. **No pending documents** - Postgres always returns `pendingDocumentCount: 0` (Upstash concept removed).
4. **Always format before commit** - Run `npm run format` or `npm run lint:fix` to auto-fix style issues.
5. **Breaking changes are fine** - This is pre-release; optimize for correctness over compatibility.
