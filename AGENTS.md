# Repository Guidelines

## Project Structure & Module Organization

- `src/server` exposes the MCP tools and wires transports, configs, and controllers.
- `src/memory`, `src/llm`, and `src/validators` hold repository logic, agent orchestration, and input guards.
- Prompts live in `prompts/` with mode-specific templates; migrations and scripts are under `migrations/` and `scripts/`.
- Configuration files are JSON/TOML-style under `config/`, while build tooling sits at the root (`tsconfig.json`, `eslint.config.js`).

## Build, Test, and Development Commands

- `npm run dev` starts the MCP server with hot reload (`tsx src/index.ts`).
- `npm run build` compiles TypeScript into `dist/`; run `npm start` to execute the compiled build.
- `npm run lint`, `npm run lint:fix`, and `npm run format` enforce style; run before committing.
- Database helpers: `npm run migrate`, `npm run migrate:seed`, and `npm run migrate:verify` run Postgres migrations via `scripts/run-migrations.ts`; `scripts/setup-postgres.sh` provisions pgvector locally.

## Coding Style & Naming Conventions

- TypeScript everywhere (ES2022 target, ESM); prefer explicit exports and descriptive module names mirroring directories.
- Follow Prettier defaults (2-space indent, single quotes) and ESLint rules specified in `eslint.config.js`.
- Use camelCase for variables/functions, PascalCase for classes, and suffix files by role (e.g., `MemoryController.ts`).
- Keep new prompts and config entries ASCII unless an existing file already contains Unicode.

## Testing Guidelines

- No automated test suite yet; treat `npm run lint` and `npm run build` as the minimum validation gate.
- When adding tests, place them beside source files (`*.test.ts`) and wire them into npm scripts before merging.
- Validate database-facing changes with `npm run migrate:verify` against a local Postgres instance.

## Commit & Pull Request Guidelines

- Use concise, imperative commit messages (e.g., `Add pgvector access tracking`) and group related changes.
- Run `npm run format` (or `lint:fix`) before committing; never revert user changes in the working tree.
- PRs should describe intent, reference tasks/issues, and note database or prompt updates; include steps to reproduce or validate when relevant.

## Security & Configuration Tips

- Set `MEMORY_POSTGRES_PROJECT_REGISTRY`, `MEMORY_ACTIVE_PROJECT`, and `OPENAI_API_KEY` locally; never commit secrets.
- When changing embedding models, update both env vars and migration schema (`vector(dimensions)`).
- Use `ProjectFileLoader` safeguards when ingesting files; respect `MEMORY_MAX_FILE_BYTES` to avoid large payload failures.
