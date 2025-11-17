# Memory MCP Server

A Model Context Protocol (MCP) server that provides semantic memory storage and retrieval using PostgreSQL with pgvector for vector similarity search. This is an **agentic memory system** where an LLM orchestrates memory operations through natural language instructions.

## Overview

The Memory MCP server enables AI assistants to store, search, and manage persistent memories with semantic understanding. Unlike traditional databases that require structured queries, this system accepts natural language instructions and uses an LLM agent to translate them into memory operations.

### Key Features

- **Agentic Architecture**: LLM-orchestrated memory operations using GPT-4/5 with internal tools
- **Semantic Search**: PostgreSQL + pgvector for fast similarity queries with hybrid search (vector + keyword)
- **Dynamic Priority**: Memories have priority scores that decay over time and boost with access
- **Multi-Project Isolation**: Each project has its own isolated PostgreSQL database
- **Rich Metadata**: Automatic extraction of topics, tags, and semantic memory types
- **Memory Lifecycle**: Automated consolidation, deduplication, and cleanup via refinement operations
- **Multi-Index Organization**: Organize memories into logical namespaces (personal, work, research, etc.)

## Quick Start

Get the Memory MCP server running in 5 minutes:

```bash
# 1. Clone and install dependencies
git clone <repository-url>
cd memory-mcp
npm install

# 2. Set up PostgreSQL database (automated)
./scripts/setup-postgres.sh

# 3. Configure environment
cp .env.example .env
# Edit .env and set your OPENAI_API_KEY

# 4. Start the server
npm run dev
```

The server will start and listen for MCP tool calls via STDIO. See [Configuration](#configuration) for detailed setup and [Usage](#usage) for how to call the MCP tools.

## Architecture

The Memory MCP server uses a layered architecture:

```
┌─────────────────────────────────────────────────────────────────┐
│  MCP Layer (MemoryServer.ts)                                    │
│  • MCP tools: memorize, recall, forget, refine_memories,        │
│    create_index, list_indexes, scan_memories                    │
│  • STDIO transport for Claude Desktop integration               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Controller Layer (MemoryController.ts)                         │
│  • Security boundaries (ProjectFileLoader, IndexResolver)       │
│  • Index access validation                                      │
│  • Routes tool calls to agent modes                             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Agent Layer (MemoryAgent.ts)                                   │
│  • LLM orchestration (GPT-4/5) with mode-specific prompts       │
│  • Tool Runtime: search_memories, get_memories,                 │
│    upsert_memories, delete_memories, read_file,                 │
│    analyze_text, list_relationships                             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Repository Layer (MemoryRepositoryPostgres.ts)                 │
│  • PostgreSQL + pgvector data access                            │
│  • Embedding generation, semantic search                        │
│  • Access tracking, relationship management                     │
│  • Connection pooling per project (PoolManager.ts)              │
└─────────────────────────────────────────────────────────────────┘
```

### Supporting Components

- **PromptManager**: Composes base + mode-specific + host/project context into system messages
- **IndexResolver**: Validates index names and provides default index logic
- **ProjectFileLoader**: Securely loads files from project directory with size limits
- **PriorityCalculator**: Deterministic priority formula (recency × 0.4 + importance × 0.4 + usage × 0.2)

## Prerequisites

- **PostgreSQL 14+** - Database server with vector extension support
- **pgvector** - PostgreSQL extension for vector similarity search
- **Node.js 18+** - Runtime environment
- **OpenAI API Key** - For generating embeddings and LLM orchestration

## Installation

### Automated Setup (Recommended)

Run the setup script to automatically create the database, enable pgvector, and run migrations:

```bash
./scripts/setup-postgres.sh
```

The script will:
- Check if PostgreSQL is installed and running
- Create the `memory_default` database
- Enable the pgvector extension
- Run schema migrations
- Verify the setup

### Manual Setup

If you prefer to set up manually, follow these steps:

#### 1. Install PostgreSQL with pgvector

**macOS (Homebrew)**

```bash
# Install PostgreSQL 14 or later
brew install postgresql@16

# Start PostgreSQL service
brew services start postgresql@16

# Install pgvector
brew install pgvector
```

**Linux (Ubuntu/Debian)**

```bash
# Install PostgreSQL
sudo apt update
sudo apt install postgresql postgresql-contrib

# Install build tools for pgvector
sudo apt install build-essential postgresql-server-dev-all

# Install pgvector from source
git clone https://github.com/pgvector/pgvector.git
cd pgvector
make
sudo make install
```

**Docker**

```bash
# Use the official pgvector image
docker run -d \
  --name postgres-memory \
  -e POSTGRES_DB=memory_default \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  ankane/pgvector:latest

# Enable pgvector extension
docker exec -it postgres-memory psql -U postgres -d memory_default -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Run migrations
docker exec -i postgres-memory psql -U postgres -d memory_default < migrations/20250117000001_init_postgres_schema.sql
```

#### 2. Create Database

```bash
# Create the memory_default database
createdb memory_default

# Or using psql
psql -U postgres -c "CREATE DATABASE memory_default;"
```

#### 3. Enable pgvector Extension

```bash
# Connect to the database and enable the extension
psql -d memory_default -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

#### 4. Run Migrations

```bash
# Run the schema migration
psql -d memory_default -f migrations/20250117000001_init_postgres_schema.sql

# Optional: Load test data for quick testing
psql -d memory_default -f migrations/seeds/01_test_data.sql
```

#### 5. Verify Installation

Run these commands to verify your setup:

```bash
# Verify memory_default database exists
psql -U postgres -c "SELECT datname FROM pg_database WHERE datname = 'memory_default';"

# Check PostgreSQL version
psql -d memory_default -c "SELECT version();"

# Verify pgvector extension is enabled
psql -d memory_default -c "SELECT * FROM pg_extension WHERE extname = 'vector';"

# Check that tables were created
psql -d memory_default -c "\dt"
```

Expected output should show:
- Database `memory_default` exists
- PostgreSQL version 14+
- pgvector extension in the extensions list
- Tables: `memories`, `memory_indexes`, `memory_relationships`, `memory_usage_log`

## Configuration

### 1. Environment Variables

Copy the example environment file and configure your settings:

```bash
# Copy the example file
cp .env.example .env

# Edit .env and set your configuration
```

**Required Environment Variables:**

```env
# Backend configuration (Postgres-only stack)
MEMORY_BACKEND=postgres
MEMORY_POSTGRES_PROJECT_REGISTRY=./config/projects.json
MEMORY_ACTIVE_PROJECT=local

# OpenAI API key for embeddings and LLM orchestration
OPENAI_API_KEY=sk-your-api-key-here

# Embedding model (determines vector dimensions)
MEMORY_EMBEDDING_MODEL=text-embedding-3-small
```

**Optional Configuration:**

```env
# Embedding dimensions (auto-detected from model, manual override available)
MEMORY_EMBEDDING_DIMENSIONS=1536

# Host/system context (inline text or file path)
MEMORY_MCP_SYSTEM_MESSAGE=./config/memory-host-context.txt

# Debug flags
MEMORY_DEBUG_MODE=true
MEMORY_DEBUG_OPERATIONS=true
MEMORY_DEBUG_VALIDATION=true
MEMORY_DEBUG_ACCESS_TRACKING=true
MEMORY_DEBUG_REPOSITORY=true

# Refinement tuning
MEMORY_REFINE_DEFAULT_BUDGET=100
MEMORY_REFINE_ALLOW_DELETE=false
MEMORY_ACCESS_TRACKING_ENABLED=true
MEMORY_ACCESS_TRACKING_TOP_N=3
MEMORY_ACCESS_PRIORITY_BOOST=0.01

# Query enhancement
MEMORY_QUERY_EXPANSION_ENABLED=true
MEMORY_QUERY_EXPANSION_COUNT=2

# File ingestion limits
MEMORY_LARGE_FILE_THRESHOLD_BYTES=262144
MEMORY_CHUNK_CHAR_LENGTH=16000
MEMORY_CHUNK_CHAR_OVERLAP=2000
MEMORY_MAX_CHUNKS_PER_FILE=24
MEMORY_MAX_MEMORIES_PER_FILE=50
```

### 2. Project Registry

The server uses `config/projects.json` to map project IDs to database URLs:

```json
{
  "local": {
    "databaseUrl": "postgresql://postgres:postgres@localhost:5432/memory_default"
  }
}
```

The active project is selected via the `MEMORY_ACTIVE_PROJECT` environment variable. Each project has its own isolated PostgreSQL database.

**Multi-Project Setup Example:**

```json
{
  "local": {
    "databaseUrl": "postgresql://postgres:postgres@localhost:5432/memory_default"
  },
  "production": {
    "databaseUrl": "postgresql://user:pass@prod-host:5432/memory_prod"
  },
  "staging": {
    "databaseUrl": "postgresql://user:pass@staging-host:5432/memory_staging"
  }
}
```

### 3. Embedding Models

Supported models (configured via `MEMORY_EMBEDDING_MODEL`):

- `text-embedding-3-small` - 1536 dimensions (default, recommended)
- `text-embedding-3-large` - 3072 dimensions (higher quality, higher cost)

**⚠️ Important**: The embedding model dimension must match your database schema. The default migration uses `vector(1536)` for `text-embedding-3-small`. If you change the embedding model, you must update the `embedding` column type in the migration to match the new dimension.

### 4. Host and Project Context (Optional)

The prompt system supports optional context injection:

**Host Context** (`MEMORY_MCP_SYSTEM_MESSAGE`):
- Tells the memory server what role it plays in the overall system
- Guides what kinds of information should be stored or avoided
- Can be inline text or a file path (e.g., `./config/memory-host-context.txt`)

**Project Context** (`projectSystemMessagePath` in tool calls):
- Per-request context for specific projects or use cases
- Passed as a parameter to individual tool calls
- Useful for biasing behavior on a per-operation basis

See `prompts/README.md` for details on the composable prompt system.

## Development

### Install Dependencies

```bash
npm install
```

### Run Development Server

```bash
npm run dev
```

This starts the MCP server in development mode with hot reload (uses `tsx`).

### Build for Production

```bash
npm run build
npm start
```

The `build` command compiles TypeScript to `dist/`, and `start` runs the compiled server.

### Code Quality

```bash
# Check linting
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Format code with Prettier
npm run format

# Check if code is formatted
npm run format:check
```

**Always run `npm run format` or `npm run lint:fix` before committing** to maintain code consistency.

## Usage

The Memory MCP server exposes tools through the Model Context Protocol. These tools are typically called from Claude Desktop or other MCP-compatible clients.

### How MCP Tools Work

MCP tools are called through MCP-compatible clients like Claude Desktop. When you interact with Claude, you can reference memories naturally in conversation, and Claude will use these tools automatically. The tools can also be called programmatically through the MCP protocol using JSON payloads as shown in the examples below.

**Example conversational usage in Claude Desktop:**
- "Remember that I prefer dark mode" → uses `memorize` tool
- "What are my notification preferences?" → uses `recall` tool
- "Forget my old email address" → uses `forget` tool

### Tool: `memorize`

**Purpose**: Capture durable memories from free-form text or files. The agent extracts atomic facts, enriches them with metadata (topic, tags, memoryType), and stores them in PostgreSQL + pgvector.

**Parameters**:
- `input` (required): Natural language instruction describing what to memorize
- `files` (optional): Array of relative file paths to ingest alongside the instruction
- `index` (optional): Index name (defaults to `MEMORY_DEFAULT_INDEX`)
- `projectSystemMessagePath` (optional): Relative path to project-specific system message
- `metadata` (optional): Additional metadata to apply to extracted memories

**Example**:

```json
{
  "input": "Remember that the user prefers dark mode and wants notifications disabled after 9 PM",
  "metadata": {
    "category": "user_preferences"
  }
}
```

**With file ingestion**:

```json
{
  "input": "Memorize the key design decisions from this architecture document",
  "files": ["docs/architecture.md"],
  "index": "project_knowledge"
}
```

**Behavior**:
- Breaks down complex information into atomic, searchable memories
- Automatically extracts topics, tags, and classifies memory types (self, belief, pattern, episodic, semantic)
- For large files, uses chunking and GPT-4-mini for fast pre-processing via `analyze_text` tool
- Returns summary of memories created with IDs and metadata

### Tool: `recall`

**Purpose**: Search stored memories and optionally synthesize an answer. Supports metadata filters, returning raw memories, and priority-aware synthesis.

**Parameters**:
- `query` (required): Natural language question or topic to search for
- `index` (optional): Index name override
- `limit` (optional): Maximum number of memories to return (default: 10)
- `filters` (optional): Structured metadata filters (keys match stored metadata)
- `filterExpression` (optional): Advanced filter expression using filter DSL
- `projectSystemMessagePath` (optional): Project-specific system message path
- `responseMode` (optional): `"answer"` (synthesized), `"memories"` (raw), or `"both"` (default: `"answer"`)

**Example - Synthesized answer**:

```json
{
  "query": "What are the user's notification preferences?",
  "responseMode": "answer"
}
```

**Example - Raw memories with filters**:

```json
{
  "query": "design decisions",
  "filters": {
    "category": "architecture"
  },
  "responseMode": "memories",
  "limit": 20
}
```

**Example - Advanced filter expression**:

```json
{
  "query": "recent work tasks",
  "filterExpression": "@metadata.tags contains \"work\" AND @metadata.priority > 0.7",
  "responseMode": "both"
}
```

**Behavior**:
- Uses semantic search (pgvector) + keyword search for hybrid retrieval
- Priority-aware synthesis privileges high-salience memories
- Automatic access tracking updates memory priority and access counts
- Returns synthesized answers and/or raw memory records with metadata

### Tool: `forget`

**Purpose**: Plan deletions with the LLM agent. Supports dry runs, metadata-scoped deletes, and explicit ID deletion.

**Parameters**:
- `input` (required): Instruction describing what to forget
- `index` (optional): Index override
- `filters` (optional): Metadata filters for narrowing deletion candidates
- `projectSystemMessagePath` (optional): System message path for contextualizing deletions
- `dryRun` (optional): Default `true`; when `false` the agent executes approved deletes
- `explicitMemoryIds` (optional): Array of specific memory IDs to delete immediately

**Example - Dry run (default)**:

```json
{
  "input": "Forget all memories about the old API design that was replaced in December",
  "dryRun": true
}
```

**Example - Execute deletion with filters**:

```json
{
  "input": "Delete all low-priority temporary notes",
  "filters": {
    "memoryType": "episodic",
    "category": "temp"
  },
  "dryRun": false
}
```

**Example - Delete specific IDs**:

```json
{
  "input": "Remove these obsolete memories",
  "explicitMemoryIds": ["550e8400-e29b-41d4-a716-446655440000"],
  "dryRun": false
}
```

**Behavior**:
- Conservative deletion with dry-run protection (default)
- Agent searches for matching memories and explains what would be deleted
- Validates against safety rules (e.g., can't delete system memories)
- When `dryRun=false`, executes approved deletions
- Returns list of deleted memories with rationale

### Tool: `refine_memories`

**Purpose**: Curate stored memories through consolidation, deduplication, reprioritization, and cleanup. The agent analyzes memories and generates structured refinement plans.

**Parameters**:
- `index` (optional): Index override
- `operation` (optional): Refinement mode - `"consolidation"`, `"decay"`, `"cleanup"`, or `"reflection"`
- `scope` (optional): Controls which memories are considered
  - `query`: Semantic query to find candidates
  - `filters`: Metadata filters
  - `seedIds`: Array of specific memory IDs to start from
  - `maxCandidates`: Maximum memories to analyze
- `budget` (optional): Maximum actions to execute (default from `MEMORY_REFINE_DEFAULT_BUDGET`)
- `dryRun` (optional): Plan-only mode when `true` (default)
- `projectSystemMessagePath` (optional): Project-specific context

**Example - Consolidation**:

```json
{
  "operation": "consolidation",
  "scope": {
    "query": "user preferences",
    "maxCandidates": 50
  },
  "dryRun": true
}
```

**Example - Decay (reprioritization)**:

```json
{
  "operation": "decay",
  "budget": 100,
  "dryRun": false
}
```

**Example - Cleanup with filters**:

```json
{
  "operation": "cleanup",
  "scope": {
    "filters": {
      "memoryType": "episodic"
    }
  },
  "dryRun": true
}
```

**Operation Modes**:

- **Consolidation**: Merge duplicates, create summaries, detect contradictions, link related memories
- **Decay**: Reprioritize memories using deterministic priority formula based on recency, usage, and importance
- **Cleanup**: Identify deletion candidates (low priority, superseded, obsolete) as dry-run recommendations
- **Reflection**: Generate high-level summaries and patterns from related memories

**Action Types**:

- `UPDATE`: Reprioritize or add relationships between memories
- `MERGE`: Consolidate duplicate or redundant memories
- `CREATE`: Generate summary memories from multiple related memories
- `DELETE`: Remove obsolete or low-priority memories (recommendations only in dry-run)

**Behavior**:
- Agent uses GPT-4/5 for complex pattern analysis and planning
- Generates structured refinement actions with rationale
- Validates actions against safety rules (e.g., can't delete system memories)
- Returns refinement plan with actions and expected outcomes
- When `dryRun=false`, executes approved actions

### Tool: `create_index`

**Purpose**: Create or ensure a PostgreSQL-backed memory index exists for the active project.

**Parameters**:
- `name` (required): New index name
- `description` (optional): Human description stored alongside the index record

**Example**:

```json
{
  "name": "work_notes",
  "description": "Professional work-related notes and decisions"
}
```

**Behavior**:
- Creates a new index if it doesn't exist
- If index already exists, returns existing index information
- Indexes are stored as rows in the `memory_indexes` table
- Each project can have multiple indexes for logical organization

### Tool: `list_indexes`

**Purpose**: List all PostgreSQL memory indexes with document counts so agents can choose destinations.

**Parameters**: None

**Example**:

```json
{}
```

**Returns**:

```json
{
  "indexes": [
    {
      "name": "personal",
      "documentCount": 142,
      "pendingDocumentCount": 0,
      "project": "local"
    },
    {
      "name": "work_notes",
      "documentCount": 87,
      "pendingDocumentCount": 0,
      "project": "local"
    }
  ],
  "totalMemories": 229,
  "totalDiskBytes": 1048576
}
```

**Behavior**:
- Returns all indexes for the active project
- Includes document counts for each index (pendingDocumentCount always 0 in PostgreSQL backend)
- Provides aggregate statistics (totalMemories, totalDiskBytes)
- Helps agents choose appropriate index for new memories
- Useful for understanding memory organization

### Tool: `scan_memories`

**Purpose**: Run direct PostgreSQL searches without LLM orchestration. Returns raw results and diagnostics for debugging and inspection.

**Parameters**:
- `query` (required): Search query text
- `index` (optional): Index override
- `limit` (optional): Max results (default 10, max 1000)
- `filters` (optional): Structured metadata filters
- `filterExpression` (optional): Advanced filter expression string
- `semanticWeight` (optional): Semantic vs keyword weighting (0-1)
- `reranking` (optional): Enable reranking (default true)
- `includeMetadata` (optional): Include metadata payloads (default true)

**Example**:

```json
{
  "query": "user preferences",
  "limit": 20,
  "semanticWeight": 0.7,
  "includeMetadata": true
}
```

**Behavior**:
- Bypasses LLM agent and queries PostgreSQL directly
- Useful for debugging search quality and inspecting raw embeddings
- Returns raw search results with similarity scores
- Includes diagnostics about query execution
- Not typically used in normal operation (use `recall` instead for LLM-synthesized answers)

## Troubleshooting

### pgvector extension not found

**Error**: `ERROR: extension "vector" is not available`

**Solution**:

```bash
# Verify pgvector is installed
pg_config --sharedir
# Check if vector.control exists in <sharedir>/extension/

# Reinstall if needed (macOS)
brew reinstall pgvector

# Reinstall if needed (Linux)
cd pgvector && sudo make install
```

### Cannot connect to database

**Error**: `Error: connect ECONNREFUSED` or `FATAL: password authentication failed`

**Solution**:

```bash
# Check PostgreSQL is running
psql -U postgres -l

# Verify connection string in config/projects.json
# Check username, password, host, and port match your PostgreSQL setup

# Test connection manually
psql "postgresql://postgres:postgres@localhost:5432/memory_default"
```

### Permission denied for CREATE EXTENSION

**Error**: `ERROR: permission denied to create extension "vector"`

**Solution**:

```bash
# Connect as superuser (usually postgres)
psql -U postgres -d memory_default -c "CREATE EXTENSION vector;"
```

### Embedding dimension mismatch

**Error**: `Error: Embedding dimension mismatch`

**Cause**: The embedding model dimension doesn't match the database schema.

**Solution**:

1. Check your configured model dimension:
   - `text-embedding-3-small`: 1536 dimensions
   - `text-embedding-3-large`: 3072 dimensions

2. Update migration to match:

```sql
-- For text-embedding-3-small (default)
embedding vector(1536)

-- For text-embedding-3-large
embedding vector(3072)
```

3. Re-run migrations after updating the dimension.

### Missing OPENAI_API_KEY

**Error**: `Error: OPENAI_API_KEY is required.`

**Solution**:

```bash
# Add your OpenAI API key to .env
echo "OPENAI_API_KEY=sk-your-api-key-here" >> .env
```

### Invalid MEMORY_ACTIVE_PROJECT

**Error**: `Error: No active project configured`

**Solution**:

1. Verify `MEMORY_ACTIVE_PROJECT` in `.env` matches a key in `config/projects.json`
2. Ensure `config/projects.json` exists and is valid JSON
3. Check that the project's `databaseUrl` is accessible

### Memory index not found

**Error**: `Error: Index not found`

**Solution**:

1. List available indexes: Call `list_indexes` tool
2. Create the index: Call `create_index` tool with the desired name
3. Check `MEMORY_DEFAULT_INDEX` environment variable matches an existing index

### Server won't start - relation 'memories' does not exist

**Error**: `ERROR: relation "memories" does not exist` or `ERROR: relation "memory_indexes" does not exist`

**Cause**: Database migrations haven't been run.

**Solution**:

```bash
# Run the schema migration
psql -d memory_default -f migrations/20250117000001_init_postgres_schema.sql

# Verify tables were created
psql -d memory_default -c "\dt"
```

### Server won't start - missing dependencies

**Error**: `Cannot find module '@modelcontextprotocol/sdk'` or similar import errors

**Solution**:

```bash
# Install all dependencies
npm install

# Verify installation
npm list @modelcontextprotocol/sdk
```

### Claude Desktop can't connect to MCP server

**Error**: `Cannot connect to server on stdio` or MCP server not responding

**Solution**:

1. Verify the MCP server path in Claude Desktop config is correct
2. Check that the server starts successfully: `npm run dev` (should show no errors)
3. Verify your Claude Desktop MCP configuration (usually in `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/absolute/path/to/memory-mcp/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "MEMORY_ACTIVE_PROJECT": "local"
      }
    }
  }
}
```

4. For development, use `npm run build` to compile TypeScript, then point to `dist/index.js`
5. Check Claude Desktop logs for more detailed error messages

### Development server errors

**Error**: Various TypeScript or runtime errors during `npm run dev`

**Solution**:

```bash
# Clear any caches and reinstall
rm -rf node_modules package-lock.json
npm install

# Run linting and formatting
npm run lint:fix
npm run format

# Check TypeScript compilation
npm run build
```

## Cloud Deployment

### Neon

[Neon](https://neon.tech) provides serverless PostgreSQL with pgvector support:

1. Create a new project at [console.neon.tech](https://console.neon.tech)
2. Enable pgvector in the SQL Editor:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. Run the schema migration:
   ```sql
   -- Copy contents of migrations/20250117000001_init_postgres_schema.sql
   ```
4. Copy the connection string to `config/projects.json`:
   ```json
   {
     "production": {
       "databaseUrl": "postgresql://user:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb?sslmode=require"
     }
   }
   ```

### Supabase

[Supabase](https://supabase.com) includes pgvector by default:

1. Create a new project at [app.supabase.com](https://app.supabase.com)
2. Go to SQL Editor and run:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. Run the schema migration in the SQL Editor
4. Copy the connection string from Project Settings → Database:
   ```json
   {
     "production": {
       "databaseUrl": "postgresql://postgres:your-password@db.xxxxxxxxxxxx.supabase.co:5432/postgres"
     }
   }
   ```

### Other PostgreSQL Providers

Any PostgreSQL 14+ provider with pgvector support will work:
- AWS RDS for PostgreSQL (with pgvector extension)
- Google Cloud SQL for PostgreSQL
- Azure Database for PostgreSQL
- DigitalOcean Managed Databases
- Self-hosted PostgreSQL instances

## Additional Documentation

- **[migrations/20250117000001_init_postgres_schema.sql](migrations/20250117000001_init_postgres_schema.sql)** - Database schema and migration
- **[scripts/setup-postgres.sh](scripts/setup-postgres.sh)** - Automated setup script
- **[CLAUDE.md](CLAUDE.md)** - Developer guidance for working with this codebase
- **[prompts/README.md](prompts/README.md)** - Composable prompt system documentation

## License

Private - Internal use only
