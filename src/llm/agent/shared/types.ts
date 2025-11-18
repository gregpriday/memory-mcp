import { SearchDiagnostics, MemoryType } from '../../../memory/types.js';

/**
 * Configuration for MemoryAgent ingestion behavior
 */
export interface MemoryAgentConfig {
  largeFileThresholdBytes?: number;
  chunkSizeChars?: number;
  chunkOverlapChars?: number;
  maxChunksPerFile?: number;
  maxMemoriesPerFile?: number;
  projectId?: string;
}

/**
 * Lightweight operation log entry for diagnostic tracking.
 */
export interface OperationLogEntry {
  toolName: string;
  timestamp: string;
  argsSummary: string;
  resultSummary: string;
  /** Structured diagnostic data extracted from tool calls */
  diagnostics?: {
    /** For upsert_memories: number of memories attempted */
    memoriesCount?: number;
    /** For upsert_memories: IDs that were successfully stored */
    storedIds?: string[];
    /** For search_memories: IDs of found memories */
    searchResultIds?: string[];
    /** For search_memories: number of results found */
    searchResultCount?: number;
    /** Tool reported an error string (captured verbatim for reconciliation) */
    errorMessage?: string;
    /** Tool arguments failed validation before execution */
    invalidArgs?: boolean;
  };
}

/**
 * Validation message that accumulates during timestamp/metadata validation
 */
export interface ValidationMessage {
  level: 'warning' | 'error';
  message: string;
}

/**
 * Request context for thread-safe operation execution
 */
export interface RequestContext {
  index: string;
  storedMemoryIds: string[];
  operationMode: 'normal' | 'forget-dryrun' | 'refinement-planning';
  searchIterationCount: number; // Track search_memories calls for iteration limit
  trackedMemoryIds: Set<string>; // Track IDs already updated via search_memories to avoid double-tracking
  searchDiagnostics: SearchDiagnostics[]; // Accumulate diagnostics from all search operations
  operationLog: OperationLogEntry[]; // Track tool calls for zero-store diagnostics
  forgetContext?: {
    dryRun: boolean;
    explicitMemoryIds?: string[];
    hasMetadataFilters?: boolean;
  };
  // Validation fields (for timestamp and metadata validation)
  forceValidationBypass?: boolean; // When true, downgrade validation errors to warnings and continue
  validationMessages: ValidationMessage[]; // Accumulate warnings and errors from validation
}

/**
 * Summary of a preprocessed large file ingestion
 */
export interface PreprocessedFileSummary {
  path: string;
  byteSize: number;
  storedMemories: number;
  chunkCount: number;
  notes?: string;
}

/**
 * Valid memory type classifications.
 * Used to validate LLM-provided memoryType values before persistence.
 */
export const VALID_MEMORY_TYPES: ReadonlySet<MemoryType> = new Set([
  'self',
  'belief',
  'pattern',
  'episodic',
  'semantic',
]);
