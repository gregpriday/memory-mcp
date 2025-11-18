import { MemoryType, MemoryRecord } from '../memory/types.js';
import { computeTypeDependentPriority } from '../memory/PriorityCalculator.js';

/**
 * Validation result from timestamp checks.
 */
export interface TimestampValidationResult {
  /** Whether the timestamp is valid and can be stored */
  valid: boolean;

  /** Error message if validation failed (timestamps are invalid) */
  error?: string;

  /** Warning if valid but unusual (e.g., old episodic memory) */
  warning?: string;

  /** Normalized ISO 8601 timestamp string */
  normalized?: string;
}

/**
 * Temporal consistency check result.
 */
export interface TemporalConsistencyResult {
  /** Whether all relationships are temporally consistent */
  consistent: boolean;

  /** List of issues found (empty if consistent) */
  issues: string[];
}

/**
 * TimestampValidator provides comprehensive validation for memory timestamps
 * to catch backdating mistakes and temporal inconsistencies.
 *
 * Checks include:
 * 1. Format validation (ISO 8601 with helpful error messages)
 * 2. Future date rejection (prevent timestamps in the future)
 * 3. Type/age warnings (alert if timestamp/type combo yields very low priority)
 * 4. Temporal consistency (check relationships don't link to "future" memories)
 */
export class TimestampValidator {
  /**
   * Validate a timestamp string with comprehensive checks.
   *
   * @param timestamp - ISO 8601 timestamp string to validate
   * @param memoryType - Optional memory type for priority estimation warnings
   * @param nowDate - Current date (defaults to now) for future date checking
   * @returns Validation result with error/warning/normalized fields
   */
  validate(
    timestamp: string,
    memoryType?: MemoryType,
    nowDate: Date = new Date()
  ): TimestampValidationResult {
    if (!timestamp || typeof timestamp !== 'string') {
      return {
        valid: false,
        error: 'Timestamp must be a non-empty string',
      };
    }

    // Step 1: Check ISO 8601 format
    const formatValidation = this.validateISOFormat(timestamp);
    if (!formatValidation.valid) {
      return formatValidation;
    }

    const normalized = formatValidation.normalized!;
    const parsed = new Date(normalized);

    // Step 2: Check not in future (reject future timestamps)
    if (parsed > nowDate) {
      const futureDate = parsed.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      const nowFormatted = nowDate.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      return {
        valid: false,
        error: `Timestamp is in the future (${futureDate}). Current date is ${nowFormatted}. Did you mean 2025?`,
      };
    }

    // Step 3: Check if type/age combination yields very low priority (warning only)
    const warning = memoryType
      ? this.checkLowPriorityWarning(normalized, memoryType, nowDate)
      : undefined;

    return {
      valid: true,
      normalized,
      warning,
    };
  }

  /**
   * Validate ISO 8601 format with helpful error messages.
   *
   * Accepts formats:
   * - YYYY-MM-DD (date only)
   * - YYYY-MM-DDTHH:mm:ss (datetime)
   * - YYYY-MM-DDTHH:mm:ssZ or lowercase z (datetime UTC)
   * - YYYY-MM-DDTHH:mm:ss.sss[sss]Z (datetime with milliseconds/microseconds)
   * - YYYY-MM-DDTHH:mm:ss±HH:mm or ±HHmm or ±HH (datetime with timezone)
   *
   * @param timestamp - Timestamp string to validate
   * @returns Validation result with normalized ISO string if valid
   */
  private validateISOFormat(timestamp: string): TimestampValidationResult {
    const trimmed = timestamp.trim();

    // More permissive ISO 8601 regex - accepts common variants
    // Matches date-only, datetime with various time zone formats, fractional seconds
    const isoRegex =
      /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;

    const match = isoRegex.exec(trimmed);
    if (!match) {
      return {
        valid: false,
        error: `Invalid timestamp format "${trimmed}". Use ISO 8601 format: 2025-02-04 or 2025-02-04T10:00:00Z`,
      };
    }

    // Extract components and validate ranges to prevent normalization
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);

    // Validate month range
    if (month < 1 || month > 12) {
      return {
        valid: false,
        error: `Invalid month ${month} in timestamp "${trimmed}". Month must be 01-12.`,
      };
    }

    // Validate day range for the given month/year
    const daysInMonth = new Date(year, month, 0).getDate();
    if (day < 1 || day > daysInMonth) {
      return {
        valid: false,
        error: `Invalid day ${day} for ${year}-${String(month).padStart(2, '0')} in timestamp "${trimmed}". Valid range is 01-${daysInMonth}.`,
      };
    }

    // Try to parse
    const parsed = new Date(trimmed);
    const parsedTime = parsed.getTime();
    if (!Number.isFinite(parsedTime)) {
      return {
        valid: false,
        error: `Invalid timestamp "${trimmed}". Unable to parse as a valid date.`,
      };
    }

    // Normalize to ISO string
    const normalized = parsed.toISOString();

    return {
      valid: true,
      normalized,
    };
  }

  /**
   * Check if timestamp/type combination yields very low priority and emit warning.
   *
   * Episodic memories degrade quickly with age. This warns developers
   * if they backdate a memory to a time that would result in very low priority (~<0.01).
   *
   * @param normalizedTimestamp - ISO 8601 timestamp (already validated)
   * @param memoryType - Memory type to check priority against
   * @param nowDate - Current date for age calculation
   * @returns Warning string if priority is very low, undefined otherwise
   */
  private checkLowPriorityWarning(
    normalizedTimestamp: string,
    memoryType: MemoryType,
    nowDate: Date
  ): string | undefined {
    try {
      // Estimate priority by creating a fake memory record
      const fakeMemory: MemoryRecord = {
        id: 'temp-id',
        content: {
          text: 'temp',
          timestamp: normalizedTimestamp,
        },
        metadata: {
          index: 'temp',
          memoryType,
          importance: 'medium', // Default to medium for warning estimation
          dynamics: {
            initialPriority: 0.5,
            currentPriority: 0.5,
            createdAt: normalizedTimestamp,
            accessCount: 0,
          },
        },
      };

      const estimatedPriority = computeTypeDependentPriority(fakeMemory, nowDate);

      // If estimated priority is very low (<0.01), warn the user
      if (estimatedPriority < 0.01) {
        const dateObj = new Date(normalizedTimestamp);
        const formattedDate = dateObj.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });

        const suggestion =
          memoryType === 'episodic'
            ? "Consider changing memoryType to 'pattern' or 'semantic' to preserve importance."
            : 'Consider checking the timestamp or importance level.';

        return `⚠️ ${memoryType} memory created on ${formattedDate} will have priority ~${estimatedPriority.toFixed(4)} (very low). ${suggestion}`;
      }

      return undefined;
    } catch {
      // If priority calculation fails, don't warn (non-blocking)
      return undefined;
    }
  }

  /**
   * Check temporal consistency between a timestamp and related memory timestamps.
   *
   * For relationships like "summarizes" or "derived_from", it's odd if the summary
   * has a later timestamp than its source. This method flags such inconsistencies.
   *
   * @param timestamp - ISO 8601 timestamp of the memory being added
   * @param relatedTimestamps - Array of { timestamp, targetId, relationshipType } for related memories
   * @returns Consistency check result with issues list
   */
  checkTemporalConsistency(
    timestamp: string,
    relatedTimestamps: Array<{
      timestamp: string;
      targetId?: string;
      relationshipType?: string;
    }>
  ): TemporalConsistencyResult {
    const issues: string[] = [];

    if (!relatedTimestamps || relatedTimestamps.length === 0) {
      return { consistent: true, issues };
    }

    try {
      const thisDate = new Date(timestamp).getTime();

      // Guard against NaN from invalid timestamp
      if (!Number.isFinite(thisDate)) {
        issues.push(`Unable to check temporal consistency: invalid timestamp format`);
        return { consistent: false, issues };
      }

      for (const related of relatedTimestamps) {
        if (!related.timestamp) continue;

        const relatedDate = new Date(related.timestamp).getTime();

        // Guard against NaN from invalid related timestamp
        if (!Number.isFinite(relatedDate)) {
          issues.push(`Unable to check temporal consistency: invalid timestamp format`);
          continue;
        }

        const relType = related.relationshipType || 'related';
        const targetId = related.targetId ? ` (${related.targetId})` : '';

        // Check for obvious temporal issues
        // If this memory is derived from another, this should not be earlier than the source
        if (
          (relType === 'derived_from' ||
            relType === 'is_generalization_of' ||
            relType === 'summarizes') &&
          thisDate < relatedDate
        ) {
          issues.push(
            `Memory is "${relType}" a later memory${targetId}. This creates a temporal paradox.`
          );
        }

        // If this memory supports or contradicts another, it should generally be from around the same time or earlier
        if (
          (relType === 'supports' || relType === 'contradicts') &&
          thisDate > relatedDate + 365 * 24 * 60 * 60 * 1000 // More than a year later
        ) {
          issues.push(
            `Memory "${relType}" memory${targetId} from more than a year ago. Is this the right relationship?`
          );
        }
      }
    } catch {
      // If parsing fails, report as an issue
      issues.push(`Unable to check temporal consistency: invalid timestamp format`);
    }

    return {
      consistent: issues.length === 0,
      issues,
    };
  }
}
