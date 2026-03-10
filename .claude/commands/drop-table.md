---
description: Drop a memory table from the database
allowed-tools: Bash, Read
argument-hint: <table_name>
---

# Drop Memory Table

**WARNING**: This will permanently delete the table `$1` and all its data.

1. First, show the user the table schema and row count so they understand what they're deleting.
2. Ask for explicit confirmation before proceeding.
3. If confirmed, run:

```bash
cd /Users/gpriday/Projects/MCP/memory && npx tsx -e "
import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

await db.execute({ sql: 'DROP TABLE IF EXISTS $1', args: [] });
console.log('Table $1 dropped successfully.');
"
```
