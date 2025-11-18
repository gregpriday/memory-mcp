/**
 * Filter Expression Parser and SQL Translator
 *
 * Parses Upstash filter expressions and translates them to safe PostgreSQL WHERE clauses
 * with parameter binding to prevent SQL injection.
 *
 * Grammar:
 *   Expression := OrExpression
 *   OrExpression := AndExpression ('OR' AndExpression)*
 *   AndExpression := Primary ('AND' Primary)*
 *   Primary := '(' Expression ')' | Comparison
 *   Comparison := Field Operator Literal
 *   Field := '@id' | '@metadata' | '@metadata.' Identifier
 *   Operator := '=' | '==' | 'CONTAINS'
 *   Literal := String | Number | Boolean
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

  private readString(): string {
    // Expect opening quote
    this.advance(); // skip opening "

    let value = '';
    while (this.pos < this.input.length && this.peek() !== '"') {
      const ch = this.advance();
      // Handle basic escape sequences
      if (ch === '\\' && this.peek() === '"') {
        value += this.advance(); // escaped quote
      } else {
        value += ch;
      }
    }

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
   * Expression := OrExpression
   */
  parse(): ASTNode {
    const expr = this.parseOrExpression();
    this.expect('EOF', 'Expected end of input');
    return expr;
  }

  /**
   * OrExpression := AndExpression ('OR' AndExpression)*
   */
  private parseOrExpression(): ASTNode {
    let left = this.parseAndExpression();

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
   * AndExpression := Primary ('AND' Primary)*
   */
  private parseAndExpression(): ASTNode {
    let left = this.parsePrimary();

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
   * Primary := '(' Expression ')' | Comparison
   */
  private parsePrimary(): ASTNode {
    // Grouped expression
    if (this.match('LPAREN')) {
      this.advance(); // consume (
      const expr = this.parseOrExpression();
      this.expect('RPAREN', 'Expected closing parenthesis');
      return expr;
    }

    // Comparison
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
   * Sanitize JSONB key to prevent injection
   * Allow only alphanumeric, underscore, and hyphen (but not starting/ending with hyphen)
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
 * Parse a filter expression and translate it to SQL
 *
 * @param filterExpression - Upstash filter expression
 * @returns SQL WHERE clause and parameter array
 * @throws Error if parsing or translation fails
 */
export function parseFilterExpression(filterExpression: string): SQLTranslation {
  try {
    // Tokenize
    const tokenizer = new Tokenizer(filterExpression);
    const tokens = tokenizer.tokenize();

    // Parse
    const parser = new Parser(tokens);
    const ast = parser.parse();

    // Translate
    const translator = new SQLTranslator();
    return translator.translate(ast);
  } catch (error) {
    throw new Error(
      `Failed to parse filter expression: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
