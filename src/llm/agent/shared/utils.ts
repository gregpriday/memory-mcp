/**
 * Convert structured filters to the repository filter expression syntax.
 * E.g., { sourcePath: \"path/to/file\", tags: [\"tag1\"] } => '@metadata.sourcePath = \"path/to/file\" AND @metadata.tags CONTAINS \"tag1\"'
 */
export function convertFiltersToExpression(
  filters: Record<string, string | number | boolean | string[]>
): string {
  const expressions: string[] = [];

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;

    const fieldName = `@metadata.${key}`;

    if (typeof value === 'string') {
      expressions.push(`${fieldName} = "${value}"`);
    } else if (typeof value === 'number') {
      expressions.push(`${fieldName} = ${value}`);
    } else if (typeof value === 'boolean') {
      expressions.push(`${fieldName} = ${value}`);
    } else if (Array.isArray(value)) {
      // For arrays, use CONTAINS for each element (joined with OR within the array, AND with other filters)
      const arrayExpressions = (value as (string | number | boolean)[]).map((item) => {
        if (typeof item === 'string') {
          return `${fieldName} CONTAINS "${item}"`;
        } else if (typeof item === 'number') {
          return `${fieldName} CONTAINS ${item}`;
        } else {
          return `${fieldName} CONTAINS ${item}`;
        }
      });
      if (arrayExpressions.length > 0) {
        expressions.push(`(${arrayExpressions.join(' OR ')})`);
      }
    }
  }

  return expressions.join(' AND ');
}

/**
 * Check if filters object contains at least one usable metadata filter value
 * Ensures the hasMetadataFilters flag reflects actual filtering constraints
 */
export function hasUsableMetadataFilters(filters?: Record<string, unknown>): boolean {
  if (!filters) {
    return false;
  }

  return Object.values(filters).some((value) => {
    if (value === null || value === undefined) {
      return false;
    }

    if (Array.isArray(value)) {
      return value.some((entry) => entry !== null && entry !== undefined);
    }

    const valueType = typeof value;
    return valueType === 'string' || valueType === 'number' || valueType === 'boolean';
  });
}

/**
 * Safely parse JSON with enhanced error messages
 * Provides context and preview on parse failures
 */
export function safeJsonParse<T>(payload: string, context: string): T {
  try {
    return JSON.parse(payload) as T;
  } catch (parseError) {
    const preview = payload.substring(0, 200);
    throw new Error(
      `Failed to parse ${context} as JSON. ` +
        `This may indicate an incomplete or truncated response. ` +
        `Error: ${(parseError as Error).message}. ` +
        `Response preview: ${preview}...`
    );
  }
}
