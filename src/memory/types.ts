/**
 * Semantic classification of memory type to enable type-aware decay, consolidation, and retrieval strategies.
 *
 * - **Self**: First-person identity statements. Example: "I am a variety streamer" or "My channel focuses on gaming and creative content"
 * - **Belief**: Generalizations and stances about how things should work. Example: "I believe creators should prioritize consistency" or "The best approach to engagement is community interaction"
 * - **Pattern**: Repeated behaviors and habitual responses. Example: "When asked about burnout, I usually discuss balance" or "My process for video creation starts with scripting"
 * - **Episodic**: Specific events or experiences with temporal context. Example: "In video #42, I told the story about my first livestream" or "During the Q&A stream, I responded to a question about monetization"
 * - **Semantic**: General facts and knowledge not tied to personal experience. Example: "YouTube's algorithm rewards consistency" or "The best camera for streaming is one with good autofocus"
 *
 * Decision tree order (apply in sequence):
 * 1. Self: First-person identity statements about the persona itself
 * 2. Belief: Generalizations and stable stances (not personal identity, but convictions)
 * 3. Pattern: Repeated behaviors, procedures, or Q&A templates
 * 4. Episodic: Specific, time-bound experiences or events
 * 5. Semantic: General facts or principles (not tied to persona's beliefs or experiences)
 *
 * Classification enables automatic decay strategies (self/belief memories decay slower), consolidation tactics
 * (merge similar patterns), and retrieval prioritization (episodic memories are context-specific).
 */
export type MemoryType = 'self' | 'belief' | 'pattern' | 'episodic' | 'semantic';

export interface MemoryContent {
  text: string; // The atomic fact / snippet
  timestamp: string; // ISO timestamp when stored
}

/**
 * Semantic relationship types that connect memories in a directed graph.
 * These types enable spreading activation retrieval and relationship-based consolidation.
 */
export type RelationshipType =
  | 'summarizes' // A summarizes B (pattern/summary → episodic memories) - A is a concise version of B
  | 'example_of' // A is example of B (episodic → pattern/category) - A is a concrete instance of the pattern B
  | 'is_generalization_of' // A generalizes B (pattern/belief → episodic memories) - A is a general principle derived from B
  | 'supports' // A supports B (episodic/pattern → belief) - Evidence or reasoning that reinforces B
  | 'contradicts' // A contradicts B (episodic → episodic or belief → belief) - Direct opposition or conflicting information
  | 'causes' // A causes B (episodic → episodic) - Causal relationship where A leads to B
  | 'similar_to' // A is similar to B (episodic → episodic) - Semantic or contextual similarity without direct relationship
  | 'historical_version_of' // A is older version of B (episodic → episodic) - A was superseded or updated to become B
  | 'derived_from'; // A was derived from B (pattern/belief → episodics/patterns) - A is computed or abstracted from B

/**
 * Represents a directed edge in the memory graph.
 * Connects a memory to other memories via semantic relationships.
 */
export interface Relationship {
  /** The ID of the related memory (target of this edge) */
  targetId: string;

  /** The type of relationship (semantic edge label) */
  type: RelationshipType;

  /** Optional strength indicator (0.0–1.0) for relationship confidence */
  weight?: number;
}

/**
 * Importance level for memories.
 */
export type Importance = 'low' | 'medium' | 'high';

/**
 * Emotion metadata with intensity level for emotional context in memories.
 */
export interface EmotionInfo {
  /** Intensity of the emotion on a scale of 0.0–1.0 */
  intensity?: number;

  /** Optional emotion label (e.g., 'joy', 'sadness', 'anger') */
  label?: string;
}

/**
 * Tracks salience, temporal metadata, and lifecycle state for a memory.
 *
 * Priority is calculated using a type-dependent formula implemented in `PriorityCalculator.ts`:
 * - **Self/Belief** (10% recency, 40% importance, 30% usage, 20% emotion): Identity persists;
 *   canonical beliefs have minimum 0.4 priority floor
 * - **Pattern** (25% recency, 30% importance, 30% usage, 15% emotion): Patterns decay slower
 * - **Episodic** (40% recency, 20% importance, 20% usage, 20% emotion): Episodes fade faster
 * - **Semantic** (10% recency, 50% importance, 20% usage, 20% emotion): Facts persist if important
 *
 * Helper functions calculate component scores:
 * - recencyScore = exp(-ageDays / 30)  [exponential decay with 30-day half-life]
 * - usageScore = log(1 + accessCount) / log(101)  [logarithmic saturation at ~100 accesses]
 * - importanceScore = {high: 1.0, medium: 0.6, low: 0.3}
 * - emotionScore = emotion?.intensity ?? 0.0
 *
 * Final priority is clamped to [0.0, 1.0].
 */
export interface MemoryDynamics {
  /** Initial priority (0.0-1.0), derived from importance at creation time */
  initialPriority: number;

  /** Current priority (0.0-1.0), adjusted by usage and decay over time */
  currentPriority: number;

  /** ISO timestamp when the memory was created */
  createdAt: string;

  /**
   * ISO timestamp of the last retrieval or refinement access.
   * Omit for new memories that haven't been read yet; consumers can fall
   * back to createdAt.
   */
  lastAccessedAt?: string;

  /** Approximate count of how many times this memory has been retrieved */
  accessCount: number;

  /**
   * Highest access count observed in the current scoring window, so
   * usageBoost = log(1 + accessCount) / log(1 + maxAccessCount)
   * remains reproducible after persistence.
   */
  maxAccessCount?: number;

  /** Lifecycle stability indicator */
  stability?: 'tentative' | 'stable' | 'canonical';

  /** Number of refinement passes that have processed this memory */
  sleepCycles?: number;
}

export interface MemoryMetadata {
  index: string; // Logical index name (duplicated for filtering)
  project?: string; // Arbitrary project identifier
  source?: 'user' | 'file' | 'system';
  sourcePath?: string; // Relative file path, e.g. scripts/ep01.md
  channel?: string; // e.g. YouTube channel name
  scriptTitle?: string;
  tags?: string[]; // e.g. ["pricing", "onboarding"]
  topic?: string; // main topic / theme
  date?: string; // logical date for the content (YYYY-MM-DD)
  importance?: Importance;
  emotion?: EmotionInfo; // Optional emotional context for priority weighting

  /**
   * Semantic memory type for type-aware decay, consolidation, and retrieval strategies.
   * See {@link MemoryType} for classification rules and examples.
   * Optional for backward compatibility.
   */
  memoryType?: MemoryType;

  // Graph-related fields
  relatedIds?: string[]; // convenience flattened list
  relationships?: Relationship[]; // typed edges with semantic meaning

  // Lifecycle dynamics (optional for backward compatibility)
  /** Tracks salience, access patterns, and lifecycle state */
  dynamics?: MemoryDynamics;

  // Consolidation metadata
  /** Memory kind: raw (original), summary (consolidated), or derived (computed) */
  kind?: 'raw' | 'summary' | 'derived';

  /** IDs of memories this was derived from (for summaries/meta-memories) */
  derivedFromIds?: string[];

  /** ID of a newer memory that supersedes this one */
  supersededById?: string;

  [key: string]: unknown;
}

export interface MemoryRecord {
  id: string;
  content: MemoryContent;
  metadata?: MemoryMetadata;
}

// Tool argument types
export interface MemorizeToolArgs {
  input: string;
  files?: string[];
  index?: string;
  projectSystemMessagePath?: string;
  metadata?: Record<string, unknown>;
  force?: boolean; // Bypass deduplication when true
}

export interface RecallToolArgs {
  query: string;
  index?: string;
  limit?: number;
  filters?: Record<string, string | number | boolean>;
  filterExpression?: string;
  projectSystemMessagePath?: string;
  responseMode?: 'answer' | 'memories' | 'both';
}

export interface ForgetToolArgs {
  input: string;
  index?: string;
  filters?: Record<string, unknown>;
  projectSystemMessagePath?: string;
  dryRun?: boolean;
  explicitMemoryIds?: string[]; // User-provided explicit memory IDs to bypass confidence threshold
}

export interface CreateIndexToolArgs {
  name: string;
  project?: string;
  description?: string;
  metadataDefaults?: Record<string, unknown>;
}

export interface ScanMemoriesToolArgs {
  query: string;
  index?: string;
  limit?: number;
  filters?: Record<string, string | number | boolean | string[]>;
  filterExpression?: string;
  semanticWeight?: number;
  reranking?: boolean;
  includeMetadata?: boolean;
}

// Memorize decision tracking
export interface MemorizeDecision {
  action: 'STORED' | 'FILTERED' | 'DEDUPLICATED' | 'REJECTED';
  reason: string;
  remediation?: string;
  relatedIds?: string[];
}

// Tool result types
export interface MemorizeResult {
  status: 'ok' | 'error';
  index: string;
  storedCount: number;
  memoryIds: string[];
  notes?: string;
  error?: string;
  decision?: MemorizeDecision;
}

export interface RecallResult {
  status: 'ok' | 'error';
  index: string;
  answer?: string;
  memories?: Array<{
    id: string;
    text: string;
    score?: number;
    metadata?: MemoryMetadata;
    age?: string;
  }>;
  supportingMemories?: Array<{ id: string; score: number }>;
  error?: string;
  /** Status of the search operation (for distinguishing empty results from errors) */
  searchStatus?: SearchStatus;
  /** Detailed diagnostics from search operations */
  searchDiagnostics?: SearchDiagnostics[];
}

export interface ForgetResult {
  status: 'ok' | 'error';
  index: string;
  deletedCount?: number;
  deletedIds?: string[];
  plan?: Array<{
    id: string;
    reason: string;
    confidence?: 'high' | 'medium' | 'low';
    warning?: string;
  }>;
  lowConfidenceMatches?: string[]; // IDs of low-confidence matches in dry-run
  skippedLowConfidence?: Array<{
    id: string;
    score: number;
    reason: string;
  }>; // Low-confidence matches skipped in execution
  notes?: string;
  error?: string;
}

export interface CreateIndexResult {
  status: 'ok' | 'error';
  name: string;
  description?: string;
  notes?: string;
  error?: string;
}

export interface ListIndexesResult {
  status: 'ok' | 'error';
  // Overall DB stats
  documentCount?: number;
  pendingDocumentCount?: number;
  diskSize?: number;
  // Per-index stats exposed via repository
  indexes?: Array<{
    name: string;
    documentCount: number;
    pendingDocumentCount: number;
    description?: string;
    project?: string;
  }>;
  error?: string;
}

export interface ScanMemoriesResult {
  status: 'ok' | 'error';
  index: string;
  results?: SearchResult[];
  searchStatus?: SearchStatus;
  diagnostics?: SearchDiagnostics[];
  error?: string;
}

// Agent-level types for internal operations
export interface MemoryToUpsert {
  id?: string; // Optional ID for updates (vs. new inserts)
  text: string;
  metadata?: Partial<MemoryMetadata>;
  timestamp?: string; // Preserve creation time on updates
  memoryType?: MemoryType; // Optional top-level memoryType (normalized into metadata)
}

export interface SearchResult {
  id: string;
  content: MemoryContent;
  metadata?: MemoryMetadata;
  score?: number;
  age?: string; // Human-readable relative time (e.g., "3 days ago")
}

/**
 * Status codes for search operations to distinguish between different outcomes
 */
export type SearchStatus = 'results' | 'no_results' | 'pending_documents' | 'search_error';

/**
 * Structured diagnostics for search operations to aid debugging and user guidance.
 * Captures timing, retry counts, index state, and failure details.
 */
export interface SearchDiagnostics {
  /** Index name that was searched */
  index: string;

  /** Original search query */
  query: string;

  /** Maximum number of results requested */
  limit: number;

  /** Semantic weight used (0.0-1.0, higher = more semantic) */
  semanticWeight: number;

  /** Metadata filter expression if any */
  filterExpression?: string;

  /** Whether reranking was enabled */
  reranking: boolean;

  /** Search operation duration in milliseconds */
  durationMs: number;

  /** Search outcome status */
  status: SearchStatus;

  /** Number of results returned */
  resultCount: number;

  /** Number of retry attempts made */
  retryCount: number;

  /** Number of documents pending indexing (if available) */
  pendingDocumentCount?: number;

  /** Total documents in index (if available) */
  documentCount?: number;

  /** Error message if search failed */
  lastError?: string;

  /** Postgres error code if applicable (e.g., '57P01', 'ECONNREFUSED') */
  postgresCode?: string;

  /** Human-readable troubleshooting hint */
  hint?: string;

  /** Array of suggested fixes or actions to resolve the error */
  suggestedFixes?: string[];

  /** Additional error details (connection info, dimension info, etc.) */
  details?: Record<string, unknown>;

  /** ISO timestamp when search was executed */
  timestamp: string;
}

// Internal tool definitions for LLM
export interface InternalTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Refinement types for memory lifecycle management

/** Type of refinement operation to perform */
export type RefinementOperation =
  | 'consolidation' // Merge related memories into summaries
  | 'decay' // Reduce priority of old/unused memories
  | 'cleanup' // Remove redundant or superseded memories
  | 'reflection'; // Synthesize beliefs from pattern clusters

/** Action types for the refinement execution plan */
export type RefinementActionType =
  | 'UPDATE' // Modify existing memory metadata or text
  | 'DELETE' // Remove memories
  | 'MERGE' // Consolidate multiple memories into one
  | 'CREATE'; // Generate new derived/summary memories

/**
 * Update action: modify existing memory metadata or text.
 */
export interface UpdateRefinementAction {
  type: 'UPDATE';
  reason: string;
  id: string;
  metadataUpdates?: Partial<MemoryMetadata>;
  textUpdate?: string;
}

/**
 * Delete action: remove memories from the index.
 */
export interface DeleteRefinementAction {
  type: 'DELETE';
  reason: string;
  deleteIds: string[];
}

/**
 * Merge action: consolidate multiple memories into one.
 */
export interface MergeRefinementAction {
  type: 'MERGE';
  reason: string;
  targetId: string;
  mergeSourceIds: string[];
  mergedText?: string;
  mergedMetadata?: Partial<MemoryMetadata>;
}

/**
 * Create action: generate new derived or summary memories.
 */
export interface CreateRefinementAction {
  type: 'CREATE';
  reason: string;
  newMemory: MemoryToUpsert;
}

/**
 * A single action in the refinement execution plan.
 * Uses discriminated union for type safety.
 */
export type RefinementAction =
  | UpdateRefinementAction
  | DeleteRefinementAction
  | MergeRefinementAction
  | CreateRefinementAction;

/**
 * Arguments for the refine_memories tool.
 * Allows scoped refinement operations with budget controls.
 */
export interface RefineMemoriesToolArgs {
  /** Target index (optional, defaults to system default) */
  index?: string;

  /** Type of refinement operation to perform */
  operation?: RefinementOperation;

  /** Scope for refinement candidates */
  scope?: {
    /** Semantic query to find relevant memories */
    query?: string;

    /** Metadata filters to narrow candidates */
    filters?: Record<string, unknown>;

    /** Specific memory IDs to start from (for graph traversal) */
    seedIds?: string[];

    /** Maximum number of candidate memories to consider */
    maxCandidates?: number;
  };

  /** Maximum number of actions to execute (cost control) */
  budget?: number;

  /** If true, only plan actions without executing them */
  dryRun?: boolean;

  /** Optional project-specific system message for refinement guidance */
  projectSystemMessagePath?: string;
}

/**
 * Result from a refine_memories operation.
 */
export interface RefineMemoriesResult {
  /** Operation status */
  status: 'ok' | 'error' | 'budget_reached';

  /** Index that was refined */
  index: string;

  /** Whether this was a dry run */
  dryRun: boolean;

  /** High-level summary of what was done */
  summary?: string;

  /** Planned or executed actions */
  actions?: RefinementAction[];

  /** Number of actions successfully applied (if not dry run) */
  appliedActionsCount?: number;

  /** Number of actions skipped due to errors or budget (if not dry run) */
  skippedActionsCount?: number;

  /** IDs of newly created memories (if any) */
  newMemoryIds?: string[];

  /** Error message if status is 'error' */
  error?: string;
}

// Character introspection types for developer-facing inspection tools

/** Available developer-facing introspection views */
export type IntrospectionView =
  | 'type_distribution'
  | 'top_beliefs'
  | 'emotion_map'
  | 'relationship_graph'
  | 'priority_health';

/**
 * Statistics for a single memory type category.
 */
export interface CharacterTypeBucket {
  /** Number of memories of this type */
  count: number;

  /** Percentage of total memories this type represents */
  percentage: number;

  /** Average priority of memories in this type */
  avgPriority: number;
}

/**
 * Type distribution report showing memory composition by type.
 */
export interface TypeDistributionReport {
  /** Total number of memories in the index */
  totalMemories: number;

  /** Distribution breakdown by memory type */
  distribution: Record<MemoryType, CharacterTypeBucket>;
}

/**
 * Summary of a belief or high-priority memory.
 */
export interface BeliefSummary {
  /** Memory ID */
  id: string;

  /** Memory text/content */
  text: string;

  /** Current priority (0.0-1.0) */
  priority: number;

  /** Stability indicator */
  stability?: 'tentative' | 'stable' | 'canonical';

  /** Emotional intensity and label if present */
  emotion?: EmotionInfo;

  /** Number of times accessed */
  accessCount: number;

  /** Number of related memories */
  relatedCount: number;
}

/**
 * Top beliefs by priority report.
 */
export interface TopBeliefsReport {
  /** List of top beliefs ordered by priority */
  beliefs: BeliefSummary[];

  /** Total number of beliefs in the index */
  totalBeliefs: number;

  /** Number of canonical beliefs */
  canonicalCount: number;

  /** Average priority across all beliefs */
  avgBeliefsPriority: number;
}

/**
 * Emotional statistics grouped by emotion label.
 */
export interface EmotionGroup {
  /** Number of memories with this emotion */
  count: number;

  /** Average emotional intensity for this emotion */
  avgIntensity: number;

  /** Average priority of memories with this emotion */
  avgPriority: number;
}

/**
 * Emotional memory map report.
 */
export interface EmotionMapReport {
  /** Count of highly emotional memories (intensity >= 0.5) */
  highlyEmotional: number;

  /** Breakdown by emotion label */
  byLabel: Record<string, EmotionGroup>;

  /** Top emotionally intense memories */
  topEmotionalMemories: Array<{
    id: string;
    text: string;
    emotion: EmotionInfo;
  }>;
}

/**
 * Node in a relationship graph.
 */
export interface GraphNode {
  /** Memory ID */
  id: string;

  /** Memory type */
  type: MemoryType;

  /** Memory text (may be truncated for large graphs) */
  text: string;

  /** Current priority */
  priority: number;
}

/**
 * Edge in a relationship graph.
 */
export interface GraphEdge {
  /** Source memory ID */
  source: string;

  /** Target memory ID */
  target: string;

  /** Relationship type */
  type: RelationshipType;

  /** Optional relationship weight */
  weight?: number;
}

/**
 * Relationship graph export with nodes and edges.
 */
export interface RelationshipGraphReport {
  /** Graph nodes (memories) */
  nodes: GraphNode[];

  /** Graph edges (relationships) */
  edges: GraphEdge[];

  /** Note about limits applied */
  note?: string;
}

/**
 * Priority health statistics.
 */
export interface PriorityHealthReport {
  /** Count of high priority memories (> 0.7) */
  highPriority: { count: number; percentage: number; threshold: string };

  /** Count of medium priority memories (0.3-0.7) */
  mediumPriority: { count: number; percentage: number; threshold: string };

  /** Count of low priority memories (< 0.3) */
  lowPriority: { count: number; percentage: number; threshold: string };

  /** Count of memories not accessed in 60+ days with priority < 0.2 */
  decayingMemories: number;

  /** Count of canonical/stable memories */
  canonicalMemories: number;

  /** Average priority across all memories */
  avgPriority: number;

  /** Recommendations for maintenance */
  recommendations: string[];
}

/**
 * Union type for all introspection report types.
 */
export type IntrospectionReport =
  | TypeDistributionReport
  | TopBeliefsReport
  | EmotionMapReport
  | RelationshipGraphReport
  | PriorityHealthReport;

/**
 * Arguments for the inspect_character MCP tool.
 */
export interface InspectCharacterToolArgs {
  /** Index to inspect (required) */
  index: string;

  /** Introspection view type */
  view: IntrospectionView;

  /** Optional filters and view-specific parameters */
  limit?: number;
  minPriority?: number;
  minIntensity?: number;
  emotionLabel?: string;
}

/**
 * Result from the inspect_character MCP tool.
 */
export interface InspectCharacterResult {
  /** Operation status */
  status: 'ok' | 'error';

  /** Index that was inspected */
  index: string;

  /** Inspection view type */
  view: IntrospectionView;

  /** The introspection report (structure varies by view type) */
  report?: IntrospectionReport;

  /** Error message if status is 'error' */
  error?: string;
}
