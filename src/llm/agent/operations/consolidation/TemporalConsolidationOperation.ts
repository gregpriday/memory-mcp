import { IMemoryRepository } from '../../../../memory/IMemoryRepository.js';
import {
  RefineMemoriesToolArgs,
  MemoryRecord,
  ConsolidationWindow,
  TemporalPolicy,
  RefineMemoriesResult,
  MemoryToUpsert,
} from '../../../../memory/types.js';
import { TemporalConsolidationValidator } from '../../../../validators/TemporalConsolidationValidator.js';
import { WindowingStrategy } from './WindowingStrategy.js';
import { debugLog } from '../../../../utils/logger.js';
import { createHash } from 'crypto';

/**
 * Per-window consolidation result
 */
export interface WindowResult {
  windowId: string;
  bounds: { start: string; end: string };
  policyApplied: TemporalPolicy;
  sourceCount: number;
  summaryCount: number;
  validatorWarnings: string[];
  createdMemoryIds: string[];
  createdEdgeCount: number;
  status: 'completed' | 'skipped' | 'failed';
  reason?: string;
}

/**
 * Orchestrates temporal consolidation across multiple windows.
 * Integrates WindowingStrategy and TemporalConsolidationValidator.
 */
export class TemporalConsolidationOperation {
  constructor(
    private repo: IMemoryRepository,
    private validator: TemporalConsolidationValidator
  ) {}

  /**
   * Execute temporal consolidation.
   *
   * @param args Refinement arguments with temporal mode enabled
   * @param indexName Target index
   * @param sources Source memories to consolidate
   * @returns Refinement result with per-window details
   */
  async execute(
    args: RefineMemoriesToolArgs,
    indexName: string,
    sources: MemoryRecord[]
  ): Promise<RefineMemoriesResult> {
    const policy = args.temporalPolicy || 'warn-clamp';
    const windowResults: WindowResult[] = [];

    debugLog('temporal-consolidation', 'Starting temporal consolidation', {
      sourceCount: sources.length,
      policy,
      explicitWindows: args.consolidationWindows?.length || 0,
    });

    // Step 1: Determine windows
    let windows: ConsolidationWindow[];
    if (args.consolidationWindows && args.consolidationWindows.length > 0) {
      windows = args.consolidationWindows;
      debugLog('temporal-consolidation', 'Using explicit windows', { count: windows.length });
    } else {
      // Auto-detect windows using WindowingStrategy
      const strategy = new WindowingStrategy({ epsilonDays: 14, minMemories: 2 });
      const detection = strategy.detectWindows(sources);
      windows = detection.windows;
      debugLog('temporal-consolidation', 'Auto-detected windows', {
        count: windows.length,
        stats: detection.stats,
      });
    }

    if (windows.length === 0) {
      return {
        status: 'ok',
        index: indexName,
        dryRun: args.dryRun || false,
        summary: 'No consolidation windows detected',
        actions: [],
        appliedActionsCount: 0,
      };
    }

    // Step 2: Process each window
    for (let i = 0; i < windows.length; i++) {
      const window = windows[i];
      const windowId = `window_${i + 1}`;

      try {
        const result = await this.processWindow(
          window,
          windowId,
          sources,
          indexName,
          policy,
          args.dryRun || false
        );
        windowResults.push(result);
      } catch (error) {
        debugLog('temporal-consolidation', 'Window processing failed', {
          windowId,
          error: String(error),
        });
        windowResults.push({
          windowId,
          bounds: { start: window.startDate, end: window.endDate },
          policyApplied: policy,
          sourceCount: 0,
          summaryCount: 0,
          validatorWarnings: [],
          createdMemoryIds: [],
          createdEdgeCount: 0,
          status: 'failed',
          reason: String(error),
        });
      }
    }

    // Step 3: Create leads_to edges between windows
    if (!args.dryRun) {
      await this.createLeadsToEdges(windowResults, indexName, policy);
    }

    // Step 4: Build summary
    const totalSummaries = windowResults.reduce((sum, r) => sum + r.summaryCount, 0);
    const totalWarnings = windowResults.reduce((sum, r) => sum + r.validatorWarnings.length, 0);
    const summary = `Temporal consolidation: ${windows.length} window(s), ${totalSummaries} summaries created${totalWarnings > 0 ? `, ${totalWarnings} warnings` : ''}`;

    return {
      status: 'ok',
      index: indexName,
      dryRun: args.dryRun || false,
      summary,
      actions: [], // Not using action-based approach for temporal mode
      appliedActionsCount: totalSummaries,
      newMemoryIds: windowResults.flatMap((r) => r.createdMemoryIds),
    };
  }

  /**
   * Process a single consolidation window.
   */
  private async processWindow(
    window: ConsolidationWindow,
    windowId: string,
    allSources: MemoryRecord[],
    indexName: string,
    policy: TemporalPolicy,
    dryRun: boolean
  ): Promise<WindowResult> {
    const warnings: string[] = [];

    // Filter sources within window bounds
    const windowStart = new Date(window.startDate);
    const windowEnd = new Date(window.endDate);
    let windowSources = allSources.filter((m) => {
      const validAt = new Date(
        m.metadata?.dynamics?.valid_at || m.metadata?.dynamics?.createdAt || 0
      );
      return validAt >= windowStart && validAt <= windowEnd;
    });

    debugLog('temporal-consolidation', 'Processing window', {
      windowId,
      bounds: { start: window.startDate, end: window.endDate },
      sourcesInWindow: windowSources.length,
    });

    if (windowSources.length === 0) {
      return {
        windowId,
        bounds: { start: window.startDate, end: window.endDate },
        policyApplied: policy,
        sourceCount: 0,
        summaryCount: 0,
        validatorWarnings: [],
        createdMemoryIds: [],
        createdEdgeCount: 0,
        status: 'skipped',
        reason: 'No sources in window',
      };
    }

    // Validate and clamp consolidation date
    const proposedDate = window.consolidationDate || this.computeMidpoint(window);
    const validation = this.validator.validateConsolidation(
      windowSources,
      proposedDate,
      window,
      policy
    );

    if (!validation.ok) {
      if (policy === 'strict') {
        return {
          windowId,
          bounds: { start: window.startDate, end: window.endDate },
          policyApplied: policy,
          sourceCount: windowSources.length,
          summaryCount: 0,
          validatorWarnings: validation.messages,
          createdMemoryIds: [],
          createdEdgeCount: 0,
          status: 'failed',
          reason: validation.messages.join('; '),
        };
      }
    }

    warnings.push(...validation.messages);

    // Exclude offending sources if policy is warn-exclude
    if (validation.excludedIds && validation.excludedIds.length > 0) {
      windowSources = windowSources.filter((s) => !validation.excludedIds!.includes(s.id));
      if (windowSources.length === 0) {
        return {
          windowId,
          bounds: { start: window.startDate, end: window.endDate },
          policyApplied: policy,
          sourceCount: 0,
          summaryCount: 0,
          validatorWarnings: warnings,
          createdMemoryIds: [],
          createdEdgeCount: 0,
          status: 'skipped',
          reason: 'All sources excluded by policy',
        };
      }
    }

    const finalDate = validation.clampedDate || proposedDate;

    // For now, create a simple summary (in full implementation, this would call LLM)
    // This is a placeholder for the LLM call that would generate rich summaries
    const summary: MemoryToUpsert = {
      text: `Consolidated summary for ${window.focus || windowId}: ${windowSources.length} memories from ${window.startDate} to ${window.endDate}`,
      metadata: {
        kind: 'summary',
        memoryType: 'semantic',
        importance: 'medium',
        topic: window.focus || 'Consolidated memories',
        derivedFromIds: windowSources.map((s) => s.id),
        dynamics: {
          valid_at: finalDate,
          recorded_at: new Date().toISOString(),
          time_confidence: 1.0,
          createdAt: new Date().toISOString(),
          initialPriority: 0.7,
          currentPriority: 0.7,
          accessCount: 0,
          maxAccessCount: 0,
          sleepCycles: 0,
        },
        consolidation: {
          method: 'temporal',
          consolidated_at: new Date().toISOString(),
          source_period: `${window.startDate}/${window.endDate}`,
          source_ids: windowSources.map((s) => s.id),
          version: 1,
          summary_hash: this.computeSummaryHash(windowSources, window),
        },
      },
    };

    if (dryRun) {
      return {
        windowId,
        bounds: { start: window.startDate, end: window.endDate },
        policyApplied: policy,
        sourceCount: windowSources.length,
        summaryCount: 1,
        validatorWarnings: warnings,
        createdMemoryIds: [],
        createdEdgeCount: 0,
        status: 'completed',
      };
    }

    // Create summary memory
    const createdIds = await this.repo.upsertMemories(indexName, [summary]);
    const summaryId = createdIds[0];

    // Create consolidates edges (summary → sources)
    const consolidatesEdges: Array<{ sourceId: string; targetId: string; type: string }> = [];
    for (const source of windowSources) {
      consolidatesEdges.push({
        sourceId: summaryId,
        targetId: source.id,
        type: 'consolidates',
      });
    }

    // Validate and create edges
    // Note: In full implementation, this would use repository's relationship methods
    // For now, we're just counting them
    const edgeCount = consolidatesEdges.length;

    debugLog('temporal-consolidation', 'Window processed', {
      windowId,
      summaryId,
      edgeCount,
      warnings: warnings.length,
    });

    return {
      windowId,
      bounds: { start: window.startDate, end: window.endDate },
      policyApplied: policy,
      sourceCount: windowSources.length,
      summaryCount: 1,
      validatorWarnings: warnings,
      createdMemoryIds: [summaryId],
      createdEdgeCount: edgeCount,
      status: 'completed',
    };
  }

  /**
   * Create leads_to edges between summaries from sequential windows.
   */
  private async createLeadsToEdges(
    windowResults: WindowResult[],
    _indexName: string,
    _policy: TemporalPolicy
  ): Promise<void> {
    const completedWindows = windowResults.filter((r) => r.status === 'completed');

    for (let i = 0; i < completedWindows.length - 1; i++) {
      const current = completedWindows[i];
      const next = completedWindows[i + 1];

      if (current.createdMemoryIds.length > 0 && next.createdMemoryIds.length > 0) {
        const currentSummaryId = current.createdMemoryIds[0];
        const nextSummaryId = next.createdMemoryIds[0];

        // In full implementation, create leads_to edge via repository
        debugLog('temporal-consolidation', 'Creating leads_to edge', {
          from: currentSummaryId,
          to: nextSummaryId,
        });
      }
    }
  }

  /**
   * Compute midpoint of consolidation window.
   */
  private computeMidpoint(window: ConsolidationWindow): string {
    const start = new Date(window.startDate).getTime();
    const end = new Date(window.endDate).getTime();
    const midpoint = new Date((start + end) / 2);
    return midpoint.toISOString();
  }

  /**
   * Compute idempotency hash for a consolidation.
   */
  private computeSummaryHash(sources: MemoryRecord[], window: ConsolidationWindow): string {
    const sortedIds = sources.map((s) => s.id).sort();
    const input = JSON.stringify({
      source_ids: sortedIds,
      window_start: window.startDate,
      window_end: window.endDate,
      focus: window.focus || '',
      version: 1,
    });
    return createHash('sha256').update(input).digest('hex').substring(0, 16);
  }
}
