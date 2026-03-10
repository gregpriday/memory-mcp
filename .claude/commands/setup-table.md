---
description: Create a new memory table in Turso for a specific use case
allowed-tools: Bash, Read, Write, Edit
argument-hint: <table_name>
---

# Setup Memory Table

You are setting up a new memory table called `$1` in the Turso database for the Memory MCP system.

## Context

This MCP server stores memories in Turso (libSQL) tables. Each table has fixed columns:
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `memory` TEXT NOT NULL (the main memory content)
- `embedding` FLOAT32(1536) (vector embedding for semantic search)
- `created_at` TEXT NOT NULL (ISO 8601 timestamp)

Plus any freeform columns the user defines for their use case.

## Your Task

1. Ask the user what this memory table will be used for. For example:
   - Remembering GitHub users and how we've replied to them
   - Tracking customer preferences
   - Storing debugging insights
   - Keeping notes about codebase patterns

2. Based on their use case, suggest appropriate freeform columns. For example, for a GitHub user memory table:
   - `username TEXT` - GitHub username
   - `category TEXT` - Type of memory (reply_style, personality, preferences, etc.)
   - `subject TEXT` - What/who the memory is about
   - `importance TEXT` - Priority level (low, medium, high)

3. Confirm the column choices with the user.

4. Once confirmed, run the table creation script from the memory-mcp repo root:

```bash
npx tsx -e "
import { createMemoryTable } from './src/table-setup.js';

const columns = [
  // REPLACE with actual columns derived from the user's use case
];

await createMemoryTable('$1', columns);
console.log('Table $1 created successfully!');
"
```

5. Verify the table was created by checking the schema.

## Important Notes

- Table names should be snake_case and descriptive
- Column types should be TEXT, INTEGER, or REAL
- Don't add too many columns - the memory field itself stores most information
- The embedding column and vector index are created automatically
