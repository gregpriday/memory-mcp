-- =====================================================================
-- Migration: 20250120000000_add_temporal_consolidation
-- Description: Add bitemporal model for temporally coherent consolidation
-- =====================================================================
-- This migration adds temporal fields to support backdated memory
-- consolidation while maintaining temporal narrative coherence.
--
-- Key changes:
-- 1. Add valid_at, recorded_at, time_confidence to memories table
-- 2. Add temporal fields to memory_relationships table
-- 3. Add new temporal relationship types (leads_to, informs, consolidates, evolves_into)
-- 4. Backfill existing data with valid_at = created_at, recorded_at = created_at
-- 5. Add indexes for temporal queries
-- =====================================================================

-- =====================================================================
-- UP Migration
-- =====================================================================

-- Add temporal columns to memories table (without defaults first, to allow backfill)
ALTER TABLE memories
  ADD COLUMN valid_at TIMESTAMPTZ,
  ADD COLUMN recorded_at TIMESTAMPTZ,
  ADD COLUMN time_confidence REAL;

-- Add constraints for time_confidence
ALTER TABLE memories
  ADD CONSTRAINT memories_time_confidence_check CHECK (time_confidence IS NULL OR (time_confidence BETWEEN 0.0 AND 1.0));

-- Backfill temporal columns for existing memories
UPDATE memories
SET
  valid_at = created_at,
  recorded_at = created_at,
  time_confidence = 1.0
WHERE valid_at IS NULL;

-- Add defaults for future inserts
ALTER TABLE memories
  ALTER COLUMN valid_at SET DEFAULT now(),
  ALTER COLUMN recorded_at SET DEFAULT now(),
  ALTER COLUMN time_confidence SET DEFAULT 1.0;

-- Add BRIN index on valid_at for efficient temporal range queries
-- BRIN is optimal for time-series data with natural insertion order
CREATE INDEX idx_memories_valid_at ON memories USING BRIN (valid_at) WHERE valid_at IS NOT NULL;

-- Add composite index for common temporal + priority queries
CREATE INDEX idx_memories_valid_priority ON memories (valid_at DESC, current_priority DESC) WHERE valid_at IS NOT NULL;

COMMENT ON COLUMN memories.valid_at IS 'Narrative time: when this fact was "true" in-world (ISO 8601). Used for priority decay.';
COMMENT ON COLUMN memories.recorded_at IS 'System time: when we ingested/created this record (ISO 8601). Used for auditability.';
COMMENT ON COLUMN memories.time_confidence IS 'Confidence level for valid_at timestamp (0.0-1.0). 1.0 = exact, 0.5 = estimated, 0.0 = uncertain.';

-- Add temporal columns to memory_relationships table (without defaults first, to allow backfill)
ALTER TABLE memory_relationships
  ADD COLUMN valid_at TIMESTAMPTZ,
  ADD COLUMN recorded_at TIMESTAMPTZ,
  ADD COLUMN temporal_ok BOOLEAN,
  ADD COLUMN temporal_reason TEXT;

-- Backfill temporal columns for existing relationships
-- Use the max of source and target valid_at for relationship valid_at
UPDATE memory_relationships mr
SET
  valid_at = GREATEST(
    COALESCE((SELECT m.valid_at FROM memories m WHERE m.id = mr.source_id), mr.created_at),
    COALESCE((SELECT m.valid_at FROM memories m WHERE m.id = mr.target_id), mr.created_at)
  ),
  recorded_at = mr.created_at,
  temporal_ok = TRUE
WHERE mr.valid_at IS NULL;

-- Add defaults for future inserts
ALTER TABLE memory_relationships
  ALTER COLUMN valid_at SET DEFAULT now(),
  ALTER COLUMN recorded_at SET DEFAULT now(),
  ALTER COLUMN temporal_ok SET DEFAULT TRUE;

-- Add composite index for temporal relationship queries
CREATE INDEX idx_memory_relationships_valid_at ON memory_relationships (valid_at DESC) WHERE valid_at IS NOT NULL;

COMMENT ON COLUMN memory_relationships.valid_at IS 'Narrative time: when this relationship became true in-world (ISO 8601).';
COMMENT ON COLUMN memory_relationships.recorded_at IS 'System time: when we recorded this relationship (ISO 8601).';
COMMENT ON COLUMN memory_relationships.temporal_ok IS 'Whether temporal constraints were satisfied when creating this relationship.';
COMMENT ON COLUMN memory_relationships.temporal_reason IS 'Explanation of temporal validation outcome (warnings, clamping, etc.).';

-- Update relationship type constraint to include new temporal types
ALTER TABLE memory_relationships
  DROP CONSTRAINT memory_relationships_type_check;

ALTER TABLE memory_relationships
  ADD CONSTRAINT memory_relationships_type_check CHECK (relationship_type IN (
    'summarizes',
    'example_of',
    'is_generalization_of',
    'supports',
    'contradicts',
    'causes',
    'similar_to',
    'historical_version_of',
    'derived_from',
    'leads_to',
    'informs',
    'consolidates',
    'evolves_into'
  ));

-- =====================================================================
-- DOWN Migration (Rollback)
-- =====================================================================
-- Note: This is for reference only. Rollbacks should be tested carefully.

-- To rollback this migration, run:
/*
-- Drop indexes
DROP INDEX IF EXISTS idx_memories_valid_at;
DROP INDEX IF EXISTS idx_memories_valid_priority;
DROP INDEX IF EXISTS idx_memory_relationships_valid_at;

-- Remove temporal columns from memory_relationships
ALTER TABLE memory_relationships
  DROP COLUMN IF EXISTS valid_at,
  DROP COLUMN IF EXISTS recorded_at,
  DROP COLUMN IF EXISTS temporal_ok,
  DROP COLUMN IF EXISTS temporal_reason;

-- Restore old relationship type constraint
ALTER TABLE memory_relationships
  DROP CONSTRAINT memory_relationships_type_check;

ALTER TABLE memory_relationships
  ADD CONSTRAINT memory_relationships_type_check CHECK (relationship_type IN (
    'summarizes',
    'example_of',
    'is_generalization_of',
    'supports',
    'contradicts',
    'causes',
    'similar_to',
    'historical_version_of',
    'derived_from'
  ));

-- Remove temporal columns from memories
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS memories_time_confidence_check,
  DROP COLUMN IF EXISTS valid_at,
  DROP COLUMN IF EXISTS recorded_at,
  DROP COLUMN IF EXISTS time_confidence;
*/
