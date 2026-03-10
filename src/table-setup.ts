import { executeBatch, tableExists, getClient } from "./db.js";
import { getEmbeddingDimensions } from "./embeddings.js";

export interface TableColumn {
  name: string;
  type: string;
  description?: string;
}

export async function createMemoryTable(
  tableName: string,
  freeformColumns: TableColumn[]
): Promise<void> {
  const exists = await tableExists(tableName);
  if (exists) {
    throw new Error(`Table '${tableName}' already exists`);
  }

  const dimensions = getEmbeddingDimensions();

  // Build column definitions
  const columnDefs = [
    "id INTEGER PRIMARY KEY AUTOINCREMENT",
    "memory TEXT NOT NULL",
    `embedding FLOAT32(${dimensions})`,
    "created_at TEXT NOT NULL DEFAULT (datetime('now'))",
    ...freeformColumns.map((col) => `${col.name} ${col.type}`),
  ];

  const createTableSQL = `CREATE TABLE ${tableName} (${columnDefs.join(", ")})`;
  const createIndexSQL = `CREATE INDEX idx_${tableName}_embedding ON ${tableName} (libsql_vector_idx(embedding))`;

  await executeBatch([createTableSQL, createIndexSQL]);
}

export async function dropMemoryTable(tableName: string): Promise<void> {
  const exists = await tableExists(tableName);
  if (!exists) {
    throw new Error(`Table '${tableName}' does not exist`);
  }

  const db = getClient();
  await db.execute({ sql: `DROP TABLE ${tableName}`, args: [] });
}

export async function listMemoryTables(): Promise<string[]> {
  const db = getClient();
  const result = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'",
    args: [],
  });

  return result.rows.map((r) => r.name as string);
}
