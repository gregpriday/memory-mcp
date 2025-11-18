import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { loadBackendConfig } from '../config/backend.js';
import { loadEmbeddingConfig } from '../config/embedding.js';
import { EmbeddingService } from '../llm/EmbeddingService.js';
import { MemoryRepositoryPostgres } from '../memory/MemoryRepositoryPostgres.js';
import { IndexResolver } from '../memory/IndexResolver.js';
import { ProjectFileLoader } from '../memory/ProjectFileLoader.js';
import { MemoryController } from '../memory/MemoryController.js';
import { PromptManager } from '../llm/PromptManager.js';
import { LLMClient } from '../llm/LLMClient.js';
import { MemoryAgent } from '../llm/MemoryAgent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getEnvInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createMemoryServer(config?: {
  databaseUrl?: string;
  openaiApiKey?: string;
  defaultIndex?: string;
  projectRoot?: string;
}): Server {
  const backend = loadBackendConfig();

  if (!backend.activeProject) {
    throw new Error(
      'No active project configured. Set MEMORY_ACTIVE_PROJECT and MEMORY_POSTGRES_PROJECT_REGISTRY.'
    );
  }

  const databaseUrl = config?.databaseUrl || backend.activeProject.databaseUrl;

  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error(
      'Invalid database URL. Provide a valid PostgreSQL connection string (postgres:// or postgresql://).'
    );
  }

  if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)) {
    throw new Error(
      'Invalid database URL. This server requires a PostgreSQL database URL (postgres:// or postgresql://).'
    );
  }

  // Log Postgres backend activation (sanitize password from URL)
  const sanitizedUrl = (() => {
    const clone = new URL(parsedDatabaseUrl.toString());
    if (clone.password) {
      clone.password = '****';
    }
    clone.searchParams.delete('password');
    return clone.toString();
  })();
  console.error(
    `[Memory MCP] Postgres backend active (project="${backend.activeProject.projectId}", db="${sanitizedUrl}")`
  );
  const openaiApiKey = config?.openaiApiKey || process.env.OPENAI_API_KEY;
  const defaultIndex = config?.defaultIndex || process.env.MEMORY_DEFAULT_INDEX;
  const projectRoot = config?.projectRoot || process.cwd();

  if (!databaseUrl) {
    throw new Error(
      'No Postgres database URL configured. Update MEMORY_POSTGRES_PROJECT_REGISTRY.'
    );
  }

  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required.');
  }

  const indexResolver = new IndexResolver(defaultIndex);
  const maxFileBytes = getEnvInt('MEMORY_MAX_FILE_BYTES', 2 * 1024 * 1024);
  const fileLoader = new ProjectFileLoader(projectRoot, maxFileBytes);
  const promptsDir = join(__dirname, '../../prompts');
  const promptManager = new PromptManager(promptsDir);
  const llmClient = new LLMClient(openaiApiKey);

  const embeddingConfig = loadEmbeddingConfig();
  const embeddingService = new EmbeddingService(
    openaiApiKey,
    embeddingConfig.model,
    embeddingConfig.dimensions
  );

  const repository = new MemoryRepositoryPostgres(
    databaseUrl,
    backend.activeProject.projectId,
    embeddingService
  );

  // Log configuration summary at startup
  console.error(
    `[Memory MCP] Configuration: ` +
      `embedding=${embeddingConfig.model} (${embeddingConfig.dimensions}d), ` +
      `project=${backend.activeProject.projectId}, ` +
      `model=${process.env.MEMORY_MODEL || 'gpt-5-mini'}`
  );

  const agent = new MemoryAgent(llmClient, promptManager, repository, fileLoader, {
    largeFileThresholdBytes: getEnvInt('MEMORY_LARGE_FILE_THRESHOLD_BYTES', 256 * 1024),
    chunkSizeChars: getEnvInt('MEMORY_CHUNK_CHAR_LENGTH', 16_000),
    chunkOverlapChars: getEnvInt('MEMORY_CHUNK_CHAR_OVERLAP', 2_000),
    maxChunksPerFile: getEnvInt('MEMORY_MAX_CHUNKS_PER_FILE', 24),
    maxMemoriesPerFile: getEnvInt('MEMORY_MAX_MEMORIES_PER_FILE', 50),
    projectId: backend.activeProject.projectId,
  });

  const controller = new MemoryController(indexResolver, agent, fileLoader);

  const server = new Server(
    {
      name: 'memory-pg-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'memorize',
          description:
            'Capture durable memories from free-form text or files. The agent extracts atomic facts, enriches them with metadata (topic, tags, memoryType), and stores them in Postgres + pgvector.',
          inputSchema: {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: 'Natural language instruction describing what to memorize.',
              },
              files: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Optional relative file paths to ingest alongside the textual instruction.',
              },
              index: {
                type: 'string',
                description: 'Optional index name. Defaults to MEMORY_DEFAULT_INDEX.',
              },
              projectSystemMessagePath: {
                type: 'string',
                description:
                  'Optional relative path to a system message that biases how this request should be handled.',
              },
              metadata: {
                type: 'object',
                description:
                  'Optional metadata applied to each extracted memory (most fields auto-populate).',
              },
            },
            required: ['input'],
          },
        },
        {
          name: 'recall',
          description:
            'Search stored memories and optionally synthesize an answer. Supports metadata filters, returning raw memories, and priority-aware synthesis.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Natural language question or topic to search for.',
              },
              index: {
                type: 'string',
                description: 'Optional index name override.',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of memories to return (default: 10).',
              },
              filters: {
                type: 'object',
                description: 'Structured metadata filters (keys should match stored metadata).',
              },
              filterExpression: {
                type: 'string',
                description: 'Advanced filter expression understood by the Postgres filter parser.',
              },
              projectSystemMessagePath: {
                type: 'string',
                description: 'Optional project-specific system message path.',
              },
              responseMode: {
                type: 'string',
                enum: ['answer', 'memories', 'both'],
                description:
                  'Controls whether the agent returns synthesized answers, raw memories, or both.',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'forget',
          description:
            'Plan deletions with the LLM agent. Supports dry runs, metadata-scoped deletes, and explicit id deletion.',
          inputSchema: {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: 'Instruction describing what to forget.',
              },
              index: {
                type: 'string',
                description: 'Optional index override.',
              },
              filters: {
                type: 'object',
                description: 'Optional metadata filters for narrowing candidates.',
              },
              projectSystemMessagePath: {
                type: 'string',
                description: 'Optional system message path for contextualizing deletions.',
              },
              dryRun: {
                type: 'boolean',
                description: 'Default true; when false the agent will execute approved deletes.',
              },
              explicitMemoryIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Specific memory IDs to delete immediately.',
              },
            },
            required: ['input'],
          },
        },
        {
          name: 'refine_memories',
          description:
            'Curate stored memories (dedupe, reprioritize, summarize, clean up) via structured refinement plans.',
          inputSchema: {
            type: 'object',
            properties: {
              index: { type: 'string', description: 'Optional index override.' },
              operation: {
                type: 'string',
                enum: ['consolidation', 'decay', 'cleanup', 'reflection'],
                description: 'Refinement mode to run.',
              },
              scope: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                  filters: { type: 'object' },
                  seedIds: { type: 'array', items: { type: 'string' } },
                  maxCandidates: { type: 'number' },
                },
                description: 'Controls which memories are considered.',
              },
              budget: {
                type: 'number',
                description: 'Maximum actions to execute (default configured via env).',
              },
              dryRun: {
                type: 'boolean',
                description: 'Plan-only mode when true (default).',
              },
              projectSystemMessagePath: {
                type: 'string',
                description: 'Optional project-specific context.',
              },
            },
          },
        },
        {
          name: 'create_index',
          description:
            'Create or ensure a Postgres-backed memory index exists for the active project.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'New index name.',
              },
              description: {
                type: 'string',
                description: 'Optional human description stored alongside the index record.',
              },
            },
            required: ['name'],
          },
        },
        {
          name: 'list_indexes',
          description:
            'List every Postgres memory index with document counts so agents can choose destinations.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'scan_memories',
          description: 'Run direct Postgres searches (no LLM) and inspect raw results/diagnostics.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query text.' },
              index: { type: 'string', description: 'Optional index override.' },
              limit: { type: 'number', description: 'Max results (default 10, max 1000).' },
              filters: { type: 'object', description: 'Structured metadata filters.' },
              filterExpression: {
                type: 'string',
                description: 'Advanced filter expression string.',
              },
              semanticWeight: {
                type: 'number',
                description: 'Semantic vs keyword weighting (0-1).',
              },
              reranking: {
                type: 'boolean',
                description: 'Enable reranking (default true).',
              },
              includeMetadata: {
                type: 'boolean',
                description: 'Include metadata payloads (default true).',
              },
            },
            required: ['query'],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'memorize':
          return await controller.handleMemorizeTool(args as any);
        case 'recall':
          return await controller.handleRecallTool(args as any);
        case 'forget':
          return await controller.handleForgetTool(args as any);
        case 'refine_memories':
          return await controller.handleRefineMemoriesTool(args as any);
        case 'create_index':
          return await controller.handleCreateIndexTool(args as any);
        case 'list_indexes':
          return await controller.handleListIndexesTool();
        case 'scan_memories':
          return await controller.handleScanMemoriesTool(args as any);
        case 'remember':
          return await controller.handleMemorizeTool({
            input: (args as any).content,
            metadata: (args as any).metadata,
          } as any);
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      console.error(`Error handling tool "${name}":`, error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${(error as Error).message}`,
          },
        ],
      };
    }
  });

  return server;
}
