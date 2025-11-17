# Contributing to Memory MCP

Thank you for contributing to the Memory MCP server project!

## Development Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/gregpriday/memory-mcp.git
   cd memory-mcp
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

   This will automatically set up pre-commit hooks via Husky.

3. **Set up the database**
   Follow the database setup instructions in the main README.

## Pre-commit Hooks

This project uses [Husky](https://typicode.github.io/husky/) and [lint-staged](https://github.com/lint-staged/lint-staged) to automatically enforce code quality standards before each commit.

### What Happens on Commit

When you run `git commit`, the pre-commit hook will automatically:

1. **Format your code** with Prettier
2. **Lint your code** with ESLint
3. **Block the commit** if there are any linting errors or warnings

Only staged files are checked, so the process is fast even in a large codebase.

### Supported File Types

- **TypeScript/JavaScript** (`.ts`, `.tsx`, `.js`): Formatted with Prettier, linted with ESLint
- **JSON/Markdown** (`.json`, `.md`): Formatted with Prettier

### If the Pre-commit Hook Fails

If the hook detects linting errors or warnings:

1. **Review the errors/warnings** displayed in your terminal
2. **Fix the issues** manually, or run:
   ```bash
   npm run lint:fix
   ```
3. **Re-stage the fixed files**:
   ```bash
   git add .
   ```
4. **Try committing again**:
   ```bash
   git commit -m "Your commit message"
   ```

**Note**: The pre-commit hook enforces zero warnings (`--max-warnings=0`), so ESLint warnings will prevent commits even though `npm run lint` may allow them. This ensures new code maintains high quality standards.

### Manual Code Quality Checks

You can manually run formatting and linting at any time:

```bash
# Format all files
npm run format

# Check formatting without modifying files
npm run format:check

# Lint all files
npm run lint

# Auto-fix linting issues
npm run lint:fix
```

### Bypassing Hooks (Emergency Only)

In rare cases where you need to commit without running hooks:

```bash
HUSKY=0 git commit -m "Emergency fix"
```

**⚠️ Warning**: Only use this for emergencies. Bypassing hooks can introduce code quality issues.

### Debugging Hooks

If you encounter issues with the pre-commit hook:

1. **Check which files are being processed**:

   ```bash
   npx lint-staged --debug
   ```

2. **Verify Husky is installed**:

   ```bash
   ls -la .husky/pre-commit
   ```

3. **Manually run lint-staged**:

   ```bash
   npx lint-staged
   ```

4. **Repair broken hooks**:
   If the hook file is missing or corrupted, regenerate it:
   ```bash
   npm run prepare
   ```
   Or reinstall all dependencies:
   ```bash
   npm install
   ```

## Node.js Version

This project requires Node.js 18 or later. Check your version:

```bash
node --version
```

## Questions?

If you have questions about contributing, please open an issue on GitHub.
