import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type Client } from "@libsql/client";

let db: Client;

beforeAll(() => {
  db = createClient({ url: "file::memory:" });
});

afterAll(() => {
  db.close();
});

describe("Table setup", () => {
  it("should create a table with core and freeform columns", async () => {
    await db.batch(
      [
        `CREATE TABLE github_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory TEXT NOT NULL,
          embedding FLOAT32(1536),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          username TEXT,
          category TEXT,
          subject TEXT,
          importance TEXT
        )`,
        `CREATE INDEX idx_github_users_embedding ON github_users (libsql_vector_idx(embedding))`,
      ],
      "write"
    );

    const info = await db.execute({
      sql: "PRAGMA table_info(github_users)",
      args: [],
    });

    const columns = info.rows.map((r) => r.name);
    expect(columns).toContain("id");
    expect(columns).toContain("memory");
    expect(columns).toContain("embedding");
    expect(columns).toContain("created_at");
    expect(columns).toContain("username");
    expect(columns).toContain("category");
    expect(columns).toContain("subject");
    expect(columns).toContain("importance");
  });

  it("should verify vector index was created", async () => {
    const indexes = await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='github_users'",
      args: [],
    });

    const indexNames = indexes.rows.map((r) => r.name);
    expect(indexNames).toContain("idx_github_users_embedding");
  });

  it("should list tables excluding system tables", async () => {
    const result = await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'",
      args: [],
    });

    const names = result.rows.map((r) => r.name);
    expect(names).toContain("github_users");
  });

  it("should drop a table", async () => {
    await db.execute({
      sql: "DROP TABLE IF EXISTS github_users",
      args: [],
    });

    const result = await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='github_users'",
      args: [],
    });

    expect(result.rows.length).toBe(0);
  });
});
