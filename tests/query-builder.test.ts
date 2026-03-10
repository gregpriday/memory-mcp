import { describe, it, expect } from "vitest";
import { buildSelectQuery, buildVectorSearchQuery, type QueryFilter } from "../src/query-builder.js";

const validColumns = ["id", "memory", "created_at", "category", "subject", "importance"];

describe("buildSelectQuery", () => {
  it("should build a simple select all query", () => {
    const result = buildSelectQuery("test_table", validColumns, {}, validColumns);
    expect(result.sql).toBe("SELECT id, memory, created_at, category, subject, importance FROM test_table");
    expect(result.params).toEqual([]);
  });

  it("should build a query with eq filter", () => {
    const result = buildSelectQuery("test_table", validColumns, {
      filters: [{ field: "category", operator: "eq", value: "preferences" }],
    }, validColumns);

    expect(result.sql).toContain("WHERE category = ?");
    expect(result.params).toEqual(["preferences"]);
  });

  it("should build a query with multiple filters", () => {
    const filters: QueryFilter[] = [
      { field: "category", operator: "eq", value: "preferences" },
      { field: "created_at", operator: "gte", value: "2024-01-01" },
    ];
    const result = buildSelectQuery("test_table", validColumns, { filters }, validColumns);

    expect(result.sql).toContain("WHERE category = ? AND created_at >= ?");
    expect(result.params).toEqual(["preferences", "2024-01-01"]);
  });

  it("should build a query with order_by", () => {
    const result = buildSelectQuery("test_table", validColumns, {
      order_by: { field: "created_at", direction: "desc" },
    }, validColumns);

    expect(result.sql).toContain("ORDER BY created_at DESC");
  });

  it("should build a query with limit", () => {
    const result = buildSelectQuery("test_table", validColumns, { limit: 5 }, validColumns);
    expect(result.sql).toContain("LIMIT ?");
    expect(result.params).toEqual([5]);
  });

  it("should build a full query with filters, order_by, and limit", () => {
    const result = buildSelectQuery("test_table", validColumns, {
      filters: [{ field: "category", operator: "eq", value: "test" }],
      order_by: { field: "created_at", direction: "desc" },
      limit: 10,
    }, validColumns);

    expect(result.sql).toBe(
      "SELECT id, memory, created_at, category, subject, importance FROM test_table WHERE category = ? ORDER BY created_at DESC LIMIT ?"
    );
    expect(result.params).toEqual(["test", 10]);
  });

  it("should handle like operator", () => {
    const result = buildSelectQuery("test_table", validColumns, {
      filters: [{ field: "subject", operator: "like", value: "%John%" }],
    }, validColumns);

    expect(result.sql).toContain("WHERE subject LIKE ?");
    expect(result.params).toEqual(["%John%"]);
  });

  it("should handle in operator", () => {
    const result = buildSelectQuery("test_table", validColumns, {
      filters: [{ field: "category", operator: "in", value: ["a", "b", "c"] }],
    }, validColumns);

    expect(result.sql).toContain("WHERE category IN (?, ?, ?)");
    expect(result.params).toEqual(["a", "b", "c"]);
  });

  it("should handle is_null operator", () => {
    const result = buildSelectQuery("test_table", validColumns, {
      filters: [{ field: "importance", operator: "is_null" }],
    }, validColumns);

    expect(result.sql).toContain("WHERE importance IS NULL");
    expect(result.params).toEqual([]);
  });

  it("should handle is_not_null operator", () => {
    const result = buildSelectQuery("test_table", validColumns, {
      filters: [{ field: "importance", operator: "is_not_null" }],
    }, validColumns);

    expect(result.sql).toContain("WHERE importance IS NOT NULL");
    expect(result.params).toEqual([]);
  });

  it("should reject invalid column names", () => {
    expect(() =>
      buildSelectQuery("test_table", validColumns, {
        filters: [{ field: "malicious; DROP TABLE", operator: "eq", value: "x" }],
      }, validColumns)
    ).toThrow("Invalid column");
  });

  it("should reject invalid column in order_by", () => {
    expect(() =>
      buildSelectQuery("test_table", validColumns, {
        order_by: { field: "nonexistent", direction: "asc" },
      }, validColumns)
    ).toThrow("Invalid column");
  });
});

describe("buildVectorSearchQuery", () => {
  it("should build a vector search query with CROSS JOIN", () => {
    const result = buildVectorSearchQuery("test_table", validColumns, "[0.1,0.2]", 10);

    expect(result.sql).toContain("CROSS JOIN test_table AS m ON m.rowid = v.id");
    expect(result.sql).toContain("vector_top_k('idx_test_table_embedding'");
    expect(result.sql).toContain("vector_distance_cos(m.embedding, vector32(?))");
    expect(result.sql).toContain("ORDER BY distance ASC");
    expect(result.params).toEqual(["[0.1,0.2]", "[0.1,0.2]", 10]);
  });

  it("should NOT use regular JOIN (must be CROSS JOIN)", () => {
    const result = buildVectorSearchQuery("test_table", validColumns, "[0.1]", 5);
    // Make sure it's CROSS JOIN, not plain JOIN
    expect(result.sql).not.toMatch(/\bJOIN\b(?!\s)/); // No standalone JOIN without CROSS prefix
    expect(result.sql).toContain("CROSS JOIN");
  });

  it("should add structured filters to vector search", () => {
    const filters: QueryFilter[] = [
      { field: "category", operator: "eq", value: "preferences" },
    ];
    const result = buildVectorSearchQuery("test_table", validColumns, "[0.1]", 5, filters, validColumns);

    expect(result.sql).toContain("WHERE m.category = ?");
    expect(result.params).toEqual(["[0.1]", "[0.1]", 5, "preferences"]);
  });

  it("should use table alias 'm' for filter columns", () => {
    const filters: QueryFilter[] = [
      { field: "subject", operator: "like", value: "%test%" },
    ];
    const result = buildVectorSearchQuery("test_table", validColumns, "[0.1]", 5, filters, validColumns);

    expect(result.sql).toContain("m.subject LIKE ?");
  });
});
