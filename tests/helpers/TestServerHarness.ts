import { Pool } from 'pg';
import { MemoryController } from '../../src/memory/MemoryController.js';
import { MemoryAgent } from '../../src/llm/MemoryAgent.js';
import { MemoryRepositoryPostgres } from '../../src/memory/MemoryRepositoryPostgres.js';
import { LLMClient } from '../../src/llm/LLMClient.js';
import { PromptManager } from '../../src/llm/PromptManager.js';
import { IndexResolver } from '../../src/memory/IndexResolver.js';
import { ProjectFileLoader } from '../../src/memory/ProjectFileLoader.js';
import { EmbeddingService } from '../../src/llm/EmbeddingService.js';
import { PoolManager } from '../../src/memory/PoolManager.js';
import type { McpContent } from '../../src/memory/MemoryController.js';
import type {
  CreateIndexResult,
  ListIndexesResult,
  MemorizeToolArgs,
  MemorizeResult,
  ScanMemoriesToolArgs,
  ScanMemoriesResult,
} from '../../src/memory/types.js';

/**
 * Test harness for bootstrapping MemoryController and database connections.
 * Provides convenience methods for calling MCP tools and parsing responses.
 */
export class TestServerHarness {
  public readonly pool: Pool;
  public readonly repository: MemoryRepositoryPostgres;
  public readonly controller: MemoryController;
  public readonly projectId: string;
  private readonly databaseUrl: string;

  constructor(
    databaseUrl: string,
    projectId: string,
    options?: {
      embeddingService?: EmbeddingService;
      llmClient?: LLMClient;
    }
  ) {
    this.databaseUrl = databaseUrl;
    if (!databaseUrl) {
      throw new Error(
        'TEST_DATABASE_URL environment variable is required. ' +
          'Point it to a disposable Postgres database with migrations applied.'
      );
    }

    this.projectId = projectId;
    this.pool = new Pool({ connectionString: databaseUrl });

    // Create or use injected embedding service
    const embeddingService =
      options?.embeddingService ??
      new EmbeddingService(process.env.OPENAI_API_KEY ?? 'test-key-not-used-for-index-operations');

    // Create repository
    this.repository = new MemoryRepositoryPostgres(databaseUrl, projectId, embeddingService);

    // Create or use injected LLM client
    const llmClient =
      options?.llmClient ??
      new LLMClient(process.env.OPENAI_API_KEY ?? 'test-key-not-used-for-index-operations');

    // Create prompt manager (point to prompts directory)
    const promptsDir = new URL('../../prompts', import.meta.url).pathname;
    const promptManager = new PromptManager(promptsDir);

    // Create index resolver
    const indexResolver = new IndexResolver('default');

    // Create project file loader (with current directory as project root)
    const fileLoader = new ProjectFileLoader(process.cwd());

    // Create agent
    const agent = new MemoryAgent(llmClient, promptManager, this.repository, fileLoader, {
      largeFileThresholdBytes: 256 * 1024,
      chunkSizeChars: 16_000,
      chunkOverlapChars: 2_000,
      maxChunksPerFile: 24,
      maxMemoriesPerFile: 50,
      projectId,
    });

    // Create controller
    this.controller = new MemoryController(indexResolver, agent, fileLoader);
  }

  /**
   * Parse JSON from MCP-formatted response.
   * The formatResponse method embeds JSON after the summary: "summary\n\n{json}"
   * Handles responses with or without summaries, and JSON starting with {, [, or "
   */
  parseJsonResponse<T>(mcpContent: McpContent): T {
    if (!mcpContent.content || mcpContent.content.length === 0) {
      throw new Error('Expected content array in MCP response');
    }

    const firstContent = mcpContent.content[0];
    if (firstContent.type !== 'text') {
      throw new Error('Expected text content from MCP response');
    }

    const text = firstContent.text;

    // Try to find JSON after a summary (separated by double newline)
    const doubleNewlineIndex = text.lastIndexOf('\n\n');

    let jsonText: string;
    if (doubleNewlineIndex !== -1) {
      // Extract potential JSON after the summary
      jsonText = text.slice(doubleNewlineIndex + 2).trim();
    } else {
      // No summary, treat entire text as JSON
      jsonText = text.trim();
    }

    // Parse and return
    try {
      return JSON.parse(jsonText) as T;
    } catch (error) {
      throw new Error(
        `Failed to parse JSON from MCP response: ${error instanceof Error ? error.message : String(error)}\nContent: ${jsonText.substring(0, 200)}`
      );
    }
  }

  /**
   * Call create_index tool and return parsed result.
   */
  async callCreateIndex(name: string, description?: string): Promise<CreateIndexResult> {
    const mcpResponse = await this.controller.handleCreateIndexTool({ name, description });
    return this.parseJsonResponse<CreateIndexResult>(mcpResponse);
  }

  /**
   * Call list_indexes tool and return parsed result.
   */
  async callListIndexes(): Promise<ListIndexesResult> {
    const mcpResponse = await this.controller.handleListIndexesTool();
    return this.parseJsonResponse<ListIndexesResult>(mcpResponse);
  }

  /**
   * Verify index exists in database.
   */
  async verifyIndexInDatabase(name: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT project, name FROM memory_indexes WHERE project = $1 AND name = $2',
      [this.projectId, name]
    );
    return result.rows.length > 0;
  }

  /**
   * Clean up test indexes.
   */
  async cleanupTestIndexes(namePrefix: string): Promise<void> {
    await this.pool.query('DELETE FROM memory_indexes WHERE project = $1 AND name LIKE $2', [
      this.projectId,
      `${namePrefix}%`,
    ]);
  }

  /**
   * Call memorize tool and return parsed result.
   */
  async callMemorize(args: MemorizeToolArgs): Promise<MemorizeResult> {
    const mcpResponse = await this.controller.handleMemorizeTool(args);
    return this.parseJsonResponse<MemorizeResult>(mcpResponse);
  }

  /**
   * Call scan_memories tool and return parsed result.
   */
  async callScanMemories(args: ScanMemoriesToolArgs): Promise<ScanMemoriesResult> {
    const mcpResponse = await this.controller.handleScanMemoriesTool(args);
    return this.parseJsonResponse<ScanMemoriesResult>(mcpResponse);
  }

  /**
   * Get a memory row from the database including all fields.
   */
  async getMemoryRow(memoryId: string): Promise<{
    id: string;
    content: string;
    embedding: number[];
    source: string;
    metadata: Record<string, unknown>;
    initial_priority: number;
    current_priority: number;
    created_at: Date;
    updated_at: Date;
  } | null> {
    const result = await this.pool.query(
      `SELECT
        id,
        content,
        embedding,
        source,
        metadata,
        initial_priority,
        current_priority,
        created_at,
        updated_at
      FROM memories
      WHERE project = $1 AND id = $2`,
      [this.projectId, memoryId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  /**
   * Get embedding dimensions for a memory using pgvector's vector_dims function.
   */
  async getEmbeddingDimensions(memoryId: string): Promise<number | null> {
    const result = await this.pool.query(
      `SELECT vector_dims(embedding) AS dims
      FROM memories
      WHERE project = $1 AND id = $2`,
      [this.projectId, memoryId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].dims;
  }

  /**
   * Clean up test memories.
   * Deletes all memories associated with test indexes (by name prefix).
   */
  async cleanupTestMemories(indexNamePrefix: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM memories
      WHERE project = $1
      AND index_id IN (
        SELECT id FROM memory_indexes
        WHERE project = $1 AND name LIKE $2
      )`,
      [this.projectId, `${indexNamePrefix}%`]
    );
  }

  /**
   * Close database connections.
   * Closes both the direct pool and the PoolManager's shared pool.
   */
  async close(): Promise<void> {
    await this.pool.end();
    await PoolManager.closePool(this.databaseUrl);
  }
}
