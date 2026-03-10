---
description: Fully automated NPM release with version detection
argument-hint: [patch|minor|major] (optional - auto-detected if omitted)
allowed-tools:
  - Bash(npm test:*)
  - Bash(npm run build:*)
  - Bash(npm pack:*)
  - Bash(npm whoami:*)
  - Bash(npm publish:*)
  - Bash(npm view:*)
  - Bash(git status:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git tag:*)
  - Bash(git push:*)
  - Bash(git branch:*)
  - Bash(git log:*)
  - Bash(git describe:*)
  - Bash(git diff:*)
  - Bash(node:*)
  - Read
  - Edit
  - Write
---

# Automated NPM Release for @gpriday/memory-mcp

## Current State
- Git status: !`git status`
- Current branch: !`git branch --show-current`
- Latest tag: !`git describe --tags --abbrev=0 2>/dev/null || echo "none"`
- Current version: !`node -p "require('./package.json').version"`
- NPM user: !`npm whoami`
- Changes since last tag: !`git log $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD")..HEAD --oneline 2>/dev/null || echo "No previous tags"`

## Automated Release Process

**IMPORTANT:** This command will automatically:
1. Analyze commit history to determine version bump type
2. Run build and all tests (STOP if any fail)
3. Update package.json version
4. Commit changes
5. Create git tag
6. Publish to NPM
7. Push to origin

### Step 1: Analyze Changes & Determine Version

Version bump override: $ARGUMENTS

**If $ARGUMENTS is empty, auto-detect version bump:**

Read all commits since the last git tag. Analyze commit messages following Conventional Commits:
- **MAJOR** (breaking): Look for "BREAKING CHANGE:", "!" after type (e.g., "feat!:"), or "major:" prefix
- **MINOR** (feature): Look for "feat:", "feature:", new functionality
- **PATCH** (fix): Look for "fix:", "bugfix:", "chore:", "docs:", "refactor:", "test:", "style:", improvements

Rules:
- If any BREAKING CHANGE found → MAJOR bump
- If any feat/feature found (no breaking) → MINOR bump
- Otherwise → PATCH bump
- If no commits since last tag → Ask user if they want to proceed with PATCH

Calculate new version based on current package.json version and bump type.

### Step 2: Pre-Release Validation

1. **Check for Uncommitted Changes**
   - Run `git status --porcelain`
   - If ANY uncommitted changes exist (modified, untracked, or staged files):
     - List all uncommitted changes
     - STOP release process
     - Tell user: "Please commit or stash all changes before running release. The release process will only commit the version bump in package.json."
     - Do NOT proceed with any release steps

2. **Verify Prerequisites**
   - Must be on `main` branch (STOP if not)
   - Run `npm run build` - build must succeed (STOP if fails)
   - Run `npm test` - all tests must pass (STOP if any fail)
   - Run `npm pack --dry-run` to preview package

3. **Verify NPM Authentication**
   - Check `npm whoami` returns "gpriday"
   - If not authenticated, STOP and tell user to run `npm login`

### Step 3: Update Files Automatically

1. **Update package.json**
   - Read current package.json
   - Update `version` field to new calculated version
   - Write back to file

### Step 4: Commit & Tag

Execute these commands sequentially:

```bash
git add package.json
git commit -m "chore: prepare for v[NEW_VERSION] release"
git tag -a v[NEW_VERSION] -m "Release version [NEW_VERSION]

[First 3-5 key changes from commit history]"
```

### Step 5: Publish to NPM

```bash
npm publish --access public
```

**CRITICAL**: `--access public` is required for scoped package `@gpriday/memory-mcp`

### Step 6: Push to Git

```bash
git push origin main
git push origin v[NEW_VERSION]
```

### Step 7: Verify & Report

Run verification:
```bash
npm view @gpriday/memory-mcp version
```

**Report to user:**
- ✅ Version published: [NEW_VERSION]
- ✅ NPM: https://www.npmjs.com/package/@gpriday/memory-mcp
- ✅ Install: `npm install -g @gpriday/memory-mcp`
- ✅ Git tagged and pushed
- **Key changes in this release:**
  [List 5-7 main changes from commit history since last tag]

## Error Handling

**If tests fail:**
- Report which tests failed
- STOP release process
- Tell user to fix tests first

**If build fails:**
- Report the build error
- STOP release process
- Tell user to fix build first

**If git has uncommitted changes:**
- List all uncommitted files
- Tell user: "Please commit or stash all changes before running release"
- Explain: "The release process will only commit the version bump in package.json"
- STOP release process

**If NPM publish fails:**
- Check if version already exists on NPM
- Check NPM authentication
- Report specific error
- STOP (git tag already created, user may need to delete tag)

**If git push fails:**
- Check remote access
- Verify branch is up to date
- Note: Package is already published to NPM
- User may need to force push or resolve conflicts

## Package Details

- Package: `@gpriday/memory-mcp`
- Binary: `memory-mcp`
- License: MIT
- Minimum Node: >=18.0.0
- Scope: @gpriday (requires --access public)
