---
description: List all memory tables and their schemas
allowed-tools: Bash, Read
---

# List Memory Tables

List all memory tables in the Turso database and show their schemas.

Run the following:

```bash
cd /Users/gpriday/Projects/MCP/memory && npx tsx -e "
import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const tables = await db.execute({
  sql: \"SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'\",
  args: [],
});

if (tables.rows.length === 0) {
  console.log('No memory tables found.');
} else {
  for (const row of tables.rows) {
    console.log('\n--- ' + row.name + ' ---');
    console.log(row.sql);

    const count = await db.execute({ sql: 'SELECT COUNT(*) as count FROM ' + row.name, args: [] });
    console.log('Rows: ' + count.rows[0].count);
  }
}
"
```

Present the results in a clear format showing each table name, its columns, and row count.
