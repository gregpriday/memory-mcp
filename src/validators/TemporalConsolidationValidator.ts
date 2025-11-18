import {
  MemoryRecord,
  RelationshipType,
  TemporalPolicy,
  ConsolidationWindow,
} from '../memory/types.js';
import { debugLog } from '../utils/logger.js';

/**
 * Result of temporal validation
 */
export interface TemporalValidationResult {
  /** Whether validation passed */
  ok: boolean;

  /** Error or warning messages */
  messages: string[];

  /** Suggested clamped date (if policy is warn-clamp) */
  clampedDate?: string;

  /** IDs of memories that should be excluded (if policy is warn-exclude) */
  excludedIds?: string[];

  /** Detected cycles in leads_to graph */
  cycles?: string[][];
}

/**
 * Temporal rule for relationship types
 */
interface TemporalRule {
  /** Allowed relationship types for this rule */
  types: RelationshipType[];

  /** Validation function: returns true if temporal constraint is satisfied */
  validate: (sourceValidAt: Date, targetValidAt: Date) => boolean;

  /** Human-readable description of the rule */
  description: string;
}

/**
 * Validator for temporal consolidation constraints.
 * Enforces temporal coherence in memory relationships and consolidation operations.
 */
export class TemporalConsolidationValidator {
  /**
   * Temporal rules for different relationship types.
   * These ensure that relationships respect the temporal narrative.
   */
  private static TEMPORAL_RULES: TemporalRule[] = [
    {
      types: ['leads_to', 'informs', 'consolidates'],
      validate: (sv, tv) => sv <= tv,
      description: 'Source valid_at must be <= target valid_at',
    },
    {
      types: ['derived_from'],
      validate: (sv, tv) => sv < tv,
      description: 'Source valid_at must be < target valid_at (strictly before)',
    },
    {
      types: ['evolves_into'],
      validate: (sv, tv) => sv <= tv,
      description: 'Source valid_at must be <= target valid_at',
    },
  ];

  /**
   * Check if a relationship edge satisfies temporal constraints.
   *
   * @param source Source memory
   * @param target Target memory
   * @param relationshipType Type of relationship
   * @returns Validation result with ok flag and explanation
   */
  checkEdge(
    source: MemoryRecord,
    target: MemoryRecord,
    relationshipType: RelationshipType
  ): { ok: boolean; why?: string } {
    // Get valid_at from dynamics, fallback to createdAt
    const sourceValidAt =
      source.metadata?.dynamics?.valid_at || source.metadata?.dynamics?.createdAt;
    const targetValidAt =
      target.metadata?.dynamics?.valid_at || target.metadata?.dynamics?.createdAt;

    if (!sourceValidAt || !targetValidAt) {
      return {
        ok: false,
        why: `Missing valid_at: source=${sourceValidAt}, target=${targetValidAt}`,
      };
    }

    const sv = new Date(sourceValidAt);
    const tv = new Date(targetValidAt);

    // Find applicable rule
    const rule = TemporalConsolidationValidator.TEMPORAL_RULES.find((r) =>
      r.types.includes(relationshipType)
    );

    if (!rule) {
      // No temporal rule for this relationship type - allow it
      return { ok: true };
    }

    if (!rule.validate(sv, tv)) {
      return {
        ok: false,
        why: `${rule.description}: source ${sourceValidAt} vs target ${targetValidAt}`,
      };
    }

    return { ok: true };
  }

  /**
   * Check for cycles in the leads_to relationship graph.
   * Cycles indicate temporal contradictions (e.g., A leads_to B, B leads_to A).
   *
   * @param summaries Memories to check for cycles
   * @returns Validation result with detected cycles
   */
  checkNoCyclesLeadsTo(summaries: MemoryRecord[]): { ok: boolean; cycles?: string[][] } {
    const graph = new Map<string, Set<string>>();

    // Build adjacency list for leads_to edges
    for (const memory of summaries) {
      const relationships = memory.metadata?.relationships || [];
      const leadsToEdges = relationships.filter((r) => r.type === 'leads_to');

      if (leadsToEdges.length > 0) {
        const edges = graph.get(memory.id) || new Set();
        for (const edge of leadsToEdges) {
          edges.add(edge.targetId);
        }
        graph.set(memory.id, edges);
      }
    }

    // DFS-based cycle detection
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (node: string, path: string[]): void => {
      visited.add(node);
      recStack.add(node);
      path.push(node);

      const neighbors = graph.get(node) || new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor, [...path]);
        } else if (recStack.has(neighbor)) {
          // Found a cycle
          const cycleStart = path.indexOf(neighbor);
          cycles.push(path.slice(cycleStart));
        }
      }

      recStack.delete(node);
    };

    for (const memory of summaries) {
      if (!visited.has(memory.id)) {
        dfs(memory.id, []);
      }
    }

    if (cycles.length > 0) {
      debugLog('validation', 'Detected cycles in leads_to graph', { cycles });
      return { ok: false, cycles };
    }

    return { ok: true };
  }

  /**
   * Check that all source memories fall within the consolidation window.
   *
   * @param sources Source memories to check
   * @param window Consolidation window
   * @returns Validation result with offending memory IDs
   */
  checkWindowContainment(
    sources: MemoryRecord[],
    window: ConsolidationWindow
  ): { ok: boolean; offenders: string[] } {
    const windowStart = new Date(window.startDate);
    const windowEnd = new Date(window.endDate);
    const offenders: string[] = [];

    for (const source of sources) {
      const validAt = source.metadata?.dynamics?.valid_at || source.metadata?.dynamics?.createdAt;
      if (!validAt) {
        offenders.push(source.id);
        continue;
      }

      const sv = new Date(validAt);
      if (sv < windowStart || sv > windowEnd) {
        offenders.push(source.id);
      }
    }

    if (offenders.length > 0) {
      debugLog('validation', 'Source memories outside window', {
        window: `${window.startDate} to ${window.endDate}`,
        offenders,
      });
      return { ok: false, offenders };
    }

    return { ok: true, offenders: [] };
  }

  /**
   * Compute the clamped consolidation date for a summary memory.
   * The date is clamped to max(source.valid_at) to ensure the summary
   * cannot be dated before its sources.
   *
   * @param sources Source memories
   * @param proposedDate Proposed summary date (e.g., midpoint of window)
   * @returns Clamped date (ISO 8601)
   */
  computeClampedDate(sources: MemoryRecord[], proposedDate: string): string {
    // Find the latest valid_at among sources
    let maxSourceValidAt: Date | null = null;

    for (const source of sources) {
      const validAt = source.metadata?.dynamics?.valid_at || source.metadata?.dynamics?.createdAt;
      if (validAt) {
        const sv = new Date(validAt);
        if (!maxSourceValidAt || sv > maxSourceValidAt) {
          maxSourceValidAt = sv;
        }
      }
    }

    if (!maxSourceValidAt) {
      // No valid_at found in sources, use proposed date
      return proposedDate;
    }

    const proposed = new Date(proposedDate);

    // Clamp: max(proposed, maxSourceValidAt)
    const clamped = proposed > maxSourceValidAt ? proposed : maxSourceValidAt;

    return clamped.toISOString();
  }

  /**
   * Validate temporal consolidation constraints according to policy.
   *
   * @param sources Source memories to consolidate
   * @param proposedSummaryDate Proposed date for summary memory
   * @param window Consolidation window (for containment check)
   * @param policy Temporal policy to apply
   * @returns Validation result with policy-specific actions
   */
  validateConsolidation(
    sources: MemoryRecord[],
    proposedSummaryDate: string,
    window: ConsolidationWindow,
    policy: TemporalPolicy = 'warn-clamp'
  ): TemporalValidationResult {
    const messages: string[] = [];

    // Policy: off - skip validation entirely
    if (policy === 'off') {
      return {
        ok: true,
        messages: ['Temporal validation disabled (policy: off)'],
      };
    }

    // Check window containment
    const containment = this.checkWindowContainment(sources, window);
    if (!containment.ok) {
      if (policy === 'strict') {
        return {
          ok: false,
          messages: [
            `Window containment violated: ${containment.offenders.length} source(s) outside window`,
            ...containment.offenders.map((id) => `  - ${id}`),
          ],
        };
      } else if (policy === 'warn-exclude') {
        messages.push(
          `Warning: Excluding ${containment.offenders.length} source(s) outside window`
        );
        // Filter out offenders
        sources = sources.filter((s) => !containment.offenders.includes(s.id));
        if (sources.length === 0) {
          return {
            ok: false,
            messages: ['All sources excluded due to window containment violations'],
          };
        }
      } else {
        // warn-clamp: just log warning
        messages.push(
          `Warning: ${containment.offenders.length} source(s) outside window (clamping applied)`
        );
      }
    }

    // Compute clamped date
    const clampedDate = this.computeClampedDate(sources, proposedSummaryDate);

    if (clampedDate !== proposedSummaryDate) {
      if (policy === 'strict') {
        return {
          ok: false,
          messages: [
            `Summary date ${proposedSummaryDate} predates sources (latest: ${clampedDate})`,
          ],
        };
      } else {
        messages.push(
          `Clamped summary date from ${proposedSummaryDate} to ${clampedDate} (max source valid_at)`
        );
      }
    }

    return {
      ok: true,
      messages,
      clampedDate,
      excludedIds: policy === 'warn-exclude' ? containment.offenders : undefined,
    };
  }

  /**
   * Validate all relationships in a consolidation result.
   *
   * @param summaries Summary memories with relationships
   * @param sources Source memories
   * @param policy Temporal policy
   * @returns Validation result
   */
  validateRelationships(
    summaries: MemoryRecord[],
    sources: MemoryRecord[],
    policy: TemporalPolicy = 'warn-clamp'
  ): TemporalValidationResult {
    if (policy === 'off') {
      return {
        ok: true,
        messages: ['Relationship validation disabled (policy: off)'],
      };
    }

    const messages: string[] = [];
    const allMemories = [...summaries, ...sources];
    const memoryMap = new Map(allMemories.map((m) => [m.id, m]));

    // Check all relationships in summaries
    for (const summary of summaries) {
      const relationships = summary.metadata?.relationships || [];

      for (const rel of relationships) {
        const target = memoryMap.get(rel.targetId);
        if (!target) {
          messages.push(`Relationship target ${rel.targetId} not found`);
          continue;
        }

        const result = this.checkEdge(summary, target, rel.type);
        if (!result.ok) {
          if (policy === 'strict') {
            return {
              ok: false,
              messages: [
                `Temporal constraint violated: ${summary.id} -> ${rel.targetId} (${rel.type})`,
                result.why || '',
              ],
            };
          } else {
            messages.push(
              `Warning: Temporal constraint violated: ${summary.id} -> ${rel.targetId} (${rel.type}): ${result.why}`
            );
          }
        }
      }
    }

    // Check for cycles in leads_to graph
    const cycleCheck = this.checkNoCyclesLeadsTo(summaries);
    if (!cycleCheck.ok) {
      if (policy === 'strict') {
        return {
          ok: false,
          messages: ['Cycles detected in leads_to graph'],
          cycles: cycleCheck.cycles,
        };
      } else {
        messages.push(`Warning: Cycles detected in leads_to graph`);
      }
    }

    return { ok: true, messages };
  }
}
