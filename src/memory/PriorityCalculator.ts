import { MemoryRecord, MemoryDynamics, Importance, MemoryType, EmotionInfo } from './types.js';

/**
 * Calculate recency score using exponential decay with 30-day half-life.
 * Fresh memories (created today) score near 1.0, while very old memories
 * approach 0 exponentially.
 *
 * @param memory Memory record to score
 * @param now Current date/time
 * @returns Recency score in [0, 1]
 */
export function getRecencyScore(
  memory:
    | MemoryRecord
    | { content: { timestamp: string }; metadata?: { dynamics?: MemoryDynamics } },
  now: Date
): number {
  const dynamics = (memory as any).metadata?.dynamics;
  const nowMs = now.getTime();

  // Try lastAccessedAt first, fall back to content.timestamp if invalid
  let referenceMs: number;
  if (dynamics?.lastAccessedAt) {
    referenceMs = new Date(dynamics.lastAccessedAt).getTime();
    if (!Number.isFinite(referenceMs)) {
      // lastAccessedAt is invalid, fall back to content.timestamp
      referenceMs = new Date(memory.content.timestamp).getTime();
    }
  } else {
    referenceMs = new Date(memory.content.timestamp).getTime();
  }

  // Guard against invalid timestamps
  if (!Number.isFinite(referenceMs) || !Number.isFinite(nowMs)) {
    return 0;
  }

  // Exponential decay with 30-day half-life: 2^(-ageDays / 30)
  // This ensures that a 30-day-old memory has exactly 50% recency score
  const ageDays = Math.max(0, (nowMs - referenceMs) / (1000 * 60 * 60 * 24));
  const decay = Math.exp((-Math.log(2) * ageDays) / 30);
  return Math.min(1, Math.max(0, decay));
}

/**
 * Calculate usage score using logarithmic saturation.
 * Prevents runaway priority from repeated access by using log scale.
 * New memories (0 accesses) score 0, while frequently accessed memories
 * asymptotically approach 1.0.
 *
 * @param memory Memory record with access count
 * @returns Usage score in [0, 1]
 */
export function getUsageScore(
  memory: MemoryRecord | { metadata?: { dynamics?: MemoryDynamics } }
): number {
  const dynamics = (memory as any).metadata?.dynamics;
  const rawAccessCount = dynamics?.accessCount;

  // Validate accessCount: ensure it's a finite non-negative number
  // Guard against NaN, Infinity, negative values, and non-numeric types
  const accessCount =
    typeof rawAccessCount === 'number' && Number.isFinite(rawAccessCount)
      ? Math.max(0, rawAccessCount)
      : 0;

  // Logarithmic saturation: log(1 + accessCount) / log(101)
  // This normalizes access counts, capping influence at ~100 accesses
  const score = Math.log(1 + accessCount) / Math.log(101);
  // Clamp to [0, 1] to ensure valid range
  return Math.max(0, Math.min(1, score));
}

/**
 * Calculate importance score from metadata importance level.
 *
 * @param importance Importance level ('high', 'medium', 'low', or undefined)
 * @returns Importance score in [0, 1]
 */
export function getImportanceScore(importance?: Importance): number {
  return importance === 'high' ? 1.0 : importance === 'medium' ? 0.6 : 0.3; // low or undefined defaults to 0.3
}

/**
 * Calculate emotion score from emotion intensity metadata.
 *
 * @param emotion Emotion info with optional intensity
 * @returns Emotion score in [0, 1]
 */
export function getEmotionScore(emotion?: EmotionInfo): number {
  if (!emotion?.intensity) {
    return 0.0;
  }

  // Clamp intensity to [0, 1] in case upstream exceeds bounds
  return Math.max(0, Math.min(1, emotion.intensity));
}

/**
 * Compute type-dependent priority using memory type-specific formulas.
 *
 * Different memory types decay at different rates:
 * - Self/Belief: Identity persists despite time; importance-driven
 * - Pattern: Patterns decay slower; usage-sensitive
 * - Episodic: Raw experiences fade faster; recency-sensitive
 * - Semantic: Facts persist if important; general knowledge
 *
 * Canonical beliefs (stability='canonical') maintain a minimum 0.4 priority
 * to ensure core identity always remains retrievable.
 *
 * @param memory Memory record with type and dynamics
 * @param now Current date/time for recency calculation
 * @returns Final priority score in [0.0, 1.0]
 */
export function computeTypeDependentPriority(memory: MemoryRecord, now: Date): number {
  const recency = getRecencyScore(memory, now);
  const usage = getUsageScore(memory);
  const importance = getImportanceScore(memory.metadata?.importance);
  const emotion = getEmotionScore(memory.metadata?.emotion);

  const memoryType = memory.metadata?.memoryType ?? 'semantic';
  let priority: number;

  switch (memoryType) {
    case 'self':
    case 'belief':
      // Identity memories barely decay, weighted by importance (40%)
      // Usage (30%) and emotion (20%) provide secondary influence
      // Recency (10%) has minimal impact for core beliefs
      priority = 0.1 * recency + 0.4 * importance + 0.3 * usage + 0.2 * emotion;

      // Floor: canonical beliefs never drop below 0.4, ensuring core convictions
      // always remain retrievable even if very old and rarely accessed
      if (memory.metadata?.dynamics?.stability === 'canonical') {
        priority = Math.max(priority, 0.4);
      }
      break;

    case 'pattern':
      // Patterns decay slower than episodes but faster than beliefs
      // Usage (30%) and importance (30%) are co-primary drivers
      // Recency (25%) reflects that patterns evolve
      // Emotion (15%) adds context sensitivity
      priority = 0.25 * recency + 0.3 * importance + 0.3 * usage + 0.15 * emotion;
      break;

    case 'episodic':
      // Episodes decay fastest; recency is primary factor (40%)
      // Importance (20%), usage (20%), emotion (20%) are secondary
      // Raw experiences fade naturally unless particularly important or used
      priority = 0.4 * recency + 0.2 * importance + 0.2 * usage + 0.2 * emotion;
      break;

    case 'semantic':
    default:
      // Facts decay very slowly, importance-driven (50%)
      // Semantic knowledge persists regardless of recent access
      // Usage (20%), recency (10%), emotion (20%)
      priority = 0.1 * recency + 0.5 * importance + 0.2 * usage + 0.2 * emotion;
      break;
  }

  // Clamp to [0.0, 1.0] to ensure valid priority range
  return Math.max(0, Math.min(1, priority));
}
