# System Prompts

This directory contains system prompts that guide the Memory MCP agent's behavior across different operations using GPT-5.

## Prompt Structure

The Memory MCP uses a layered prompt system with:

1. **Base prompt** (`memory-base.txt`) - Core agent persona and principles
2. **Mode-specific prompts** - Operation-specific guidance (memorize, recall, forget)
3. **Host context** - Optional MCP-level system message injected from the `MEMORY_MCP_SYSTEM_MESSAGE` environment variable
4. **Project context** - Optional project-specific system message injected at runtime via `projectSystemMessagePath`

## Available Prompts

### memory-base.txt

The foundation prompt that defines the agent's role and responsibilities.

**Purpose:** Establishes the agent as a memory management system powered by GPT-5

**Key concepts:**

- Interpret natural language instructions
- Use internal tools instead of hallucinating
- Operate within specific memory indexes
- Respect metadata and filters
- Extract atomic facts from complex information

**Used in:** All operations (combined with mode-specific prompts)

### memory-memorize.txt

Guides the agent in extracting and storing atomic memories from text or files.

**Purpose:** Break down complex information into focused, searchable memories with rich metadata

**Tools available:** `read_file`, `analyze_text`, `upsert_memories`

**Model used:** GPT-5 (for reasoning and tool orchestration)

**Key behavior:** Encourages the agent to run `analyze_text` (fast GPT-5-mini model) as a pre-processing step on long or noisy content, then refine and store the final memories via `upsert_memories`.

### memory-recall.txt

Guides the agent in searching for and synthesizing information from stored memories.

**Purpose:** Retrieve relevant memories and optionally synthesize answers

**Tools available:** `search_memories`, `get_memories`

**Model used:** GPT-5 (for complex query understanding and synthesis)

**Version:** 1.1 - Added priority-aware synthesis guidance to privilege high-salience memories in answers

### memory-forget.txt

Guides the agent in safely identifying and removing memories.

**Purpose:** Conservative deletion with dry-run protection

**Tools available:** `search_memories`, `delete_memories`

**Model used:** GPT-5 (for careful evaluation)

### memory-refine.txt

Guides the agent in analyzing stored memories and creating refinement plans for consolidation, decay, and cleanup.

**Purpose:** Generate refinement actions to maintain memory health and optimize retrieval quality

**Tools available (planning mode):** `search_memories`, `get_memories`, `analyze_text`

**Model used:** GPT-5 (for complex pattern analysis and planning)

**Version:** 1.0 - Initial refine prompt with three operation modes

**Key concepts:**

- **Consolidation mode**: Merge duplicates, create summaries, detect contradictions, link related memories
- **Decay mode**: Reprioritize memories using deterministic priority formula based on recency, usage, and importance
- **Cleanup mode**: Identify deletion candidates (low priority, superseded, obsolete) as dry-run recommendations
- **Action types**: UPDATE (reprioritize/add relationships), MERGE (consolidate duplicates), CREATE (summaries), DELETE (recommendations only)
- **Priority formula**: Embedded in prompt for deterministic recalculation (recency × 0.4 + importance × 0.4 + usage × 0.2)
- **Planning mode**: Agent generates action plan; execution happens externally (no direct writes/deletes during planning)

**Used in:** Memory lifecycle management, periodic maintenance, "sleep" consolidation cycles

### memory-memorize-classify.txt

Classification guide for semantic memory typing during the memorize operation.

**Purpose:** Classify each extracted memory by semantic type (self, belief, pattern, episodic, semantic) to enable downstream consolidation and smarter retrieval

**Used in:** Memorize mode (`memory-memorize`), analyzer mode (`memory-analyzer`), and chunked file ingestion

**Classification types:**

1. **Self Memory**: First-person identity statements about the persona
2. **Belief Memory**: Generalizations and stable stances (not personal identity)
3. **Pattern Memory**: Repeated behaviors, procedures, or templates
4. **Episodic Memory**: Specific, time-bound experiences or events
5. **Semantic Memory**: General facts or principles independent of persona

**Key features:**

- Clear decision tree with examples for each type
- Worked examples (1 per type) showing input → reasoning → JSON output
- Decision order: Self → Belief → Pattern → Episodic → Semantic
- Required `memoryType` field in memory metadata (one of the five types)

**Integration:**

- Composed with `memory-memorize` in memorize mode
- Composed with `memory-analyzer` in analyzer mode
- Applied consistently across all memory extraction flows

### memory-analyzer.txt

Reusable prompt for analyzing text and extracting structured information.

**Purpose:** Extract key facts, topics, tags, and metadata from text content

**Used as:** Internal `analyze_text` tool available to the main agent

**Model used:** GPT-5-mini (fast, cost-effective analysis) via the `MEMORY_ANALYSIS_MODEL` setting

## Model Selection

| Prompt                         | Model      | Rationale                             |
| ------------------------------ | ---------- | ------------------------------------- |
| memory-base + mode prompts     | GPT-5      | Complex reasoning, tool orchestration |
| memory-analyzer (analyze_text) | GPT-5-mini | Fast, cost-effective text analysis    |

## Usage in Code

Prompts are composed at runtime using `PromptManager`:

```typescript
// Memorize with classification
const systemPrompt = prompts.composePrompt(
  ['memory-base', 'memory-memorize', 'memory-memorize-classify'],
  projectSystemMessage // Optional project context
);

// Analyzer with classification
const analyzerPrompt = prompts.composePrompt(['memory-analyzer', 'memory-memorize-classify']);
```

### Host Context

The host context is intended for the _calling agent_ (e.g., AppsDash) to tell the memory server what role it plays in the overall system and what kinds of information should be stored or avoided.

Host context is loaded from `MEMORY_MCP_SYSTEM_MESSAGE` environment variable, which supports:

- **Inline text**: The message is provided directly as a string
- **File path**: A path to a text file (absolute or relative to `process.cwd()`)
  - File paths are detected by checking if the file actually exists on disk
  - If the file exists, its contents are loaded
  - If not, the value is treated as inline text
  - This allows inline text to safely contain patterns like `.txt` or `.md` without being misinterpreted

Host context is injected via placeholder in `memory-base.txt`:

```
[HOST CONTEXT START]
{{memory_host_system_message}}
[HOST CONTEXT END]
```

If `MEMORY_MCP_SYSTEM_MESSAGE` is not set, this section will be empty.

### Project Context

Project context is injected via placeholder in `memory-base.txt`:

```
[PROJECT CONTEXT START]
{{project_system_message}}
[PROJECT CONTEXT END]
```

## Prompt Versioning

All prompts include version metadata in the following format:

```
**Version:** 1.0 | **Updated:** YYYY-MM-DD | **Changelog:** Brief description of changes
```

**Version numbering:**

- Major version (X.0): Breaking changes, significant restructuring, or new capabilities
- Minor version (X.Y): Enhancements, clarifications, or non-breaking additions

**Placement:**

- Place version metadata at the top of the prompt, immediately after the `## MODE` header
- This ensures visibility without interfering with the core prompt content

**Changelog guidelines:**

- Keep changelog entries concise (one line)
- Focus on what changed from the user/agent perspective
- For initial releases, use "Initial [mode] prompt"

**Example:**

```
## RECALL MODE

**Version:** 1.1 | **Updated:** 2025-01-16 | **Changelog:** Added priority-aware synthesis guidance
```

## Adding New Prompts

1. Create a new `.txt` file with a descriptive name
2. Write clear, focused instructions
3. Add version metadata at the top (Version 1.0)
4. Update this README with prompt documentation
5. Test with MemoryAgent

See [docs/prompts-best-practices.md](../docs/prompts-best-practices.md) for detailed guidelines.
