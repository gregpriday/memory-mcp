import { createClient, type Client, type ResultSet } from "@libsql/client";

let client: Client | null = null;

export function getClient(): Client {
  if (client) return client;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL environment variable is required");
  }

  client = createClient({
    url,
    authToken,
  });

  return client;
}

export async function executeQuery(
  sql: string,
  args: (string | number | null)[] = []
): Promise<ResultSet> {
  const db = getClient();
  return db.execute({ sql, args });
}

export async function executeBatch(
  statements: string[]
): Promise<ResultSet[]> {
  const db = getClient();
  return db.batch(statements, "write");
}

export async function getTableSchema(table: string): Promise<string> {
  const db = getClient();
  const result = await db.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
    args: [table],
  });

  if (result.rows.length === 0) {
    throw new Error(`Table '${table}' does not exist`);
  }

  return result.rows[0].sql as string;
}

export async function getTableColumns(
  table: string
): Promise<{ name: string; type: string }[]> {
  const db = getClient();
  const result = await db.execute({
    sql: `PRAGMA table_info(${table})`,
    args: [],
  });

  return result.rows.map((row) => ({
    name: row.name as string,
    type: row.type as string,
  }));
}

export async function tableExists(table: string): Promise<boolean> {
  const db = getClient();
  const result = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: [table],
  });
  return result.rows.length > 0;
}

// --- Table metadata ---

export interface TableMeta {
  tableName: string;
  embeddedFields: string[];
}

export async function ensureMetaTable(): Promise<void> {
  const db = getClient();
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS _memory_meta (
      table_name TEXT PRIMARY KEY,
      embedded_fields TEXT NOT NULL DEFAULT '["memory"]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    args: [],
  });
}

export async function setTableMeta(
  tableName: string,
  embeddedFields: string[]
): Promise<void> {
  await ensureMetaTable();
  const db = getClient();
  await db.execute({
    sql: `INSERT OR REPLACE INTO _memory_meta (table_name, embedded_fields) VALUES (?, ?)`,
    args: [tableName, JSON.stringify(embeddedFields)],
  });
}

export async function getTableMeta(tableName: string): Promise<TableMeta> {
  await ensureMetaTable();
  const db = getClient();
  const result = await db.execute({
    sql: `SELECT embedded_fields FROM _memory_meta WHERE table_name = ?`,
    args: [tableName],
  });

  if (result.rows.length === 0) {
    // Default: just the memory field
    return { tableName, embeddedFields: ["memory"] };
  }

  return {
    tableName,
    embeddedFields: JSON.parse(result.rows[0].embedded_fields as string),
  };
}

export async function deleteTableMeta(tableName: string): Promise<void> {
  await ensureMetaTable();
  const db = getClient();
  await db.execute({
    sql: `DELETE FROM _memory_meta WHERE table_name = ?`,
    args: [tableName],
  });
}
