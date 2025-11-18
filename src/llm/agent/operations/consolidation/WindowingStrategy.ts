import { MemoryRecord, ConsolidationWindow } from '../../../../memory/types.js';
import { debugLog } from '../../../../utils/logger.js';

/**
 * Configuration for auto-windowing
 */
export interface WindowingConfig {
  /**
   * Maximum gap between memories in the same window (in days).
   * Memories separated by more than this are placed in different windows.
   * Default: 14 days (2 weeks)
   */
  epsilonDays?: number;

  /**
   * Minimum number of memories required to form a window.
   * Windows with fewer memories are merged with adjacent windows.
   * Default: 2
   */
  minMemories?: number;

  /**
   * Alignment strategy for window boundaries.
   * - 'natural': Align to natural calendar boundaries (month/quarter)
   * - 'cluster': Use DBSCAN clustering on timestamps
   * Default: 'cluster'
   */
  alignment?: 'natural' | 'cluster';
}

/**
 * Result of window detection
 */
export interface WindowDetectionResult {
  /** Detected windows */
  windows: ConsolidationWindow[];

  /** Memories that were not assigned to any window (outliers) */
  unassigned: MemoryRecord[];

  /** Statistics about the windowing process */
  stats: {
    totalMemories: number;
    windowCount: number;
    avgWindowSize: number;
    outlierCount: number;
  };
}

/**
 * Strategy for detecting consolidation windows from a set of memories.
 * Uses DBSCAN-inspired clustering on 1D time axis.
 */
export class WindowingStrategy {
  private config: Required<WindowingConfig>;

  constructor(config: WindowingConfig = {}) {
    this.config = {
      epsilonDays: config.epsilonDays ?? 14,
      minMemories: config.minMemories ?? 2,
      alignment: config.alignment ?? 'cluster',
    };
  }

  /**
   * Auto-detect consolidation windows from memories.
   *
   * @param memories Memories to cluster into windows
   * @returns Detected windows and statistics
   */
  detectWindows(memories: MemoryRecord[]): WindowDetectionResult {
    if (memories.length === 0) {
      return {
        windows: [],
        unassigned: [],
        stats: {
          totalMemories: 0,
          windowCount: 0,
          avgWindowSize: 0,
          outlierCount: 0,
        },
      };
    }

    // Extract valid_at timestamps and sort
    const timestampedMemories = memories
      .map((m) => {
        const validAtStr = m.metadata?.dynamics?.valid_at || m.metadata?.dynamics?.createdAt || '';
        return {
          memory: m,
          validAt: new Date(validAtStr),
        };
      })
      .filter((tm) => !isNaN(tm.validAt.getTime())) // Filter out invalid dates
      .sort((a, b) => a.validAt.getTime() - b.validAt.getTime());

    debugLog('windowing', 'Starting window detection', {
      totalMemories: memories.length,
      config: this.config,
      timeRange: {
        start: timestampedMemories[0].validAt.toISOString(),
        end: timestampedMemories[timestampedMemories.length - 1].validAt.toISOString(),
      },
    });

    // Perform DBSCAN clustering on 1D time axis
    const clusters = this.dbscanClustering(timestampedMemories);

    // Convert clusters to windows
    const windows = this.clustersToWindows(clusters);

    // Extract unassigned (outlier) memories
    const unassigned = clusters
      .filter((c) => c.isNoise)
      .flatMap((c) => c.memories.map((tm) => tm.memory));

    const stats = {
      totalMemories: memories.length,
      windowCount: windows.length,
      avgWindowSize: windows.length > 0 ? memories.length / windows.length : 0,
      outlierCount: unassigned.length,
    };

    debugLog('windowing', 'Window detection complete', { stats, windows });

    return { windows, unassigned, stats };
  }

  /**
   * DBSCAN clustering on 1D time axis.
   * Groups memories that are within epsilonDays of each other.
   *
   * @param timestampedMemories Sorted memories with timestamps
   * @returns Clusters with their memories
   */
  private dbscanClustering(
    timestampedMemories: Array<{ memory: MemoryRecord; validAt: Date }>
  ): Array<{ memories: Array<{ memory: MemoryRecord; validAt: Date }>; isNoise: boolean }> {
    const clusters: Array<{
      memories: Array<{ memory: MemoryRecord; validAt: Date }>;
      isNoise: boolean;
    }> = [];
    const visited = new Set<number>();
    const epsilonMs = this.config.epsilonDays * 24 * 60 * 60 * 1000;

    for (let i = 0; i < timestampedMemories.length; i++) {
      if (visited.has(i)) continue;

      const neighbors = this.getNeighbors(timestampedMemories, i, epsilonMs);

      if (neighbors.length < this.config.minMemories) {
        // Mark as noise
        clusters.push({
          memories: [timestampedMemories[i]],
          isNoise: true,
        });
        visited.add(i);
      } else {
        // Start new cluster
        const cluster: Array<{ memory: MemoryRecord; validAt: Date }> = [];
        const queue: number[] = [i];

        while (queue.length > 0) {
          const idx = queue.shift()!;
          if (visited.has(idx)) continue;

          visited.add(idx);
          cluster.push(timestampedMemories[idx]);

          const pointNeighbors = this.getNeighbors(timestampedMemories, idx, epsilonMs);
          if (pointNeighbors.length >= this.config.minMemories) {
            queue.push(...pointNeighbors.filter((n) => !visited.has(n)));
          }
        }

        clusters.push({ memories: cluster, isNoise: false });
      }
    }

    return clusters;
  }

  /**
   * Get indices of memories within epsilon distance of the given index.
   *
   * @param timestampedMemories Sorted memories
   * @param index Index of target memory
   * @param epsilonMs Epsilon in milliseconds
   * @returns Indices of neighbors (including self)
   */
  private getNeighbors(
    timestampedMemories: Array<{ memory: MemoryRecord; validAt: Date }>,
    index: number,
    epsilonMs: number
  ): number[] {
    const target = timestampedMemories[index];
    const neighbors: number[] = [];

    for (let i = 0; i < timestampedMemories.length; i++) {
      const delta = Math.abs(timestampedMemories[i].validAt.getTime() - target.validAt.getTime());
      if (delta <= epsilonMs) {
        neighbors.push(i);
      }
    }

    return neighbors;
  }

  /**
   * Convert clusters to consolidation windows.
   *
   * @param clusters DBSCAN clusters
   * @returns Consolidation windows
   */
  private clustersToWindows(
    clusters: Array<{ memories: Array<{ memory: MemoryRecord; validAt: Date }>; isNoise: boolean }>
  ): ConsolidationWindow[] {
    const windows: ConsolidationWindow[] = [];

    for (const cluster of clusters) {
      if (cluster.isNoise || cluster.memories.length < this.config.minMemories) {
        continue;
      }

      const timestamps = cluster.memories.map((tm) => tm.validAt);
      const minDate = new Date(Math.min(...timestamps.map((d) => d.getTime())));
      const maxDate = new Date(Math.max(...timestamps.map((d) => d.getTime())));

      // Apply alignment if natural
      let startDate: Date;
      let endDate: Date;

      if (this.config.alignment === 'natural') {
        const aligned = this.alignToNaturalBoundaries(minDate, maxDate);
        startDate = aligned.start;
        endDate = aligned.end;
      } else {
        startDate = minDate;
        endDate = maxDate;
      }

      // Compute consolidation date as midpoint of window, then clamp to maxDate
      const midpoint = new Date((startDate.getTime() + endDate.getTime()) / 2);
      const consolidationDate = midpoint > maxDate ? maxDate : midpoint;

      // Generate focus label
      const focus = this.generateFocusLabel(startDate, endDate);

      windows.push({
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        consolidationDate: consolidationDate.toISOString(),
        focus,
        expectedSummaryCount: Math.ceil(cluster.memories.length / 5), // Heuristic: 1 summary per 5 memories
      });
    }

    return windows;
  }

  /**
   * Align dates to natural calendar boundaries (month or quarter).
   *
   * @param minDate Earliest date in cluster
   * @param maxDate Latest date in cluster
   * @returns Aligned start and end dates
   */
  private alignToNaturalBoundaries(minDate: Date, maxDate: Date): { start: Date; end: Date } {
    const spanDays = (maxDate.getTime() - minDate.getTime()) / (24 * 60 * 60 * 1000);

    if (spanDays > 60) {
      // Quarter alignment
      const startQuarter = Math.floor(minDate.getMonth() / 3);
      const start = new Date(minDate.getFullYear(), startQuarter * 3, 1);

      const endQuarter = Math.floor(maxDate.getMonth() / 3);
      const end = new Date(maxDate.getFullYear(), endQuarter * 3 + 3, 0, 23, 59, 59, 999);

      return { start, end };
    } else {
      // Month alignment
      const start = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
      const end = new Date(maxDate.getFullYear(), maxDate.getMonth() + 1, 0, 23, 59, 59, 999);

      return { start, end };
    }
  }

  /**
   * Generate a human-readable focus label for a window.
   *
   * @param startDate Window start
   * @param endDate Window end
   * @returns Focus label (e.g., "Q1 2025", "March 2025")
   */
  private generateFocusLabel(startDate: Date, endDate: Date): string {
    const spanDays = (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);
    const year = startDate.getFullYear();

    if (spanDays > 60) {
      // Quarter label
      const quarter = Math.floor(startDate.getMonth() / 3) + 1;
      return `Q${quarter} ${year}`;
    } else {
      // Month label
      const monthNames = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ];
      return `${monthNames[startDate.getMonth()]} ${year}`;
    }
  }
}
