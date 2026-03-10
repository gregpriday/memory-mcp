---
description: Set up GitHub-specific memory tables with pre-built schemas for users, issues, and patterns
allowed-tools: Bash, Read, Write, Edit
argument-hint: [table_type]
---

# Link GitHub Setup

You are setting up GitHub-specific memory tables for the Memory MCP system.

## Step 1: Discover the current repository

Run this command to get the current repo context:

```bash
gh repo view --json nameWithOwner,description,defaultBranchRef,repositoryTopics,url 2>/dev/null || echo "GH_CLI_UNAVAILABLE"
```

If the `gh` CLI is unavailable or unauthenticated, ask the user for their GitHub repo owner and name (e.g., `octocat/my-repo`). Otherwise, extract the repo info from the JSON output and confirm it with the user.

## Step 2: Check for existing tables

Before creating any tables, check what already exists:

```bash
npx tsx -e "
import { listMemoryTables } from './src/table-setup.js';
const tables = await listMemoryTables();
console.log(tables.length ? tables.join(', ') : 'No tables found');
"
```

Warn the user if any of the target table names already exist.

## Step 3: Choose table presets

If `$ARGUMENTS` was provided, use it to select the preset(s). Otherwise, present the user with the available presets and let them choose one or more:

### Preset 1: `github_users`

Track GitHub contributors, their communication style, and how to interact with them.

| Column | Type | Description |
|--------|------|-------------|
| `username` | TEXT | GitHub username |
| `role` | TEXT | Their role (maintainer, contributor, reviewer, etc.) |
| `category` | TEXT | Type of memory (communication_style, preferences, expertise, etc.) |
| `importance` | TEXT | Priority level (low, medium, high) |

```bash
npx tsx -e "
import { createMemoryTable } from './src/table-setup.js';

await createMemoryTable('github_users', [
  { name: 'username', type: 'TEXT', description: 'GitHub username' },
  { name: 'role', type: 'TEXT', description: 'Their role (maintainer, contributor, reviewer, etc.)' },
  { name: 'category', type: 'TEXT', description: 'Type of memory (communication_style, preferences, expertise, etc.)' },
  { name: 'importance', type: 'TEXT', description: 'Priority level (low, medium, high)' },
]);
console.log('Table github_users created successfully!');
"
```

### Preset 2: `github_issues`

Track issue and PR context, decisions, and outcomes.

| Column | Type | Description |
|--------|------|-------------|
| `issue_number` | INTEGER | GitHub issue or PR number |
| `state` | TEXT | Current state (open, closed, merged, etc.) |
| `labels` | TEXT | Comma-separated labels |
| `author` | TEXT | Issue/PR author username |
| `category` | TEXT | Type of memory (decision, context, resolution, blocker, etc.) |

```bash
npx tsx -e "
import { createMemoryTable } from './src/table-setup.js';

await createMemoryTable('github_issues', [
  { name: 'issue_number', type: 'INTEGER', description: 'GitHub issue or PR number' },
  { name: 'state', type: 'TEXT', description: 'Current state (open, closed, merged, etc.)' },
  { name: 'labels', type: 'TEXT', description: 'Comma-separated labels' },
  { name: 'author', type: 'TEXT', description: 'Issue/PR author username' },
  { name: 'category', type: 'TEXT', description: 'Type of memory (decision, context, resolution, blocker, etc.)' },
]);
console.log('Table github_issues created successfully!');
"
```

### Preset 3: `github_patterns`

Track codebase patterns, conventions, and architectural decisions.

| Column | Type | Description |
|--------|------|-------------|
| `pattern_type` | TEXT | Type of pattern (convention, architecture, error_handling, testing, etc.) |
| `file_path` | TEXT | Relevant file or directory path |
| `language` | TEXT | Programming language |
| `importance` | TEXT | Priority level (low, medium, high) |

```bash
npx tsx -e "
import { createMemoryTable } from './src/table-setup.js';

await createMemoryTable('github_patterns', [
  { name: 'pattern_type', type: 'TEXT', description: 'Type of pattern (convention, architecture, error_handling, testing, etc.)' },
  { name: 'file_path', type: 'TEXT', description: 'Relevant file or directory path' },
  { name: 'language', type: 'TEXT', description: 'Programming language' },
  { name: 'importance', type: 'TEXT', description: 'Priority level (low, medium, high)' },
]);
console.log('Table github_patterns created successfully!');
"
```

## Step 4: Confirm and create

For each selected preset:
1. Confirm the table name and columns with the user (they can customize column names or add/remove columns).
2. Run the corresponding creation script.
3. Verify the table was created by listing tables again.

## Step 5: Show usage examples

After creating the tables, show the user how to use them with the MCP tools:

**For `github_users`:**
> remember into github_users: octocat is a maintainer who prefers concise PR reviews and uses conventional commits

**For `github_issues`:**
> remember into github_issues: Issue #42 was closed after we decided to use Redis instead of in-memory caching. The key blocker was session persistence across deploys.

**For `github_patterns`:**
> remember into github_patterns: This repo uses barrel exports in src/index.ts. All new modules should be re-exported from there.

## Notes

- Table names can be customized. The presets above are suggestions.
- You can create all three tables or just the ones relevant to your workflow.
- Use `/list-tables` to see existing tables and `/drop-table <name>` to remove one.
- After setup, the `remember`, `recall`, `forget`, and `process` MCP tools work with these tables using plain English.
