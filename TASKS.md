# Tasks

## 1. Project scaffolding & configuration

- [ ] Document repository layout + tooling requirements
- [ ] Ensure package.json/tsconfig/scripts cover dev/build/start
- [ ] Capture env vars in .env.example + README
- [ ] Provision config/projects registry template

## 2. Database & migrations

- [ ] Author pgvector migration (extensions, tables, indexes)
- [ ] Seed data scripts for dev
- [ ] Add docs for running migrations (psql commands)
- [ ] Optional migration helper scripts (shell or npm)

## 3. Config & utilities

- [ ] Backend config loader (registry/active project)
- [ ] Embedding config + dimension validation
- [ ] Refinement config + env overrides
- [ ] Debug config + logger + retry helper

## 4. Domain contracts & types

- [ ] IMemoryRepository interface updates (ensureIndex, diagnostics)
- [ ] Memory types/metadata/payload definitions
- [ ] MemorySearchError diagnostics surface
- [ ] Priority calculator & refinement validators

## 5. Postgres repository implementation

- [ ] Pool manager for per-project connection reuse
- [ ] MemoryRepositoryPostgres skeleton
- [ ] Upsert / ensureIndex / relationships sync
- [ ] Search implementation (embedding generation, filters, diagnostics)
- [ ] CRUD helpers (get, delete, list, stats)
- [ ] Access tracking + refinement hooks

## 6. LLM stack

- [ ] LLMClient + embeddings service
- [ ] Prompt assets + manager
- [ ] Tool runtime (search/get/upsert/delete/read/analyze tools)
- [ ] Memorize operation ingestion pipeline
- [ ] MemoryAgent flows (memorize/recall/forget/refine/scan)
- [ ] Index management in MemoryAgent (create/list)

## 7. Server & controller

- [ ] MemoryController handlers for each tool
- [ ] ProjectFileLoader security guard rails
- [ ] IndexResolver default/index validation
- [ ] MemoryServer wiring to Postgres backend
- [ ] STDIO bootstrap + MCP tool schemas

## 8. Prompts & docs

- [ ] Prompt set (base, memorize, recall, forget, refine, analyzer)
- [ ] Prompts README guidance
- [ ] Project README + CURRENT_STATE + TASKS

## 9. Testing & verification

- [ ] (Deferred) Unit/integration tests
- [ ] Manual smoke checklist
- [ ] CI workflow setup

## 10. Operational tasks

- [ ] Env setup instructions
- [ ] Running migrations locally
- [ ] Seeding dev data
- [ ] Manual QA plan
- [ ] Cutover/export/import guidance (optional)
