import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type Client } from "@libsql/client";

// Use an in-memory database for tests
let db: Client;

beforeAll(() => {
  db = createClient({ url: "file::memory:" });
});

afterAll(() => {
  db.close();
});

describe("Database operations", () => {
  it("should create a table with vector column", async () => {
    await db.batch(
      [
        `CREATE TABLE test_memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory TEXT NOT NULL,
          embedding FLOAT32(1536),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          category TEXT,
          subject TEXT
        )`,
        `CREATE INDEX idx_test_memories_embedding ON test_memories (libsql_vector_idx(embedding))`,
      ],
      "write"
    );

    const schema = await db.execute({
      sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='test_memories'",
      args: [],
    });

    expect(schema.rows.length).toBe(1);
    expect(schema.rows[0].sql).toContain("memory TEXT NOT NULL");
    expect(schema.rows[0].sql).toContain("FLOAT32(1536)");
  });

  it("should insert a memory with text fields", async () => {
    const result = await db.execute({
      sql: "INSERT INTO test_memories (memory, created_at, category, subject) VALUES (?, ?, ?, ?)",
      args: [
        "John prefers formal communication",
        new Date().toISOString(),
        "communication_style",
        "John Doe",
      ],
    });

    expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);
  });

  it("should query memories by field", async () => {
    const result = await db.execute({
      sql: "SELECT * FROM test_memories WHERE subject = ?",
      args: ["John Doe"],
    });

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].memory).toBe(
      "John prefers formal communication"
    );
    expect(result.rows[0].category).toBe("communication_style");
  });

  it("should list tables", async () => {
    const result = await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'",
      args: [],
    });

    const names = result.rows.map((r) => r.name);
    expect(names).toContain("test_memories");
  });

  it("should get table info via PRAGMA", async () => {
    const result = await db.execute({
      sql: "PRAGMA table_info(test_memories)",
      args: [],
    });

    const columns = result.rows.map((r) => r.name);
    expect(columns).toContain("id");
    expect(columns).toContain("memory");
    expect(columns).toContain("embedding");
    expect(columns).toContain("created_at");
    expect(columns).toContain("category");
    expect(columns).toContain("subject");
  });

  it("should delete a memory", async () => {
    await db.execute({
      sql: "DELETE FROM test_memories WHERE subject = ?",
      args: ["John Doe"],
    });

    const result = await db.execute({
      sql: "SELECT COUNT(*) as count FROM test_memories",
      args: [],
    });

    expect(Number(result.rows[0].count)).toBe(0);
  });

  it("should update a memory", async () => {
    // Insert first
    await db.execute({
      sql: "INSERT INTO test_memories (memory, created_at, category, subject) VALUES (?, ?, ?, ?)",
      args: [
        "Jane likes TypeScript",
        new Date().toISOString(),
        "preferences",
        "Jane Smith",
      ],
    });

    // Update
    await db.execute({
      sql: "UPDATE test_memories SET memory = ? WHERE subject = ?",
      args: ["Jane strongly prefers TypeScript over JavaScript", "Jane Smith"],
    });

    const result = await db.execute({
      sql: "SELECT memory FROM test_memories WHERE subject = ?",
      args: ["Jane Smith"],
    });

    expect(result.rows[0].memory).toBe(
      "Jane strongly prefers TypeScript over JavaScript"
    );
  });
});
