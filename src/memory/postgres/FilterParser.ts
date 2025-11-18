/**
 * Filter Expression Parser and SQL Translator
 *
 * Parses a filter expression DSL and translates it to safe PostgreSQL WHERE clauses
 * with parameter binding to prevent SQL injection. This parser implements a recursive
 * descent algorithm with proper operator precedence (NOT > AND > OR).
 *
 * @remarks
 * **DSL Syntax:**
 * - Supported operators: `=`, `==` (equivalent to `=`), `CONTAINS`
 * - Supported types: Strings (double-quoted), Numbers, Booleans (`true`, `false`)
 * - Logical operators: `AND`, `OR`, parentheses for grouping
 * - Field access: `@id` for memory ID, `@metadata.fieldName` for metadata properties
 *
 * **Denormalized Fields:**
 * The following metadata fields map directly to database columns for performance:
 * - `topic`, `importance`, `tags`, `source`, `sourcePath`, `kind`, `memoryType`
 *
 * **JSONB Fields:**
 * Custom metadata fields not in the denormalized list are accessed via JSONB operators.
 * Field names must be alphanumeric with underscores or hyphens only (prevents injection).
 *
 * **Security:**
 * - All values are parameterized using PostgreSQL's `$1`, `$2`, etc. placeholders
 * - Field names are validated against whitelist or sanitized for JSONB access
 * - No dynamic SQL construction that could lead to injection
 *
 * **Examples:**
 * ```
 * @metadata.tags CONTAINS "work"
 * @metadata.priority > 0.5 AND @metadata.source = "slack"
 * (@metadata.kind = "note" OR @metadata.kind = "task") AND @metadata.importance = "high"
 * ```
 *
 * **Grammar (BNF):**
 * ```
 * Expression := OrExpression
 * OrExpression := AndExpression ('OR' AndExpression)*
 * AndExpression := Primary ('AND' Primary)*
 * Primary := '(' Expression ')' | Comparison
 * Comparison := Field Operator Literal
 * Field := '@id' | '@metadata' | '@metadata.' Identifier
 * Operator := '=' | '==' | 'CONTAINS'
 * Literal := String | Number | Boolean
 * ```
 *
 * @internal
 */

// ============================================================================
// AST Node Types
// ============================================================================

export type ASTNode = LogicalNode | ComparisonNode;

export interface LogicalNode {
  type: 'logical';
  operator: 'AND' | 'OR';
  left: ASTNode;
  right: ASTNode;
}

export interface ComparisonNode {
  type: 'comparison';
  operator: '=' | '==' | 'CONTAINS';
  field: FieldNode;
  value: LiteralNode;
}

export interface FieldNode {
  type: 'field';
  source: 'id' | 'metadata';
  name?: string; // undefined for @metadata (root), defined for @metadata.fieldName
}

export interface LiteralNode {
  type: 'literal';
  value: string | number | boolean;
}

// ============================================================================
// Token Types
// ============================================================================

type TokenType =
  | 'FIELD'
  | 'OPERATOR'
  | 'STRING'
  | 'NUMBER'
  | 'BOOLEAN'
  | 'AND'
  | 'OR'
  | 'LPAREN'
  | 'RPAREN'
  | 'EOF';

interface Token {
  type: TokenType;
  value: string | number | boolean;
  position: number;
}

// ============================================================================
// Tokenizer
// ============================================================================

class Tokenizer {
  private pos = 0;
  private input: string;

  constructor(input: string) {
    this.input = input.trim();
  }

  private peek(): string {
    return this.input[this.pos] || '';
  }

  private advance(): string {
    return this.input[this.pos++] || '';
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length && /\s/.test(this.peek())) {
      this.advance();
    }
  }

  /**
   * Read a double-quoted string literal with escape sequence support.
   * Supports \" for escaped quotes within strings.
   */
  private readString(): string {
    // Expect opening quote
    this.advance(); // skip opening "

    let value = '';
    while (this.pos < this.input.length && this.peek() !== '"') {
      const ch = this.advance();
      // Handle basic escape sequences
      if (ch === '\\' && this.peek() === '"') {
        value += this.advance(); // escaped quote: \" becomes "
      } else {
        value += ch;
      }
    }

    // Validate string was properly closed
    if (this.peek() !== '"') {
      throw new Error(`Unterminated string at position ${this.pos}`);
    }

    this.advance(); // skip closing "
    return value;
  }

  private readNumber(): number {
    let numStr = '';
    // Handle negative sign
    if (this.peek() === '-') {
      numStr += this.advance();
    }
    while (this.pos < this.input.length && /[0-9.]/.test(this.peek())) {
      numStr += this.advance();
    }

    // Validate numeric format to catch malformed inputs like "1.2.3"
    if (!/^-?\d+(\.\d+)?$/.test(numStr)) {
      throw new Error(`Invalid number format: ${numStr}`);
    }

    return parseFloat(numStr);
  }

  private readIdentifier(): string {
    let ident = '';
    while (this.pos < this.input.length && /[a-zA-Z0-9_.-]/.test(this.peek())) {
      ident += this.advance();
    }
    return ident;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];

    while (this.pos < this.input.length) {
      this.skipWhitespace();

      if (this.pos >= this.input.length) {
        break;
      }

      const startPos = this.pos;
      const ch = this.peek();

      // Parentheses
      if (ch === '(') {
        this.advance();
        tokens.push({ type: 'LPAREN', value: '(', position: startPos });
        continue;
      }

      if (ch === ')') {
        this.advance();
        tokens.push({ type: 'RPAREN', value: ')', position: startPos });
        continue;
      }

      // String literals
      if (ch === '"') {
        const value = this.readString();
        tokens.push({ type: 'STRING', value, position: startPos });
        continue;
      }

      // Numbers (including negative numbers)
      if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(this.input[this.pos + 1] || ''))) {
        const value = this.readNumber();
        tokens.push({ type: 'NUMBER', value, position: startPos });
        continue;
      }

      // Field access (@id, @metadata, @metadata.field)
      if (ch === '@') {
        this.advance(); // skip @
        const ident = this.readIdentifier();
        tokens.push({ type: 'FIELD', value: `@${ident}`, position: startPos });
        continue;
      }

      // Identifiers and keywords
      if (/[a-zA-Z_]/.test(ch)) {
        const ident = this.readIdentifier();

        // Keywords
        if (ident === 'AND') {
          tokens.push({ type: 'AND', value: 'AND', position: startPos });
        } else if (ident === 'OR') {
          tokens.push({ type: 'OR', value: 'OR', position: startPos });
        } else if (ident === 'CONTAINS') {
          tokens.push({ type: 'OPERATOR', value: 'CONTAINS', position: startPos });
        } else if (ident === 'true' || ident === 'false') {
          tokens.push({ type: 'BOOLEAN', value: ident === 'true', position: startPos });
        } else {
          throw new Error(`Unexpected identifier '${ident}' at position ${startPos}`);
        }
        continue;
      }

      // Operators (=, ==)
      if (ch === '=') {
        this.advance();
        if (this.peek() === '=') {
          this.advance();
          tokens.push({ type: 'OPERATOR', value: '==', position: startPos });
        } else {
          tokens.push({ type: 'OPERATOR', value: '=', position: startPos });
        }
        continue;
      }

      throw new Error(`Unexpected character '${ch}' at position ${this.pos}`);
    }

    tokens.push({ type: 'EOF', value: '', position: this.pos });
    return tokens;
  }
}

// ============================================================================
// Parser
// ============================================================================

class Parser {
  private tokens: Token[];
  private current = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.current];
  }

  private advance(): Token {
    if (this.current < this.tokens.length) {
      return this.tokens[this.current++];
    }
    return this.tokens[this.tokens.length - 1]; // EOF
  }

  private match(...types: TokenType[]): boolean {
    return types.includes(this.peek().type);
  }

  private expect(type: TokenType, message: string): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new Error(`${message} at position ${token.position}. Got ${token.type}`);
    }
    return this.advance();
  }

  /**
   * Parse the entire filter expression.
   * Entry point for the recursive descent parser.
   *
   * Expression := OrExpression
   */
  parse(): ASTNode {
    const expr = this.parseOrExpression();
    this.expect('EOF', 'Expected end of input');
    return expr;
  }

  /**
   * Parse OR expressions (lowest precedence).
   * OR has lower precedence than AND, so it's evaluated last.
   *
   * OrExpression := AndExpression ('OR' AndExpression)*
   */
  private parseOrExpression(): ASTNode {
    let left = this.parseAndExpression();

    // Build left-associative tree: A OR B OR C becomes ((A OR B) OR C)
    while (this.match('OR')) {
      this.advance(); // consume OR
      const right = this.parseAndExpression();
      left = {
        type: 'logical',
        operator: 'OR',
        left,
        right,
      };
    }

    return left;
  }

  /**
   * Parse AND expressions (higher precedence than OR).
   * This means "A OR B AND C" is parsed as "A OR (B AND C)".
   *
   * AndExpression := Primary ('AND' Primary)*
   */
  private parseAndExpression(): ASTNode {
    let left = this.parsePrimary();

    // Build left-associative tree: A AND B AND C becomes ((A AND B) AND C)
    while (this.match('AND')) {
      this.advance(); // consume AND
      const right = this.parsePrimary();
      left = {
        type: 'logical',
        operator: 'AND',
        left,
        right,
      };
    }

    return left;
  }

  /**
   * Parse primary expressions (highest precedence).
   * Either a grouped expression with parentheses or a comparison.
   *
   * Primary := '(' Expression ')' | Comparison
   */
  private parsePrimary(): ASTNode {
    // Grouped expression: parentheses override precedence
    if (this.match('LPAREN')) {
      this.advance(); // consume (
      const expr = this.parseOrExpression(); // recurse back to lowest precedence
      this.expect('RPAREN', 'Expected closing parenthesis');
      return expr;
    }

    // Base case: field comparison
    return this.parseComparison();
  }

  /**
   * Comparison := Field Operator Literal
   */
  private parseComparison(): ComparisonNode {
    // Parse field
    const fieldToken = this.expect('FIELD', 'Expected field');
    const field = this.parseField(fieldToken.value as string);

    // Parse operator
    const opToken = this.expect('OPERATOR', 'Expected operator (=, ==, CONTAINS)');
    const operator = opToken.value as '=' | '==' | 'CONTAINS';

    // Parse literal
    const literal = this.parseLiteral();

    return {
      type: 'comparison',
      operator,
      field,
      value: literal,
    };
  }

  /**
   * Parse field: @id, @metadata, @metadata.fieldName
   */
  private parseField(fieldStr: string): FieldNode {
    if (fieldStr === '@id') {
      return { type: 'field', source: 'id' };
    }

    if (fieldStr === '@metadata') {
      return { type: 'field', source: 'metadata' };
    }

    if (fieldStr.startsWith('@metadata.')) {
      const name = fieldStr.substring('@metadata.'.length);
      if (!name) {
        throw new Error(`Invalid field: ${fieldStr}`);
      }
      return { type: 'field', source: 'metadata', name };
    }

    throw new Error(`Invalid field: ${fieldStr}. Expected @id or @metadata[.field]`);
  }

  /**
   * Parse literal: String | Number | Boolean
   */
  private parseLiteral(): LiteralNode {
    const token = this.peek();

    if (this.match('STRING', 'NUMBER', 'BOOLEAN')) {
      this.advance();
      return {
        type: 'literal',
        value: token.value as string | number | boolean,
      };
    }

    throw new Error(`Expected literal value at position ${token.position}`);
  }
}

// ============================================================================
// SQL Translator
// ============================================================================

/**
 * Known denormalized columns in the memories table
 * These map directly to columns instead of using JSONB access
 */
const DENORMALIZED_COLUMNS: Record<string, { column: string; type: 'text' | 'integer' | 'array' }> =
  {
    topic: { column: 'topic', type: 'text' },
    importance: { column: 'importance', type: 'integer' },
    tags: { column: 'tags', type: 'array' },
    source: { column: 'source', type: 'text' },
    sourcePath: { column: 'source_path', type: 'text' },
    source_path: { column: 'source_path', type: 'text' },
    kind: { column: 'kind', type: 'text' },
    memoryType: { column: 'memory_type', type: 'text' },
    memory_type: { column: 'memory_type', type: 'text' },
  };

export interface SQLTranslation {
  sql: string;
  params: any[];
}

class SQLTranslator {
  private params: any[] = [];
  private paramIndex = 1;

  translate(ast: ASTNode): SQLTranslation {
    this.params = [];
    this.paramIndex = 1;

    const sql = this.translateNode(ast);
    return { sql, params: this.params };
  }

  private addParam(value: any): string {
    this.params.push(value);
    return `$${this.paramIndex++}`;
  }

  private translateNode(node: ASTNode): string {
    if (node.type === 'logical') {
      return this.translateLogical(node);
    } else {
      return this.translateComparison(node);
    }
  }

  private translateLogical(node: LogicalNode): string {
    const left = this.translateNode(node.left);
    const right = this.translateNode(node.right);
    return `(${left} ${node.operator} ${right})`;
  }

  private translateComparison(node: ComparisonNode): string {
    const { field, operator, value } = node;

    // Normalize operator (= and == are equivalent)
    const normalizedOp = operator === '==' ? '=' : operator;

    // Handle @id field
    if (field.source === 'id') {
      if (normalizedOp === 'CONTAINS') {
        throw new Error('CONTAINS operator not supported for @id field');
      }
      const paramPlaceholder = this.addParam(value.value);
      return `id ${normalizedOp} ${paramPlaceholder}`;
    }

    // Handle @metadata fields
    if (field.source === 'metadata') {
      if (!field.name) {
        throw new Error('Root @metadata access not supported in comparisons');
      }

      // Check if this is a denormalized column
      const denormalized = DENORMALIZED_COLUMNS[field.name];

      if (denormalized) {
        return this.translateDenormalizedField(denormalized, normalizedOp, value, field.name);
      } else {
        return this.translateJSONBField(field.name, normalizedOp, value);
      }
    }

    throw new Error(`Unsupported field source: ${field.source}`);
  }

  private translateDenormalizedField(
    columnInfo: { column: string; type: 'text' | 'integer' | 'array' },
    operator: '=' | 'CONTAINS',
    value: LiteralNode,
    fieldName: string
  ): string {
    const { column, type } = columnInfo;

    // Special handling for importance: map string values to integers
    if (fieldName === 'importance' && typeof value.value === 'string') {
      // Importance is an integer field, only equality is supported
      if (operator === 'CONTAINS') {
        throw new Error(
          `CONTAINS operator only supported for array fields. Field ${fieldName} is ${type}`
        );
      }
      const importanceMap: Record<string, number> = {
        low: 0,
        medium: 1,
        high: 2,
      };
      const numericValue = importanceMap[value.value.toLowerCase()];
      if (numericValue === undefined) {
        throw new Error(
          `Invalid importance value: ${value.value}. Expected 'low', 'medium', or 'high'`
        );
      }
      const paramPlaceholder = this.addParam(numericValue);
      return `${column} ${operator} ${paramPlaceholder}`;
    }

    // Array containment
    if (type === 'array' && operator === 'CONTAINS') {
      if (typeof value.value !== 'string') {
        throw new Error(`Array CONTAINS requires string value, got ${typeof value.value}`);
      }
      const paramPlaceholder = this.addParam(value.value);
      return `${paramPlaceholder} = ANY(${column})`;
    }

    // Array equality (not typical, but supported)
    if (type === 'array' && operator === '=') {
      throw new Error(
        `Equality comparison not supported for array field ${fieldName}. Use CONTAINS instead.`
      );
    }

    // Regular equality
    if (operator === 'CONTAINS') {
      throw new Error(
        `CONTAINS operator only supported for array fields. Field ${fieldName} is ${type}`
      );
    }

    const paramPlaceholder = this.addParam(value.value);
    return `${column} ${operator} ${paramPlaceholder}`;
  }

  private translateJSONBField(
    fieldName: string,
    operator: '=' | 'CONTAINS',
    value: LiteralNode
  ): string {
    // JSONB access for custom metadata fields
    if (operator === 'CONTAINS') {
      // For CONTAINS on JSONB arrays, use JSONB containment operator
      // metadata->'field' @> '"value"'::jsonb (for string values)
      // Note: This assumes the JSONB field contains an array
      if (typeof value.value !== 'string') {
        throw new Error(`JSONB array CONTAINS requires string value, got ${typeof value.value}`);
      }

      // Create a JSON array with the single value to check containment
      const jsonValue = JSON.stringify([value.value]);
      const paramPlaceholder = this.addParam(jsonValue);
      return `metadata->'${this.sanitizeJsonbKey(fieldName)}' @> ${paramPlaceholder}::jsonb`;
    }

    // Text extraction: metadata->>'fieldName' = 'value'
    const paramPlaceholder = this.addParam(String(value.value));
    return `metadata->>'${this.sanitizeJsonbKey(fieldName)}' ${operator} ${paramPlaceholder}`;
  }

  /**
   * Sanitize JSONB key to prevent SQL injection.
   *
   * JSONB field names are inserted directly into SQL (e.g., `metadata->>'fieldName'`),
   * so we must validate them against a strict whitelist to prevent injection attacks.
   *
   * Only alphanumeric characters, underscores, and hyphens are allowed.
   * This prevents malicious inputs like: `'; DROP TABLE memories; --`
   */
  private sanitizeJsonbKey(key: string): string {
    // Must start with letter/digit/underscore, can contain hyphens in the middle,
    // but cannot start or end with hyphen
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*[a-zA-Z0-9_]$/.test(key) && !/^[a-zA-Z0-9_]$/.test(key)) {
      throw new Error(
        `Invalid JSONB field name: ${key}. Only alphanumeric, underscore, and hyphen allowed.`
      );
    }
    return key;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Parse a filter expression and translate it to safe PostgreSQL SQL.
 *
 * This is the main entry point for the filter parser. It performs three stages:
 * 1. **Tokenization**: Breaks the input string into tokens (fields, operators, literals, parentheses)
 * 2. **Parsing**: Builds an abstract syntax tree (AST) using recursive descent with proper precedence
 * 3. **Translation**: Converts the AST to parameterized SQL with security guarantees
 *
 * @param filterExpression - Filter expression using the DSL syntax (see module documentation)
 * @returns SQL translation object containing SQL WHERE clause and parameter array
 * @throws Error if parsing fails due to syntax errors, invalid field names, or unsupported operations
 *
 * @remarks
 * The returned SQL fragment is safe to use in WHERE clauses. All values are parameterized
 * using PostgreSQL's `$1`, `$2`, etc. placeholders to prevent SQL injection.
 *
 * @example
 * ```typescript
 * // Simple equality
 * const result = parseFilterExpression('@metadata.source = "slack"');
 * // Returns: { sql: 'source = $1', params: ['slack'] }
 *
 * // Array containment
 * const result = parseFilterExpression('@metadata.tags CONTAINS "work"');
 * // Returns: { sql: '$1 = ANY(tags)', params: ['work'] }
 *
 * // Complex with AND/OR
 * const result = parseFilterExpression(
 *   '(@metadata.kind = "note" OR @metadata.kind = "task") AND @metadata.importance = "high"'
 * );
 * // Returns: {
 * //   sql: '((kind = $1 OR kind = $2) AND importance = $3)',
 * //   params: ['note', 'task', 2]  // 'high' maps to integer 2
 * // }
 *
 * // Using in a query
 * const { sql, params } = parseFilterExpression('@metadata.priority > 0.5');
 * const query = `SELECT * FROM memories WHERE ${sql} LIMIT 10`;
 * const results = await db.query(query, params);
 * ```
 *
 * @public
 */
export function parseFilterExpression(filterExpression: string): SQLTranslation {
  try {
    // Stage 1: Tokenize - break input into tokens
    const tokenizer = new Tokenizer(filterExpression);
    const tokens = tokenizer.tokenize();

    // Stage 2: Parse - build AST with proper operator precedence
    const parser = new Parser(tokens);
    const ast = parser.parse();

    // Stage 3: Translate - convert AST to parameterized SQL
    const translator = new SQLTranslator();
    return translator.translate(ast);
  } catch (error) {
    throw new Error(
      `Failed to parse filter expression: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
