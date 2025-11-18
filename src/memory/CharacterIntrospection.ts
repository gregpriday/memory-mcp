/**
 * CharacterIntrospection Service
 *
 * Provides high-level developer-facing introspection tools for character memory inspection.
 * Orchestrates repository aggregation queries and generates developer-friendly reports.
 */

import { IMemoryRepository } from './IMemoryRepository.js';
import {
  IntrospectionReport,
  IntrospectionView,
  TypeDistributionReport,
  TopBeliefsReport,
  EmotionMapReport,
  RelationshipGraphReport,
  PriorityHealthReport,
} from './types.js';
import { logDebug, logError } from '../utils/logger.js';

/**
 * Options for introspection queries.
 */
export interface IntrospectionOptions {
  limit?: number;
  minPriority?: number;
  minIntensity?: number;
  emotionLabel?: string;
}

/**
 * CharacterIntrospection Service
 *
 * Orchestrates memory introspection operations and generates reports.
 * Each view type dispatches to the corresponding repository method.
 */
export class CharacterIntrospection {
  /**
   * Create a new CharacterIntrospection service.
   *
   * @param repo - Memory repository for data access
   */
  constructor(private repo: IMemoryRepository) {}

  /**
   * Generate an introspection report for the specified view.
   *
   * @param indexName - Index to introspect
   * @param view - View type (determines report structure)
   * @param options - Optional filters and parameters
   * @returns Introspection report (structure varies by view type)
   * @throws Error if index doesn't exist or query fails
   */
  async inspectCharacter(
    indexName: string,
    view: IntrospectionView,
    options?: IntrospectionOptions
  ): Promise<IntrospectionReport> {
    logDebug('introspection', `Starting ${view} introspection for index "${indexName}"`);

    try {
      switch (view) {
        case 'type_distribution':
          return await this.repo.getTypeDistribution(indexName);

        case 'top_beliefs':
          return await this.repo.getTopMemoriesByPriority(indexName, {
            minPriority: options?.minPriority,
            limit: options?.limit,
          });

        case 'emotion_map':
          return await this.repo.getEmotionalMemories(indexName, {
            minIntensity: options?.minIntensity,
            emotionLabel: options?.emotionLabel,
            limit: options?.limit,
          });

        case 'relationship_graph':
          return await this.repo.getRelationshipGraph(indexName, {
            minPriority: options?.minPriority,
          });

        case 'priority_health':
          return await this.repo.getPriorityHealth(indexName);

        default:
          throw new Error(`Unknown introspection view: ${view}`);
      }
    } catch (error) {
      logError('introspection', `${view} introspection failed`, {
        error: error instanceof Error ? error : new Error(String(error)),
        meta: { indexName, view },
      });
      throw error;
    }
  }

  /**
   * Generate a formatted text summary of a type distribution report.
   *
   * @param report - Type distribution report
   * @returns Human-readable summary
   */
  summarizeTypeDistribution(report: TypeDistributionReport): string {
    const lines: string[] = [`Memory Composition (${report.totalMemories} total):`, ''];

    const sorted = Object.entries(report.distribution)
      .filter(([, bucket]) => bucket.count > 0)
      .sort((a, b) => b[1].count - a[1].count);

    for (const [type, bucket] of sorted) {
      lines.push(
        `  ${type}: ${bucket.count} (${bucket.percentage.toFixed(1)}%) - avg priority ${bucket.avgPriority.toFixed(2)}`
      );
    }

    return lines.join('\n');
  }

  /**
   * Generate a formatted text summary of a top beliefs report.
   *
   * @param report - Top beliefs report
   * @returns Human-readable summary
   */
  summarizeTopBeliefs(report: TopBeliefsReport): string {
    const lines: string[] = [
      `Top Beliefs (${report.totalBeliefs} total, ${report.canonicalCount} canonical):`,
      '',
    ];

    for (const belief of report.beliefs) {
      const stability = belief.stability ? ` [${belief.stability}]` : '';
      const emotion = belief.emotion
        ? ` (${belief.emotion.label}, intensity ${belief.emotion.intensity})`
        : '';
      lines.push(
        `  • (${belief.priority.toFixed(2)})${stability} "${belief.text.substring(0, 60)}..."${emotion}`
      );
    }

    if (lines.length === 2) {
      lines.push('  (no beliefs found)');
    }

    return lines.join('\n');
  }

  /**
   * Generate a formatted text summary of an emotion map report.
   *
   * @param report - Emotion map report
   * @returns Human-readable summary
   */
  summarizeEmotionMap(report: EmotionMapReport): string {
    const lines: string[] = [
      `Emotional Memories (${report.highlyEmotional} highly emotional):`,
      '',
    ];

    if (Object.keys(report.byLabel).length === 0) {
      lines.push('  (no emotional memories found)');
      return lines.join('\n');
    }

    for (const [label, stats] of Object.entries(report.byLabel)) {
      lines.push(
        `  ${label}: ${stats.count} (avg intensity ${stats.avgIntensity.toFixed(2)}, avg priority ${stats.avgPriority.toFixed(2)})`
      );
    }

    return lines.join('\n');
  }

  /**
   * Generate a formatted text summary of a relationship graph report.
   *
   * @param report - Relationship graph report
   * @returns Human-readable summary
   */
  summarizeRelationshipGraph(report: RelationshipGraphReport): string {
    const lines: string[] = [
      `Relationship Graph (${report.nodes.length} nodes, ${report.edges.length} edges):`,
      '',
    ];

    if (report.nodes.length === 0) {
      lines.push('  (no memories with relationships found)');
    } else {
      lines.push(`  Nodes by type:`);
      const typeCount: Record<string, number> = {};
      for (const node of report.nodes) {
        typeCount[node.type] = (typeCount[node.type] || 0) + 1;
      }
      for (const [type, count] of Object.entries(typeCount)) {
        lines.push(`    ${type}: ${count}`);
      }

      lines.push('');
      lines.push(`  Edge types:`);
      const edgeCount: Record<string, number> = {};
      for (const edge of report.edges) {
        edgeCount[edge.type] = (edgeCount[edge.type] || 0) + 1;
      }
      for (const [type, count] of Object.entries(edgeCount)) {
        lines.push(`    ${type}: ${count}`);
      }
    }

    if (report.note) {
      lines.push('');
      lines.push(`  Note: ${report.note}`);
    }

    return lines.join('\n');
  }

  /**
   * Generate a formatted text summary of a priority health report.
   *
   * @param report - Priority health report
   * @returns Human-readable summary
   */
  summarizePriorityHealth(report: PriorityHealthReport): string {
    const lines: string[] = [
      'Memory Health Report:',
      '',
      'Priority Distribution:',
      `  High (> 0.7): ${report.highPriority.count} (${report.highPriority.percentage.toFixed(1)}%)`,
      `  Medium (0.3-0.7): ${report.mediumPriority.count} (${report.mediumPriority.percentage.toFixed(1)}%)`,
      `  Low (< 0.3): ${report.lowPriority.count} (${report.lowPriority.percentage.toFixed(1)}%)`,
      `  Average priority: ${report.avgPriority.toFixed(2)}`,
      '',
      `Lifecycle Status:`,
      `  Canonical: ${report.canonicalMemories}`,
      `  Decaying: ${report.decayingMemories}`,
      '',
      'Recommendations:',
    ];

    for (const rec of report.recommendations) {
      lines.push(`  • ${rec}`);
    }

    return lines.join('\n');
  }

  /**
   * Generate a formatted text summary of an introspection report.
   * Dispatches to the appropriate summary method based on report type.
   *
   * @param view - View type
   * @param report - Introspection report
   * @returns Human-readable summary
   */
  summarizeReport(view: IntrospectionView, report: IntrospectionReport): string {
    switch (view) {
      case 'type_distribution':
        return this.summarizeTypeDistribution(report as TypeDistributionReport);
      case 'top_beliefs':
        return this.summarizeTopBeliefs(report as TopBeliefsReport);
      case 'emotion_map':
        return this.summarizeEmotionMap(report as EmotionMapReport);
      case 'relationship_graph':
        return this.summarizeRelationshipGraph(report as RelationshipGraphReport);
      case 'priority_health':
        return this.summarizePriorityHealth(report as PriorityHealthReport);
      default:
        return JSON.stringify(report, null, 2);
    }
  }
}
