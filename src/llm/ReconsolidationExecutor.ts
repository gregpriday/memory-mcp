import { IMemoryRepository } from '../memory/IMemoryRepository.js';
import {
  ReconsolidationPlan,
  ConsolidationReport,
  MemoryToUpsert,
  MemoryMetadata,
} from '../memory/types.js';
import { debugLog } from '../utils/logger.js';

/**
 * Executes reconsolidation plans generated during recall.
 *
 * Takes a structured plan from the LLM describing derived memories to create,
 * supersessions to apply, and lifecycle updates, and executes it against the
 * repository with performance monitoring and error handling.
 */
export class ReconsolidationExecutor {
  constructor(private repo: IMemoryRepository) {}

  /**
   * Execute a reconsolidation plan and return a consolidation report.
   *
   * @param plan - The reconsolidation plan from the LLM
   * @param indexName - The index to apply changes to
   * @param validMemoryIds - Set of memory IDs that were involved in this recall (for security validation)
   * @returns Consolidation report with created IDs, supersessions applied, and metrics
   */
  async execute(
    plan: ReconsolidationPlan,
    indexName: string,
    validMemoryIds: Set<string>
  ): Promise<ConsolidationReport> {
    const startTime = performance.now();
    const report: ConsolidationReport = {
      createdMemoryIds: [],
      supersededPairs: [],
      sleepCycleIncrementedIds: [],
      durationMs: 0,
    };

    try {
      const warnings: string[] = [];

      // Security: Validate all derivedFromIds against validMemoryIds
      if (plan.derivedMemories) {
        for (const derived of plan.derivedMemories) {
          const invalidIds = derived.derivedFromIds.filter((id) => !validMemoryIds.has(id));
          if (invalidIds.length > 0) {
            debugLog(
              'reconsolidation',
              `Security: Rejecting derived memory with invalid derivedFromIds: ${invalidIds.join(', ')}`
            );
            warnings.push(
              `Rejected derived memory referencing non-recalled IDs: ${invalidIds.join(', ')}`
            );
          }
        }
      }

      // Security: Validate sleepCycleTargets against validMemoryIds
      if (plan.sleepCycleTargets) {
        const invalidIds = plan.sleepCycleTargets.filter((id) => !validMemoryIds.has(id));
        if (invalidIds.length > 0) {
          debugLog(
            'reconsolidation',
            `Security: Rejecting sleepCycleTargets with invalid IDs: ${invalidIds.join(', ')}`
          );
          warnings.push(
            `Rejected sleepCycleTargets for non-recalled IDs: ${invalidIds.join(', ')}`
          );
        }
      }

      // Security: Validate supersessionPairs sourceIds against validMemoryIds
      if (plan.supersessionPairs) {
        for (const pair of plan.supersessionPairs) {
          if (!validMemoryIds.has(pair.sourceId)) {
            debugLog(
              'reconsolidation',
              `Security: Rejecting supersession with invalid sourceId: ${pair.sourceId}`
            );
            warnings.push(`Rejected supersession for non-recalled sourceId: ${pair.sourceId}`);
          }
        }
      }

      // Step 1: Create derived memories (only those with valid derivedFromIds)
      const createdIds: string[] = [];
      if (plan.derivedMemories && plan.derivedMemories.length > 0) {
        const validDerivedMemories = plan.derivedMemories.filter((derived) =>
          derived.derivedFromIds.every((id) => validMemoryIds.has(id))
        );

        if (validDerivedMemories.length > 0) {
          debugLog(
            'reconsolidation',
            `Creating ${validDerivedMemories.length} derived memories (${plan.derivedMemories.length - validDerivedMemories.length} rejected)`
          );

          const memoriesToUpsert: MemoryToUpsert[] = validDerivedMemories.map((derived) => ({
            text: derived.text,
            metadata: {
              ...derived.metadata,
              memoryType: derived.memoryType,
              kind: 'derived',
              derivedFromIds: derived.derivedFromIds,
              relationships: derived.relationships,
              source: 'system' as const,
            } as Partial<MemoryMetadata>,
          }));

          const newIds = await this.repo.upsertMemories(indexName, memoriesToUpsert);
          createdIds.push(...newIds);
          report.createdMemoryIds = newIds;
        }
      }

      // Step 2: Apply supersessions (runs independently of derived memory creation)
      if (plan.supersessionPairs && plan.supersessionPairs.length > 0) {
        const supersessionPairsWithIds: Array<{ sourceId: string; supersededById: string }> = [];

        for (const pair of plan.supersessionPairs) {
          // Skip if sourceId is invalid
          if (!validMemoryIds.has(pair.sourceId)) {
            continue;
          }

          // If supersededById is a number, it references the index of a created memory
          if (typeof pair.supersededById === 'number') {
            // Validate it's a valid integer index
            if (
              !Number.isInteger(pair.supersededById) ||
              pair.supersededById < 0 ||
              pair.supersededById >= createdIds.length
            ) {
              debugLog(
                'reconsolidation',
                `Invalid numeric supersededById index: ${pair.supersededById} (valid range: 0-${createdIds.length - 1})`
              );
              warnings.push(`Rejected supersession with invalid index: ${pair.supersededById}`);
              continue;
            }

            supersessionPairsWithIds.push({
              sourceId: pair.sourceId,
              supersededById: createdIds[pair.supersededById],
            });
          } else {
            // Direct string ID reference
            supersessionPairsWithIds.push({
              sourceId: pair.sourceId,
              supersededById: String(pair.supersededById),
            });
          }
        }

        if (supersessionPairsWithIds.length > 0) {
          const supersededCount = await this.repo.markMemoriesSuperseded(
            indexName,
            supersessionPairsWithIds
          );
          report.supersededPairs = supersessionPairsWithIds;

          debugLog('reconsolidation', `Marked ${supersededCount} memories as superseded`);
        }
      }

      // Step 3: Increment sleep cycles (runs independently of derived memory creation)
      const sleepCycleTargets = new Set<string>();

      // Add valid targets from plan
      if (plan.sleepCycleTargets) {
        plan.sleepCycleTargets
          .filter((id) => validMemoryIds.has(id))
          .forEach((id) => sleepCycleTargets.add(id));
      }

      // Also increment sleep cycles on derived memories themselves
      createdIds.forEach((id) => sleepCycleTargets.add(id));

      if (sleepCycleTargets.size > 0) {
        const sleepCycleIds = Array.from(sleepCycleTargets);
        const incrementedCount = await this.repo.incrementSleepCycles(indexName, sleepCycleIds);
        report.sleepCycleIncrementedIds = sleepCycleIds;

        debugLog('reconsolidation', `Incremented sleepCycles for ${incrementedCount} memories`);
      }

      // Calculate duration
      const endTime = performance.now();
      report.durationMs = Math.round(endTime - startTime);

      // Warn if execution took too long
      if (report.durationMs > 500) {
        warnings.push(`Reconsolidation took ${report.durationMs}ms (threshold: 500ms)`);
      }

      // Add plan notes
      if (plan.notes) {
        warnings.push(plan.notes);
      }

      // Consolidate warnings into report notes
      if (warnings.length > 0) {
        report.notes = warnings.join('; ');
        debugLog('reconsolidation', report.notes);
      }

      debugLog(
        'reconsolidation',
        `Reconsolidation complete: created=${report.createdMemoryIds.length}, ` +
          `superseded=${report.supersededPairs.length}, ` +
          `sleepCycles=${report.sleepCycleIncrementedIds.length}, ` +
          `duration=${report.durationMs}ms`
      );

      return report;
    } catch (error) {
      const endTime = performance.now();
      report.durationMs = Math.round(endTime - startTime);

      // Log error but don't throw - reconsolidation is best-effort
      const errorMessage = error instanceof Error ? error.message : String(error);
      debugLog('reconsolidation', `Error during execution: ${errorMessage}`);

      report.notes = `Partial execution: ${errorMessage}`;
      return report;
    }
  }
}
