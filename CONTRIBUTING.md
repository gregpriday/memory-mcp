# Contributing to Memory MCP

Thank you for your interest in contributing to the Memory MCP server! This guide will help you get started with development, understand our code standards, and navigate the contribution process.

## Table of Contents

- [Before You Start](#before-you-start)
- [Setting Up Your Environment](#setting-up-your-environment)
- [Development Workflow](#development-workflow)
- [Code Quality Standards](#code-quality-standards)
- [Testing Guidelines](#testing-guidelines)
- [Database Changes](#database-changes)
- [Commit Message Conventions](#commit-message-conventions)
- [Pull Request Process](#pull-request-process)
- [Architecture Guidelines](#architecture-guidelines)
- [Reference Documentation](#reference-documentation)
- [Need Help?](#need-help)

## Before You Start

Memory MCP is a **pre-release** project undergoing active development:

- **Breaking changes are acceptable** - We prioritize correctness over backward compatibility
- **Agentic architecture** - The system uses an LLM (GPT-4/5) to orchestrate memory operations
- **PostgreSQL + pgvector** - All memory storage uses PostgreSQL with vector similarity search
- **Multi-layered design** - Respect layer boundaries: MCP → Controller → Agent → Repository

Read the [Architecture documentation](docs/ARCHITECTURE.md) to understand the system design before making changes.

## Setting Up Your Environment

### Prerequisites

Before contributing, ensure you have:

- **PostgreSQL 14+** with pgvector extension
- **Node.js 18+**
- **OpenAI API Key** for embeddings and LLM orchestration
- **Git** for version control

### Quick Setup

```bash
# 1. Clone the repository
git clone <repository-url>
cd memory-mcp

# 2. Install dependencies
npm install

# 3. Set up PostgreSQL database (automated)
./scripts/setup-postgres.sh

# 4. Configure environment
cp .env.example .env
# Edit .env and set your OPENAI_API_KEY

# 5. Verify installation
npm run build
npm run lint
```

### Manual Database Setup

If the automated setup script doesn't work for your environment:

```bash
# Create database
createdb memory_default

# Enable pgvector extension
psql -d memory_default -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Run migrations
psql -d memory_default -f migrations/20250117000001_init_postgres_schema.sql

# Verify tables were created
psql -d memory_default -c "\dt"
```

### Environment Configuration

Copy `.env.example` to `.env` and configure:

```env
# Required
MEMORY_POSTGRES_PROJECT_REGISTRY=./config/projects.json
MEMORY_ACTIVE_PROJECT=local
OPENAI_API_KEY=sk-your-api-key-here

# Embedding configuration
MEMORY_EMBEDDING_MODEL=text-embedding-3-small
MEMORY_EMBEDDING_DIMENSIONS=1536

# Optional debug flags
MEMORY_DEBUG_MODE=true
MEMORY_DEBUG_OPERATIONS=true
```

**Important:** Also update `config/projects.json` with your actual PostgreSQL connection string. The `MEMORY_ACTIVE_PROJECT` value (e.g., `local`) must map to a valid `databaseUrl` in the project registry:

```json
{
  "local": {
    "databaseUrl": "postgresql://postgres:postgres@localhost:5432/memory_default"
  }
}
```

Update the connection string to match your local PostgreSQL setup (username, password, host, port, database name).

**Security:** Never commit `.env` files or credentials to the repository.

## Development Workflow

### Daily Development Loop

```bash
# Start development server with hot reload
npm run dev

# In another terminal, make your changes and test
# The server will automatically reload on file changes

# Before committing, run quality checks
npm run lint:fix
npm run format
npm run build
```

### Available Commands

| Command                  | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `npm run dev`            | Start MCP server in development mode with hot reload (tsx) |
| `npm run build`          | Compile TypeScript to `dist/`                              |
| `npm run start`          | Run compiled server from `dist/`                           |
| `npm run lint`           | Check for linting issues                                   |
| `npm run lint:fix`       | **Auto-fix linting issues**                                |
| `npm run format`         | **Format code with Prettier**                              |
| `npm run format:check`   | Check if code is formatted                                 |
| `npm run migrate`        | Run database migrations                                    |
| `npm run migrate:seed`   | Load test data (optional)                                  |
| `npm run migrate:verify` | Verify migration state                                     |

**Important:** Always run `npm run format` or `npm run lint:fix` before committing to maintain code consistency.

## Code Quality Standards

### TypeScript Requirements

- **TypeScript everywhere** - Use ES2022 target with ESM modules
- **Explicit exports** - Avoid default exports; use named exports
- **Type safety** - Minimize use of `any` (lint warning, not error)
- **Descriptive names** - File names should mirror their directory role

### Code Style

We use **Prettier** and **ESLint** to enforce consistent code style:

**Prettier configuration (`.prettierrc`):**

- 2-space indentation
- Single quotes
- Semicolons required
- 100-character line width
- Trailing commas (ES5 style)
- LF line endings

**ESLint rules (`eslint.config.js`):**

- TypeScript recommended rules enabled
- `@typescript-eslint/no-explicit-any` - warn (not error)
- `@typescript-eslint/no-unused-vars` - warn, ignore vars/args starting with `_`
- Prettier integration for consistent formatting

### Naming Conventions

- **Variables/Functions:** `camelCase`
- **Classes:** `PascalCase`
- **File names:** Suffix by role (e.g., `MemoryController.ts`, `MemoryAgent.ts`)
- **Constants:** `UPPER_SNAKE_CASE` for true constants
- **Interfaces:** Descriptive `PascalCase` names; use `I` prefix only where legacy patterns exist (e.g., `IMemoryRepository`)

### Module Organization

Follow the established project structure:

```
src/
├── server/       # MCP tools and transport layer
├── memory/       # Repository logic and data access
├── llm/          # Agent orchestration and prompts
├── validators/   # Input guards and safety checks
├── config/       # Configuration loaders
└── utils/        # Shared utilities

prompts/          # Prompt templates (composable, versioned)
migrations/       # Database schema migrations
scripts/          # Setup and utility scripts
config/           # JSON/TOML configuration files
```

### Security Best Practices

- **Never commit secrets** - Use `.env` for API keys and database credentials
- **Validate user input** - Use validators in `src/validators/` for all external input
- **Respect file access limits** - `ProjectFileLoader` enforces file size limits and project boundaries
- **Parameterized queries** - All SQL queries use parameterized inputs to prevent injection
- **Embedding dimension validation** - Runtime checks prevent dimension mismatches

## Testing Guidelines

Currently, the project uses **build and lint as the minimum validation gate**:

```bash
# Run before committing
npm run lint
npm run build
```

### Database Change Validation

When making database-related changes:

```bash
# Verify migrations work against local PostgreSQL
npm run migrate:verify

# Test against fresh database
dropdb memory_default && createdb memory_default
psql -d memory_default -f migrations/20250117000001_init_postgres_schema.sql
npm run dev
```

### Future Test Suite

When adding automated tests:

- Place test files beside source files (`*.test.ts`)
- Wire tests into npm scripts before merging
- Test with real PostgreSQL database (no mocks for repository layer)
- Include integration tests for MCP tools

## Database Changes

### Migration Guidelines

The repository provides npm scripts for database migrations that automatically resolve connection strings from your project configuration:

```bash
# Run schema migrations
npm run migrate

# Optional: Load test data
npm run migrate:seed

# Verify migration state
npm run migrate:verify
```

These scripts read the database URL from `config/projects.json` using your `MEMORY_ACTIVE_PROJECT` environment variable.

**Alternative: Manual psql commands**

If you prefer to run migrations manually:

```bash
# Run schema migration directly
psql "postgresql://postgres:postgres@localhost:5432/memory_default" -f migrations/20250117000001_init_postgres_schema.sql

# Optional: Load test data
psql "postgresql://postgres:postgres@localhost:5432/memory_default" -f migrations/seeds/01_test_data.sql
```

Replace the connection string with your actual PostgreSQL credentials.

### Embedding Model Changes

If you change the embedding model, **you must update the database schema**:

1. Update environment variables in `.env`:

   ```env
   MEMORY_EMBEDDING_MODEL=text-embedding-3-large
   MEMORY_EMBEDDING_DIMENSIONS=3072
   ```

2. Update migration file:

   ```sql
   -- Change from vector(1536) to vector(3072)
   ALTER TABLE memories ALTER COLUMN embedding TYPE vector(3072);
   ```

3. Re-embed existing memories (manual operation)

4. Update documentation to reflect the change

**Note:** The system validates embedding dimensions at runtime to prevent mismatches.

### Schema Change Checklist

When modifying database schema:

- [ ] Update migration files in `migrations/`
- [ ] Update TypeScript types in `src/memory/types.ts`
- [ ] Update `IMemoryRepository` interface if needed
- [ ] Test migration on fresh database
- [ ] Run `npm run migrate:verify`
- [ ] Document changes in PR description

## Commit Message Conventions

Use **concise, imperative commit messages** that describe what the change does:

### Format

```
Add feature X to component Y
Fix bug in Z when condition occurs
Refactor module A for better performance
Update documentation for feature B
```

### Examples

✅ **Good:**

- `Add pgvector access tracking to searchMemories`
- `Fix embedding dimension validation in MemoryRepository`
- `Refactor PromptManager to support versioned prompts`
- `Update ARCHITECTURE.md with refinement lifecycle`

❌ **Bad:**

- `WIP changes` (too vague)
- `Fixed stuff` (not descriptive)
- `Added feature and also fixed bugs and updated docs` (too much in one commit)

### Commit Guidelines

- **Group related changes** - One logical change per commit
- **Write clear descriptions** - Focus on what and why, not how
- **Reference issues** - Include issue numbers when applicable (e.g., `Fix #42`)
- **Keep commits atomic** - Each commit should leave the codebase in a working state

## Pull Request Process

### Before Submitting

1. **Run quality checks:**

   ```bash
   npm run lint:fix
   npm run format
   npm run build
   ```

2. **Test your changes:**
   - Verify MCP server starts without errors (`npm run dev`)
   - Test affected functionality manually
   - Run `npm run migrate:verify` if database changes were made

3. **Review your changes:**
   - Remove debug logging
   - Check for commented-out code
   - Ensure no sensitive data is committed

### PR Description Template

```markdown
## Summary

Brief description of what this PR does.

## Changes

- Bullet point list of key changes
- Include affected components/files

## Testing

- Steps to reproduce/verify the changes
- What scenarios were tested

## Database Impact

- Does this change the schema? (Yes/No)
- Migration steps if applicable

## Breaking Changes

- List any breaking changes (acceptable in pre-release)
- Migration guide if needed

## Related Issues

Closes #123
Related to #456
```

### PR Review Criteria

Reviewers will check:

- **Architecture alignment** - Does this respect layer boundaries?
- **Code quality** - Lint and format checks pass?
- **Type safety** - Minimal use of `any`, proper TypeScript usage?
- **Security** - No secrets committed, proper input validation?
- **Documentation** - Are changes explained in PR description?
- **Database safety** - Are migrations tested and documented?
- **Prompt changes** - Are prompt updates intentional and documented?

### Review Process

1. Open a PR with descriptive title and complete description
2. Link related issues and reference acceptance criteria
3. Respond to review feedback promptly
4. Run `npm run format` after addressing feedback
5. Squash fixup commits before merging (optional)

## Architecture Guidelines

### Respect Layer Boundaries

Never bypass abstraction layers:

```
MCP Layer (MemoryServer.ts)
    ↓ delegates to
Controller Layer (MemoryController.ts)
    ↓ orchestrates
Agent Layer (MemoryAgent.ts + ToolRuntime.ts)
    ↓ uses
Repository Layer (MemoryRepositoryPostgres.ts)
```

**Don't:**

- Call repository methods directly from MCP layer
- Access database from agent layer
- Bypass security validators in controller layer

### Key Patterns to Follow

**Index Resolution:**

- Indexes are database rows, not files
- Use `IndexResolver.resolve()` to handle default index logic
- Call `repo.ensureIndex(name, description)` to create/get indexes

**Access Tracking:**

- `searchMemories()` triggers fire-and-forget `updateAccessStats()`
- Priority scores update automatically using `PriorityCalculator`
- Top N results are tracked (configurable via `MEMORY_ACCESS_TRACKING_TOP_N`)

**Prompt Composition:**

- Use `PromptManager.composePrompt()` to build system messages
- Prompts are composable: base + mode + classification + context
- See `prompts/README.md` for versioning and structure

**Error Handling:**

- Use structured errors (e.g., `MemorySearchError`) with diagnostics
- Include context: index, query, status, duration, retry count
- Log to stderr for MCP compatibility

### Security Constraints

- **ProjectFileLoader** restricts file reads to project root with size limits
- **Environment variables** must never be committed (use `.env`)
- **Embedding dimensions** must match database schema (runtime validation)
- **Filter DSL** uses parameterized queries to prevent SQL injection

## Reference Documentation

Essential reading for contributors:

- **[README.md](README.md)** - Onboarding, setup, and usage guide
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** - System design and data flows
- **[AGENTS.md](AGENTS.md)** - Concise repository rules and conventions
- **[CLAUDE.md](CLAUDE.md)** - Context for Claude Code when working on this repo
- **[prompts/README.md](prompts/README.md)** - Prompt composition and versioning
- **[src/memory/types.ts](src/memory/types.ts)** - Core domain types
- **[src/memory/IMemoryRepository.ts](src/memory/IMemoryRepository.ts)** - Repository contract

### Additional Resources

- **Migration scripts:** `migrations/20250117000001_init_postgres_schema.sql`
- **Setup scripts:** `scripts/setup-postgres.sh`, `scripts/run-migrations.ts`
- **Configuration:** `config/projects.json`, `src/config/backend.ts`, `src/config/embedding.ts`

## Need Help?

### Getting Unstuck

- **Review the architecture** - Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) to understand system design
- **Check existing code** - Look for similar patterns in the codebase
- **Read the prompts** - Agent behavior is defined in `prompts/` directory
- **Enable debug logging** - Set `MEMORY_DEBUG_*` environment variables

### Reporting Issues

When filing issues:

- Include steps to reproduce
- Provide error messages and stack traces
- Mention your environment (OS, Node version, PostgreSQL version)
- Note which commands you ran before the error occurred

### Asking Questions

- **Architecture questions** - Reference specific layers or components
- **Code review questions** - Ask about patterns and conventions
- **Database questions** - Describe your use case and current approach
- **Prompt questions** - Include the mode and context where the prompt is used

---

**Thank you for contributing to Memory MCP!** Your work helps build a more intelligent and capable memory system for AI assistants.
