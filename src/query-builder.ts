/**
 * Query builder that translates structured query objects into parameterized SQL.
 * Replaces raw SQL generation by the LLM — eliminates SQL injection entirely.
 */

export interface QueryFilter {
  field: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "in" | "is_null" | "is_not_null";
  value?: string | number | (string | number)[];
}

export interface OrderBy {
  field: string;
  direction: "asc" | "desc";
}

export interface StructuredQuery {
  filters?: QueryFilter[];
  order_by?: OrderBy;
  limit?: number;
}

interface BuiltQuery {
  sql: string;
  params: (string | number | null)[];
}

const VALID_OPERATORS: Record<QueryFilter["operator"], string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
  in: "IN",
  is_null: "IS NULL",
  is_not_null: "IS NOT NULL",
};

function validateIdentifier(name: string, validColumns: string[]): string {
  if (!validColumns.includes(name)) {
    throw new Error(`Invalid column: '${name}'. Valid columns: ${validColumns.join(", ")}`);
  }
  return name;
}

function buildWhereClause(
  filters: QueryFilter[],
  validColumns: string[],
  tableAlias?: string
): { clause: string; params: (string | number | null)[] } {
  if (filters.length === 0) return { clause: "", params: [] };

  const conditions: string[] = [];
  const params: (string | number | null)[] = [];
  const prefix = tableAlias ? `${tableAlias}.` : "";

  for (const filter of filters) {
    const col = validateIdentifier(filter.field, validColumns);
    const sqlOp = VALID_OPERATORS[filter.operator];

    if (filter.operator === "is_null" || filter.operator === "is_not_null") {
      conditions.push(`${prefix}${col} ${sqlOp}`);
    } else if (filter.operator === "in") {
      if (!Array.isArray(filter.value)) {
        throw new Error(`'in' operator requires an array value for field '${col}'`);
      }
      const placeholders = filter.value.map(() => "?").join(", ");
      conditions.push(`${prefix}${col} IN (${placeholders})`);
      params.push(...(filter.value as (string | number)[]));
    } else {
      if (filter.value === undefined || filter.value === null) {
        throw new Error(`Operator '${filter.operator}' requires a value for field '${col}'`);
      }
      conditions.push(`${prefix}${col} ${sqlOp} ?`);
      params.push(filter.value as string | number);
    }
  }

  return { clause: `WHERE ${conditions.join(" AND ")}`, params };
}

export function buildSelectQuery(
  tableName: string,
  columns: string[],
  query: StructuredQuery,
  validColumns: string[]
): BuiltQuery {
  const selectCols = columns.map((c) => validateIdentifier(c, validColumns)).join(", ");
  let sql = `SELECT ${selectCols} FROM ${tableName}`;
  const params: (string | number | null)[] = [];

  if (query.filters && query.filters.length > 0) {
    const where = buildWhereClause(query.filters, validColumns);
    sql += ` ${where.clause}`;
    params.push(...where.params);
  }

  if (query.order_by) {
    const col = validateIdentifier(query.order_by.field, validColumns);
    const dir = query.order_by.direction === "desc" ? "DESC" : "ASC";
    sql += ` ORDER BY ${col} ${dir}`;
  }

  if (query.limit != null && query.limit > 0) {
    sql += ` LIMIT ?`;
    params.push(query.limit);
  }

  return { sql, params };
}

export function buildVectorSearchQuery(
  tableName: string,
  columns: string[],
  vectorStr: string,
  limit: number,
  filters?: QueryFilter[],
  validColumns?: string[]
): BuiltQuery {
  const selectCols = columns.map((c) => `m.${c}`).join(", ");

  // Use CROSS JOIN as required by Turso for hybrid vector + SQL search
  let sql = `
    SELECT ${selectCols},
      vector_distance_cos(m.embedding, vector32(?)) AS distance
    FROM vector_top_k('idx_${tableName}_embedding', vector32(?), ?) AS v
    CROSS JOIN ${tableName} AS m ON m.rowid = v.id
  `;

  const params: (string | number | null)[] = [vectorStr, vectorStr, limit];

  if (filters && filters.length > 0 && validColumns) {
    const where = buildWhereClause(filters, validColumns, "m");
    sql += ` ${where.clause}`;
    params.push(...where.params);
  }

  sql += " ORDER BY distance ASC";

  return { sql, params };
}
