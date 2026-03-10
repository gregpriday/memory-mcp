import { executeBatch, tableExists, getClient, setTableMeta, deleteTableMeta } from "./db.js";
import { getEmbeddingDimensions } from "./embeddings.js";

export interface TableColumn {
  name: string;
  type: string;
  description?: string;
}

export interface CreateTableOptions {
  /** Custom freeform columns beyond the core ones */
  freeformColumns: TableColumn[];
  /**
   * Which text fields contribute to the vector embedding.
   * Defaults to ["memory"]. When multiple fields are specified,
   * their values are concatenated (with field labels) before embedding.
   * Example: ["title", "body"] — the embedding is generated from "title: ... body: ..."
   */
  embeddedFields?: string[];
}

export async function createMemoryTable(
  tableName: string,
  freeformColumns: TableColumn[],
  embeddedFields?: string[]
): Promise<void> {
  const exists = await tableExists(tableName);
  if (exists) {
    throw new Error(`Table '${tableName}' already exists`);
  }

  const dimensions = getEmbeddingDimensions();

  // Validate embedded fields reference valid columns
  const allColumnNames = ["memory", ...freeformColumns.map((c) => c.name)];
  const resolvedEmbeddedFields = embeddedFields ?? ["memory"];
  for (const ef of resolvedEmbeddedFields) {
    if (!allColumnNames.includes(ef)) {
      throw new Error(
        `Embedded field '${ef}' is not a valid column. Valid columns: ${allColumnNames.join(", ")}`
      );
    }
  }

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

  // Store metadata about which fields contribute to embeddings
  await setTableMeta(tableName, resolvedEmbeddedFields);
}

export async function dropMemoryTable(tableName: string): Promise<void> {
  const exists = await tableExists(tableName);
  if (!exists) {
    throw new Error(`Table '${tableName}' does not exist`);
  }

  const db = getClient();
  await db.execute({ sql: `DROP TABLE ${tableName}`, args: [] });
  await deleteTableMeta(tableName);
}

export async function listMemoryTables(): Promise<string[]> {
  const db = getClient();
  const result = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' AND name != '_memory_meta'",
    args: [],
  });

  return result.rows.map((r) => r.name as string);
}
