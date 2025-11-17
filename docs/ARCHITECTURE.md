# Memory MCP Architecture

> **Version:** 1.0 | **Last Updated:** 2025-01-17

This document describes the AI-first architecture and system design of the Memory MCP server.

## Table of Contents

- [AI-First Design Philosophy](#ai-first-design-philosophy)
- [Layered Architecture](#layered-architecture)
  - [MCP Layer](#mcp-layer)
  - [Controller Layer](#controller-layer)
  - [Agent Layer](#agent-layer)
  - [Repository Layer](#repository-layer)
- [Prompt Composition System](#prompt-composition-system)
- [Multi-Project Architecture](#multi-project-architecture)
- [Memory Lifecycle & Refinement](#memory-lifecycle--refinement)
- [Embedding & Dimension Alignment](#embedding--dimension-alignment)
- [Filter Grammar](#filter-grammar)
- [Key Data Flows](#key-data-flows)
- [Implementation Patterns](#implementation-patterns)

---

## AI-First Design Philosophy

Memory MCP is an **agentic architecture** where an LLM (GPT-4/GPT-5) orchestrates memory operations using internal tools rather than exposing direct CRUD APIs.

### Core Principles

**Natural Language Interface**

- Users communicate with the system through conversational commands
- The agent interprets intent and translates it into appropriate operations
- No need to understand underlying database structures or APIs

**Tool-Based Execution**

- The agent uses internal tools (`search_memories`, `upsert_memories`, `delete_memories`, etc.)
- Tools provide structured capabilities with clear contracts
- The agent reasons about which tools to use and in what order

**Semantic Understanding**

- Memory storage uses embeddings for semantic search
- Memories are enriched with metadata and relationships
- The system understands context, not just keywords

**Autonomous Operation**

- The agent makes decisions about memory extraction, deduplication, and consolidation
- Complex workflows (like file ingestion) happen automatically
- The system adapts to user intent without explicit procedural instructions

### Why Agentic?

Traditional memory systems require users to:

1. Structure data upfront
2. Write queries in specific formats
3. Manually manage relationships and metadata
4. Implement custom deduplication logic

The agentic approach allows users to:

1. Describe what they want in natural language
2. Let the agent determine how to extract and store information
3. Rely on the agent to maintain memory health through refinement
4. Trust the system to retrieve relevant information intelligently

---

## Layered Architecture

The Memory MCP system is organized into four distinct layers, each with clear responsibilities and boundaries.

```
┌─────────────────────────────────────────────┐
│          MCP Protocol Layer                 │  Natural language tools
│   (MemoryServer + MCP SDK)                  │  exposed to Claude Desktop
├─────────────────────────────────────────────┤
│          Controller Layer                   │  Security boundaries,
│   (MemoryController)                        │  validation, orchestration
├─────────────────────────────────────────────┤
│          Agent Layer                        │  LLM-powered reasoning,
│   (MemoryAgent + ToolRuntime)               │  tool orchestration
├─────────────────────────────────────────────┤
│          Repository Layer                   │  Pure data access,
│   (MemoryRepositoryPostgres)                │  embeddings, search
└─────────────────────────────────────────────┘
```

### MCP Layer

**Purpose:** Expose memory capabilities as MCP tools to Claude Desktop or other MCP clients.

**Location:**

- `src/index.ts` - Server entry point
- `src/server/MemoryServer.ts` - Tool registration and request handling

**Responsibilities:**

- Implement MCP protocol using `@modelcontextprotocol/sdk`
- Register and document available tools
- Handle tool invocation requests
- Manage STDIO transport for Claude Desktop integration
- Format responses in MCP-compatible structure

**Tools Exposed:**

1. **memorize** (alias: **remember**) - Store information from text or files
2. **recall** - Search and retrieve memories
3. **forget** - Delete memories based on criteria
4. **refine_memories** - Consolidate, decay, and clean up memories
5. **create_index** - Create new memory indexes
6. **list_indexes** - List available indexes with statistics
7. **scan_memories** - Low-level semantic search for debugging and advanced queries

**Key Code:**

```typescript
// src/index.ts
const server = createMemoryServer();
const transport = new StdioServerTransport();
await server.connect(transport);

// src/server/MemoryServer.ts
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memorize',
      description: 'Store memories from text or files...',
      inputSchema: {
        /* tool parameters */
      },
    },
    // ... other tools
  ],
}));
```

**Input/Output:**

- Input: Natural language commands with optional metadata
- Output: Structured JSON results with status, data, and user-friendly messages

### Controller Layer

**Purpose:** Orchestrate memory operations with security boundaries and validation.

**Location:** `src/memory/MemoryController.ts`

**Responsibilities:**

- Resolve index names (default index logic)
- Load project-specific system messages from files
- Validate file access permissions
- Delegate operations to MemoryAgent
- Format responses for MCP layer
- Handle errors gracefully with clear messages

**Security Boundaries:**

- `IndexResolver` - Validates index names and provides default logic
- `ProjectFileLoader` - Restricts file reads to project root with size limits

**Key Code:**

```typescript
// src/memory/MemoryController.ts
async handleMemorizeTool(args: MemorizeToolArgs): Promise<any> {
  // Resolve index name (apply default if not specified)
  const index = this.indexResolver.resolve(args.index);

  // Load project context with file access validation
  const projectMessage = await this.loadProjectSystemMessage(
    args.projectSystemMessagePath
  );

  // Delegate to agent
  const result = await this.agent.memorize(args, index, projectMessage);

  // Format response for MCP
  return this.formatResponse(result, summary);
}
```

**Data Flow:**

```
MCP Tool Request
    ↓
MemoryController.handleXTool()
    ↓
IndexResolver.resolve() + ProjectFileLoader.readText()
    ↓
MemoryAgent.operation()
    ↓
Formatted MCP Response
```

### Agent Layer

**Purpose:** LLM-powered reasoning and tool orchestration for complex memory operations.

**Location:**

- `src/llm/MemoryAgent.ts` - Main agent class
- `src/llm/agent/runtime/ToolRuntime.ts` - Internal tool execution
- `src/llm/agent/operations/` - Complex operation implementations

**Responsibilities:**

- Interpret natural language instructions
- Decide which internal tools to use and in what order
- Execute multi-step workflows (e.g., file ingestion with chunking)
- Generate summaries and synthetic answers
- Make decisions about deduplication and memory classification
- Orchestrate memory refinement (consolidation, decay, cleanup)

**Internal Tools (via ToolRuntime):**

1. **search_memories** - Semantic + keyword search with filters
2. **get_memories** - Fetch specific memories by ID
3. **upsert_memories** - Store or update memories with metadata
4. **delete_memories** - Remove memories by ID
5. **read_file** - Read project files (with permission checks)
6. **analyze_text** - Fast text analysis using GPT-5-mini (configurable via `MEMORY_ANALYSIS_MODEL`)

**Complex Operations:**

- `MemorizeOperation` - Handles file reading, chunking, deduplication, and batch storage
- Future: `RefineOperation`, `ForgetOperation` for complex logic

**Key Code:**

```typescript
// src/llm/MemoryAgent.ts
export class MemoryAgent {
  private memorizeOperation: MemorizeOperation;

  async memorize(args: MemorizeToolArgs, index: string, projectContext?: string) {
    // Delegate to specialized operation
    // Operation handles prompt composition, LLM interaction, and tool execution
    const result = await this.memorizeOperation.execute(args, index, projectContext);
    return result;
  }
}

// src/llm/agent/operations/memorize/MemorizeOperation.ts
export class MemorizeOperation {
  async execute(args: MemorizeToolArgs, index: string, projectContext?: string) {
    // Compose system prompt
    const systemPrompt = this.prompts.composePrompt(
      ['memory-base', 'memory-memorize', 'memory-memorize-classify'],
      projectContext
    );

    // Run tool loop (handles LLM + tool execution)
    const result = await this.toolRuntime.runToolLoop(systemPrompt, args.input, { index });
    return result;
  }
}
```

**Agent Modes:**

- **Memorize Mode:** Extract facts, classify memory types, store with metadata
- **Recall Mode:** Search, retrieve, synthesize answers
- **Forget Mode:** Identify and remove memories safely
- **Refine Mode:** Analyze memory health, generate consolidation/cleanup plans

### Repository Layer

**Purpose:** Pure data access against PostgreSQL with pgvector for semantic search.

**Location:**

- `src/memory/MemoryRepositoryPostgres.ts` - PostgreSQL implementation
- `src/memory/IMemoryRepository.ts` - Backend-agnostic interface
- `src/memory/PoolManager.ts` - Connection pooling per project

**Responsibilities:**

- Generate embeddings for semantic search
- Execute semantic + keyword hybrid search
- Store and retrieve memory records with metadata
- Track access statistics and update priority scores
- Manage memory indexes (creation, deletion)
- Handle relationship graph queries
- Provide database diagnostics

**Key Capabilities:**

- **Embedding Generation:** Uses OpenAI's `text-embedding-3-small` (1536 dimensions)
- **Semantic Search:** Cosine similarity using pgvector's `<=>` operator
- **Hybrid Search:** Combines semantic (vector) + keyword (text search) with configurable weights
- **Access Tracking:** Updates `accessCount`, `lastAccessedAt`, `currentPriority` on retrieval
- **Filter Support:** JSONB filtering via custom DSL (see [Filter Grammar](#filter-grammar))

**Key Code:**

```typescript
// src/memory/IMemoryRepository.ts
export interface IMemoryRepository {
  upsertMemories(
    index: string,
    memories: MemoryToUpsert[],
    metadata?: Partial<MemoryMetadata>
  ): Promise<string[]>;
  searchMemories(index: string, query: string, options?: SearchOptions): Promise<SearchResult[]>;
  updateAccessStats(index: string, ids: string[], options?: { topN?: number }): Promise<void>;
  deleteMemories(index: string, ids: string[]): Promise<number>;
  getMemory(index: string, id: string): Promise<MemoryRecord | null>;
  ensureIndex(name: string, description?: string): Promise<void>;
  getDatabaseInfo(): Promise<DatabaseInfo>;
}
```

**Database Schema:**

```sql
CREATE TABLE memories (
  id UUID PRIMARY KEY,
  index_name VARCHAR NOT NULL,
  content JSONB NOT NULL,
  embedding vector(1536),  -- pgvector extension
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_memories_embedding ON memories
  USING ivfflat (embedding vector_cosine_ops);
```

---

## Prompt Composition System

The Memory MCP uses a **layered prompt system** that composes prompts from multiple sources at runtime.

**Location:**

- `src/llm/PromptManager.ts` - Composition logic
- `prompts/` - Prompt templates

### Prompt Layers

```
┌─────────────────────────────────────────┐
│  Final System Prompt                    │
├─────────────────────────────────────────┤
│  1. Base Prompt                         │  Agent persona & principles
│     (memory-base.txt)                   │
├─────────────────────────────────────────┤
│  2. Mode Prompt                         │  Operation-specific guidance
│     (memory-memorize.txt, etc.)         │
├─────────────────────────────────────────┤
│  3. Classification Prompt (optional)    │  Memory type classification
│     (memory-memorize-classify.txt)      │
├─────────────────────────────────────────┤
│  4. Host Context (optional)             │  MCP-level system message
│     (MEMORY_MCP_SYSTEM_MESSAGE env)     │
├─────────────────────────────────────────┤
│  5. Project Context (optional)          │  Project-specific guidance
│     (projectSystemMessagePath arg)      │
└─────────────────────────────────────────┘
```

### Prompt Files

**memory-base.txt**

- Defines agent identity and core responsibilities
- Establishes tool-first principles
- Contains placeholders for host and project context
- Used in all operations

**Mode-Specific Prompts**

- `memory-memorize.txt` - Extraction and storage guidance
- `memory-recall.txt` - Search and synthesis guidance
- `memory-forget.txt` - Safe deletion guidance
- `memory-refine.txt` - Consolidation and cleanup guidance
- `memory-analyzer.txt` - Text analysis prompt (used by `analyze_text` tool)

**memory-memorize-classify.txt**

- Classification guide for semantic memory typing
- Decision tree: Self → Belief → Pattern → Episodic → Semantic
- Enables type-aware decay and consolidation strategies

### Composition Logic

```typescript
// src/llm/PromptManager.ts
composePrompt(promptNames: string[], projectContext?: string): string {
  // 1. Load and concatenate base + mode prompts
  let composed = promptNames.map(name =>
    this.getPrompt(name)
  ).join('\n\n');

  // 2. Inject host context from environment variable (if provided)
  const hostContext = this.getHostContext(); // MEMORY_MCP_SYSTEM_MESSAGE
  if (hostContext) {
    composed = composed.replace('{{memory_host_system_message}}', hostContext);
  }

  // 3. Inject project context from parameter (if provided)
  if (projectContext) {
    composed = composed.replace('{{project_system_message}}', projectContext);
  }

  return composed;
}
```

### Context Injection Points

**Host Context (`MEMORY_MCP_SYSTEM_MESSAGE`)**

- Describes the role of the calling agent (e.g., "You are AppsDash's memory system")
- Guides what information should be stored or avoided
- Loaded from environment variable (inline text or file path)
- Injected into `[HOST CONTEXT START]` section in `memory-base.txt`

**Project Context (`projectSystemMessagePath`)**

- Project-specific instructions (e.g., "Focus on customer support transcripts")
- Loaded from file path provided in tool arguments
- Validated by `ProjectFileLoader` (must be within project root)
- Injected into `[PROJECT CONTEXT START]` section in `memory-base.txt`

### Model Selection

| Prompt                         | Model      | Rationale                                                                     |
| ------------------------------ | ---------- | ----------------------------------------------------------------------------- |
| memory-base + mode prompts     | GPT-5      | Complex reasoning, tool orchestration                                         |
| memory-analyzer (analyze_text) | GPT-5-mini | Fast, cost-effective text analysis (configurable via `MEMORY_ANALYSIS_MODEL`) |

---

## Multi-Project Architecture

The Memory MCP supports multiple isolated projects, each with its own PostgreSQL database.

**Location:**

- `src/config/backend.ts` - Configuration loader
- `config/projects.json` - Project registry
- `src/memory/PoolManager.ts` - Per-project connection pooling

### Project Registry

**Format (`config/projects.json`):**

```json
{
  "appsdash": {
    "databaseUrl": "postgresql://user:pass@localhost:5432/appsdash_memory"
  },
  "personal": {
    "databaseUrl": "postgresql://user:pass@localhost:5432/personal_memory"
  }
}
```

### Active Project Selection

The `MEMORY_ACTIVE_PROJECT` environment variable selects which project to use:

```bash
# .env
MEMORY_ACTIVE_PROJECT=appsdash
MEMORY_POSTGRES_PROJECT_REGISTRY=./config/projects.json
```

### Data Isolation

- Each project has its own PostgreSQL database
- No cross-project data access
- Connection pooling managed per project
- Indexes are scoped to the active project

### Architecture Benefits

- **Multi-tenancy:** Host multiple independent memory systems
- **Data isolation:** Complete separation between projects
- **Flexible deployment:** Can run multiple servers with different active projects
- **Easy migration:** Move projects between servers by updating registry

**Key Code:**

```typescript
// src/config/backend.ts
export function loadBackendConfig() {
  const activeProjectId = process.env.MEMORY_ACTIVE_PROJECT;
  const registryPath = process.env.MEMORY_POSTGRES_PROJECT_REGISTRY;

  const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  const projectConfig = registry[activeProjectId];

  return {
    activeProject: {
      projectId: activeProjectId,
      databaseUrl: projectConfig.databaseUrl,
    },
    registry,
  };
}

// src/memory/PoolManager.ts
export class PoolManager {
  private pools = new Map<string, Pool>();

  getPool(databaseUrl: string): Pool {
    if (!this.pools.has(databaseUrl)) {
      this.pools.set(databaseUrl, new Pool({ connectionString: databaseUrl }));
    }
    return this.pools.get(databaseUrl)!;
  }
}
```

---

## Memory Lifecycle & Refinement

Memories in the system have dynamic priority scores that evolve based on access patterns and time.

### Priority Calculation

**Formula Components:**

- **Recency Score:** `exp(-ageDays / 30)` (exponential decay, 30-day half-life)
- **Usage Score:** `log(1 + accessCount) / log(101)` (logarithmic saturation at ~100 accesses)
- **Importance Score:** `{high: 1.0, medium: 0.6, low: 0.3}`
- **Emotion Score:** `emotion?.intensity ?? 0.0` (optional emotional context)

**Type-Specific Weights:**

- **Self/Belief:** 10% recency + 40% importance + 30% usage + 20% emotion (identity persists)
- **Pattern:** 25% recency + 30% importance + 30% usage + 15% emotion (patterns decay slower)
- **Episodic:** 40% recency + 20% importance + 20% usage + 20% emotion (episodes fade faster)
- **Semantic:** 10% recency + 50% importance + 20% usage + 20% emotion (facts persist if important)

Final priority is clamped to `[0.0, 1.0]`.

**Location:** `src/memory/PriorityCalculator.ts`

### Access Tracking

When memories are retrieved (via `searchMemories` or `getMemory`), the system updates:

- `accessCount` - Incremented by 1
- `lastAccessedAt` - Set to current timestamp
- `currentPriority` - Recalculated using priority formula

This is a **fire-and-forget** operation (doesn't block search results).

**Configuration:**

- `MEMORY_ACCESS_TRACKING_TOP_N` - Number of top results to track (default: 10)
- `MEMORY_ACCESS_TRACKING_ENABLED` - Enable/disable access tracking (default: true)
- `MEMORY_ACCESS_PRIORITY_BOOST` - Priority boost multiplier (default: configured per memory type)

### Refinement Operations

The `refine_memories` tool analyzes stored memories and generates actions to maintain memory health.

**Operation Types:**

1. **Consolidation** - Merge duplicates, create summaries, link related memories
2. **Decay** - Reprioritize based on current access patterns
3. **Cleanup** - Identify deletion candidates (low priority, superseded, obsolete)
4. **Reflection** - Synthesize beliefs from pattern clusters

**Action Types:**

- **UPDATE** - Modify metadata (priority, relationships, tags)
- **MERGE** - Consolidate multiple memories into one summary
- **CREATE** - Generate new derived/summary memories
- **DELETE** - Remove memories (with safety checks)

**Safety Rules (via `RefinementActionValidator.ts`):**

- Cannot delete system memories (`source: 'system'`)
- Cannot create duplicate memories
- Must preserve required metadata fields
- Must maintain valid relationship types

**Lifecycle States:**

- `tentative` - Newly created, subject to consolidation
- `stable` - Accessed multiple times, established
- `canonical` - High-value memories with minimum priority floor (0.4)

**Key Code:**

```typescript
// Agent generates refinement plan
const plan: RefinementAction[] = await agent.refineMemories({
  index: 'main',
  operation: 'consolidation',
  budget: 50,
});

// Validator checks safety rules
for (const action of plan) {
  const validation = validateAction(action, context);
  if (!validation.valid) {
    console.warn(`Skipping action: ${validation.reason}`);
    continue;
  }
  await applyAction(action);
}
```

---

## Embedding & Dimension Alignment

The Memory MCP uses OpenAI's embedding models for semantic search.

**Location:**

- `src/config/embedding.ts` - Model configuration
- `src/llm/EmbeddingService.ts` - Embedding generation

### Model Configuration

**Supported Models:**

| Model                  | Dimensions | Use Case                        |
| ---------------------- | ---------- | ------------------------------- |
| text-embedding-3-small | 1536       | Default (fast, cost-effective)  |
| text-embedding-3-large | 3072       | Higher quality (more expensive) |

**Configuration:**

```bash
# .env
MEMORY_EMBEDDING_MODEL=text-embedding-3-small
MEMORY_EMBEDDING_DIMENSIONS=1536
```

### Dimension Alignment

The embedding dimensions **must match** the database schema:

```sql
CREATE TABLE memories (
  embedding vector(1536)  -- Must match MEMORY_EMBEDDING_DIMENSIONS
);
```

**Runtime Validation:**

- Embedding service validates dimensions against configured model
- Throws clear error on mismatch: `Expected 1536 dimensions but got 3072`
- Prevents silent data corruption

### Migration Path

To change embedding models:

1. Update environment variables
2. Run new migration with updated vector dimensions
3. Re-embed existing memories (bulk update operation)
4. Rebuild vector indexes

**Key Code:**

```typescript
// src/config/embedding.ts
const KNOWN_EMBEDDING_MODELS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export function loadEmbeddingConfig() {
  const model = process.env.MEMORY_EMBEDDING_MODEL || 'text-embedding-3-small';

  // Get dimensions from env or use default for known models
  const envDimensions = process.env.MEMORY_EMBEDDING_DIMENSIONS;
  const dimensions = envDimensions
    ? parseInt(envDimensions, 10)
    : KNOWN_EMBEDDING_MODELS[model] || 1536;

  return { model, dimensions };
}
```

**Note:** Dimension mismatches are detected at runtime when OpenAI returns embeddings with different dimensions than expected. The configuration allows `MEMORY_EMBEDDING_DIMENSIONS` to override the default for a model.

---

## Filter Grammar

The Memory MCP provides a simple DSL for filtering memories by metadata, which is translated to SQL JSONB queries.

**Location:** `src/memory/postgres/FilterParser.ts`

### Filter DSL Syntax

**Supported Operators:**

- `CONTAINS` - Check if array contains value
- `=` or `==` - Exact equality

**Examples:**

```
@metadata.tags CONTAINS "work"
@metadata.importance = "high"
@metadata.memoryType == "episodic"
```

### Translation to SQL

The parser tokenizes filter expressions into an AST and generates parameterized SQL to prevent injection:

**Example Translation:**

```
Input:  @metadata.tags CONTAINS "work"
Output: { sql: "metadata @> jsonb_build_object($1, jsonb_build_array($2))", params: ["tags", "work"] }
```

```
Input:  @metadata.importance = "high"
Output: { sql: "metadata->>'importance' = $1", params: ["high"] }
```

The parameterized approach ensures all user input is safely escaped.

### Security Considerations

- **No SQL injection:** Parameterized queries with placeholders
- **Limited scope:** Only operates on `metadata` JSONB field
- **Type safety:** Enforces valid operators and paths via AST parsing

**Key Code:**

```typescript
// src/memory/postgres/FilterParser.ts
export interface SQLTranslation {
  sql: string;
  params: unknown[];
}

export function parseFilterExpression(expr: string): SQLTranslation {
  // Tokenize and build AST
  const tokens = tokenize(expr);
  const ast = parse(tokens);

  // Translate AST to parameterized SQL
  return translateToSQL(ast);
}

// Example usage
const filter = parseFilterExpression('@metadata.tags CONTAINS "work"');
// Returns: { sql: "metadata @> jsonb_build_object($1, jsonb_build_array($2))", params: ["tags", "work"] }
```

---

## Key Data Flows

### 1. Memorize Flow (File Ingestion)

```
User: "Memorize docs/architecture.md"
    ↓
MCP Layer: memorize tool
    ↓
Controller: Resolve index, load project context
    ↓
Agent: Compose prompt (base + memorize + classify)
    ↓
LLM: Decide to use read_file tool
    ↓
ToolRuntime: Read file via ProjectFileLoader
    ↓
LLM: Decide to use analyze_text tool (if large file)
    ↓
ToolRuntime: Analyze text via GPT-4-mini
    ↓
LLM: Extract atomic facts, classify memory types
    ↓
LLM: Decide to use upsert_memories tool
    ↓
ToolRuntime: Call repository.upsertMemories()
    ↓
Repository: Generate embeddings, store in PostgreSQL
    ↓
Result: { status: 'ok', storedCount: 15, memoryIds: [...] }
```

### 2. Recall Flow (Search + Synthesis)

```
User: "What do we know about authentication?"
    ↓
MCP Layer: recall tool
    ↓
Controller: Resolve index, load project context
    ↓
Agent: Compose prompt (base + recall)
    ↓
LLM: Decide to use search_memories tool
    ↓
ToolRuntime: Call repository.searchMemories()
    ↓
Repository: Generate query embedding, execute hybrid search
    ↓
Repository: Update access stats (fire-and-forget)
    ↓
Results: [ { id, content, score, metadata } ]
    ↓
LLM: Synthesize answer from search results
    ↓
Result: { status: 'ok', answer: "...", supportingMemories: [...] }
```

### 3. Refine Flow (Memory Consolidation)

```
User: "Refine memories in main index"
    ↓
MCP Layer: refine_memories tool
    ↓
Controller: Resolve index, load project context
    ↓
Agent: Compose prompt (base + refine)
    ↓
LLM: Decide to use search_memories tool (find candidates)
    ↓
ToolRuntime: Search for low-priority or duplicate memories
    ↓
LLM: Analyze candidates, generate refinement actions
    ↓
Agent: Validate actions via RefinementActionValidator
    ↓
Agent: Apply actions (UPDATE, MERGE, CREATE, DELETE)
    ↓
Result: { status: 'ok', appliedActionsCount: 12, actions: [...] }
```

---

## Implementation Patterns

### Index Resolution

Indexes are stored as rows in the `memory_indexes` table (not files).

```typescript
// src/memory/IndexResolver.ts
class IndexResolver {
  resolve(name?: string): string {
    return name || this.defaultIndex || 'memory';
  }
}

// Usage
// Default index is 'memory' unless MEMORY_DEFAULT_INDEX is set
await repository.ensureIndex('memory', 'Default memory index');
```

### Access Tracking Pattern

Search and retrieval operations trigger automatic access tracking:

```typescript
// src/memory/MemoryRepositoryPostgres.ts
async searchMemories(index: string, query: string, options: SearchOptions) {
  // Generate embedding and execute hybrid search
  const embedding = await this.embeddingService.generateEmbedding(query);
  const results = await this.executeHybridSearch(index, embedding, query, options);

  // Fire-and-forget access tracking (top N results)
  const topN = loadRefinementConfig().accessTracking.topN;
  const topIds = results.slice(0, topN).map(r => r.id);
  this.updateAccessStats(index, topIds).catch(err =>
    console.error('Access tracking failed:', err)
  );

  return results;
}
```

### Error Diagnostics

The system provides structured error information for debugging:

```typescript
// src/memory/MemorySearchError.ts
class MemorySearchError extends Error {
  constructor(
    message: string,
    public diagnostics: SearchDiagnostics,
    options?: { cause?: Error }
  ) {
    super(message, options);
    this.name = 'MemorySearchError';
  }
}

// Usage
throw new MemorySearchError(
  'Search failed after 3 retries',
  {
    index,
    query,
    status: 'search_error',
    durationMs,
    retryCount,
    lastError,
  },
  { cause: originalError }
);
```

### Debug Logging

Granular debug logging controlled by environment variables:

```typescript
// src/config/debug.ts
export interface DebugConfig {
  mode: boolean;
  operations: boolean;
  validation: boolean;
  accessTracking: boolean;
}

export function loadDebugConfig(): DebugConfig {
  return {
    mode: process.env.MEMORY_DEBUG_MODE === 'true',
    operations: process.env.MEMORY_DEBUG_OPERATIONS === 'true',
    validation: process.env.MEMORY_DEBUG_VALIDATION === 'true',
    accessTracking: process.env.MEMORY_DEBUG_ACCESS_TRACKING === 'true',
  };
}

// Usage in src/utils/logger.ts
import { loadDebugConfig } from '../config/debug.js';

export function debugLogOperation(operation: string, phase: string, details?: unknown) {
  const config = loadDebugConfig();
  if (config.operations) {
    console.error(`[${operation}:${phase}]`, details);
  }
}
```

---

## Future Considerations

### Scaling Concerns

- **Large indexes:** Consider partitioning by metadata fields (e.g., date, project)
- **High query volume:** Add read replicas for PostgreSQL
- **Embedding cost:** Implement caching for repeated text (deduplication at embedding level)

### Multi-Agent Coordination

- **Shared memory:** Multiple agents accessing same memory index
- **Conflict resolution:** Concurrent refinement operations
- **Version control:** Track memory evolution over time

### Component Version Drift

- **Embedding model updates:** Migration path for re-embedding existing memories
- **Schema evolution:** Database migration strategy for metadata changes
- **Prompt versioning:** Track prompt versions used to create memories

### Fallback Behavior

- **Embedding service unavailable:** Fallback to keyword-only search
- **LLM timeout:** Return partial results instead of failing
- **Database unavailable:** Graceful degradation with clear error messages

---

## Contributing

When working on this codebase:

1. **Review this document first** to understand the architecture
2. **Follow layer boundaries** - don't bypass abstraction layers
3. **Update prompts carefully** - they directly affect agent behavior
4. **Test with real data** - semantic search behavior is hard to predict
5. **Document breaking changes** - especially schema or embedding model changes

For more details, see:

- `CLAUDE.md` - Project context and development guide
- `prompts/README.md` - Prompt composition and versioning guide
- `src/memory/types.ts` - Core domain types and interfaces
- `src/memory/IMemoryRepository.ts` - Repository contract

---

**Last Updated:** 2025-01-17 | **Version:** 1.0
