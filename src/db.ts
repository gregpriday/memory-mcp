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
