/**
 * Priority Calculator - Memory Lifecycle Management
 *
 * Implements a simulated human memory system where priority determines retrieval likelihood
 * and eventual forgetting. The system combines multiple factors:
 *
 * **Core Factors:**
 * - **Recency**: How recently was the memory created or accessed? (exponential decay with 30-day half-life)
 * - **Importance**: How important is this memory? (high=1.0, medium=0.6, low=0.3)
 * - **Usage**: How frequently has this memory been accessed? (logarithmic saturation to prevent runaway growth)
 * - **Emotion**: Emotional intensity of the memory (0.0-1.0 from metadata)
 *
 * **Type-Specific Weighting:**
 * Different memory types decay at different rates, mimicking human psychology:
 * - **Self/Belief**: Identity persists (importance: 40%, usage: 30%, emotion: 20%, recency: 10%)
 * - **Semantic**: Facts persist if important (importance: 50%, usage: 20%, emotion: 20%, recency: 10%)
 * - **Pattern**: Learned patterns decay slowly (importance: 30%, usage: 30%, recency: 25%, emotion: 15%)
 * - **Episodic**: Raw experiences fade quickly (recency: 40%, importance: 20%, usage: 20%, emotion: 20%)
 *
 * **Canonical Beliefs:**
 * Beliefs marked as `stability='canonical'` have a floor of 0.4 priority, ensuring core
 * identity convictions remain retrievable even if very old and rarely accessed.
 *
 * **Priority Range:**
 * All priorities are clamped to [0.0, 1.0], where:
 * - 1.0: Maximum priority (recently created, highly important, frequently accessed)
 * - 0.0: Minimum priority (old, unimportant, never accessed)
 *
 * @remarks
 * Priority is recalculated on access via `updateAccessStats()` in the repository layer.
 * Lower priority memories may be candidates for archival or deletion during refinement.
 *
 * @public
 */
import { MemoryRecord, MemoryDynamics, Importance, MemoryType, EmotionInfo } from './types.js';

/**
 * Calculate recency score using exponential decay with 30-day half-life.
 *
 * Recency measures how "fresh" a memory is. Uses the most recent of:
 * - Last access time (if the memory has been recalled before)
 * - Creation time (for memories never accessed)
 *
 * The exponential decay formula ensures natural forgetting over time:
 * - 0 days old: score ≈ 1.0 (100% fresh)
 * - 30 days old: score = 0.5 (50% fresh - half-life)
 * - 60 days old: score = 0.25 (25% fresh)
 * - 90 days old: score = 0.125 (12.5% fresh)
 *
 * @param memory Memory record to score (uses lastAccessedAt or creation timestamp)
 * @param now Current date/time for age calculation
 * @returns Recency score in [0, 1], where 1.0 is brand new and 0.0 is infinitely old
 *
 * @remarks
 * Formula: 2^(-ageDays / 30)
 * - The 30-day half-life mimics short-term to medium-term memory decay
 * - Guards against invalid timestamps by returning 0
 *
 * @example
 * ```typescript
 * const now = new Date();
 * const memory = {
 *   content: { timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
 *   metadata: {}
 * };
 * const score = getRecencyScore(memory, now);
 * // Returns: ~0.5 (30 days old = half-life)
 * ```
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

  // Calculate age in days (max with 0 prevents negative ages from clock skew)
  const ageDays = Math.max(0, (nowMs - referenceMs) / (1000 * 60 * 60 * 24));

  // Exponential decay: 2^(-ageDays / 30)
  // Using natural log for numerical stability: e^(-ln(2) * ageDays / 30)
  const decay = Math.exp((-Math.log(2) * ageDays) / 30);

  // Clamp to [0, 1] to handle edge cases
  return Math.min(1, Math.max(0, decay));
}

/**
 * Calculate usage score using logarithmic saturation.
 *
 * Usage measures how frequently a memory has been accessed. Uses logarithmic
 * scaling to prevent runaway priority from repeated access while still rewarding
 * frequently used memories.
 *
 * The logarithmic formula ensures:
 * - 0 accesses: score = 0.0 (never used)
 * - 10 accesses: score ≈ 0.52 (moderately used)
 * - 50 accesses: score ≈ 0.85 (frequently used)
 * - 100 accesses: score = 1.0 (heavily used - saturation point)
 * - 1000+ accesses: score ≈ 1.0 (saturated, no further benefit)
 *
 * @param memory Memory record with access count in metadata.dynamics
 * @returns Usage score in [0, 1], where 0.0 is never accessed and 1.0 is heavily used
 *
 * @remarks
 * Formula: log(1 + accessCount) / log(101)
 * - The +1 ensures 0 accesses maps to 0 score (log(1) = 0)
 * - The log(101) denominator normalizes 100 accesses to score of 1.0
 * - Logarithmic scaling prevents "hot" memories from dominating indefinitely
 * - Guards against invalid values (NaN, Infinity, negative) by returning 0
 *
 * @example
 * ```typescript
 * const memory = {
 *   metadata: {
 *     dynamics: { accessCount: 50, lastAccessedAt: '2025-01-15T10:00:00Z' }
 *   }
 * };
 * const score = getUsageScore(memory);
 * // Returns: ~0.85 (50 accesses → 85% of saturation)
 *
 * // Saturation example
 * const hotMemory = { metadata: { dynamics: { accessCount: 1000 } } };
 * const hotScore = getUsageScore(hotMemory);
 * // Returns: ~1.0 (saturated at 100+ accesses)
 * ```
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
  // This normalizes access counts, with 100 accesses reaching score of 1.0
  // The +1 ensures that 0 accesses maps to 0 score
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
 * This is the main priority calculation function that combines recency, importance,
 * usage, and emotion using weights that vary by memory type. The result determines
 * retrieval likelihood and eligibility for forgetting.
 *
 * **Memory Type Formulas:**
 * - **Self/Belief**: `0.1*recency + 0.4*importance + 0.3*usage + 0.2*emotion`
 *   - Identity persists; importance-driven, barely decays with time
 * - **Semantic**: `0.1*recency + 0.5*importance + 0.2*usage + 0.2*emotion`
 *   - Facts persist if important; general knowledge decay is slow
 * - **Pattern**: `0.25*recency + 0.3*importance + 0.3*usage + 0.15*emotion`
 *   - Learned patterns decay slower; usage and importance co-drive priority
 * - **Episodic**: `0.4*recency + 0.2*importance + 0.2*usage + 0.2*emotion`
 *   - Raw experiences fade quickly; recency is primary factor
 *
 * **Special Cases:**
 * - Canonical beliefs (`stability='canonical'`) have a floor of 0.4 priority,
 *   ensuring core identity convictions remain retrievable regardless of age
 *
 * @param memory Memory record with type and dynamics metadata
 * @param now Current date/time for recency calculation
 * @returns Final priority score in [0.0, 1.0], where 1.0 is maximum priority
 *
 * @remarks
 * - All component scores (recency, usage, importance, emotion) are in [0, 1]
 * - Weighted sum is clamped to [0, 1] to handle edge cases
 * - Priority is deterministic given the same inputs and timestamp
 *
 * @example
 * ```typescript
 * const now = new Date('2025-01-15T12:00:00Z');
 *
 * // Episodic memory (recent experience, medium importance)
 * const episode: MemoryRecord = {
 *   id: 'mem-1',
 *   content: { text: 'Met John at cafe', timestamp: '2025-01-14T10:00:00Z' },
 *   metadata: {
 *     memoryType: 'episodic',
 *     importance: 'medium',
 *     dynamics: { accessCount: 2, lastAccessedAt: '2025-01-15T10:00:00Z' }
 *   }
 * };
 * const priority = computeTypeDependentPriority(episode, now);
 * // High recency (1 day old), medium importance (0.6), low usage (0.13)
 * // Formula: 0.4*0.977 + 0.2*0.6 + 0.2*0.13 + 0.2*0 ≈ 0.54
 *
 * // Canonical belief (old but core identity)
 * const belief: MemoryRecord = {
 *   id: 'mem-2',
 *   content: { text: 'I value honesty', timestamp: '2024-01-01T00:00:00Z' },
 *   metadata: {
 *     memoryType: 'belief',
 *     importance: 'high',
 *     dynamics: { accessCount: 0, stability: 'canonical' }
 *   }
 * };
 * const beliefPriority = computeTypeDependentPriority(belief, now);
 * // Low recency (1 year old ≈ 0.03), high importance (1.0), no usage (0)
 * // Formula: 0.1*0.03 + 0.4*1.0 + 0.3*0 + 0.2*0 ≈ 0.403
 * // Floor applied: max(0.403, 0.4) = 0.403 (just above canonical floor)
 * ```
 *
 * @public
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
