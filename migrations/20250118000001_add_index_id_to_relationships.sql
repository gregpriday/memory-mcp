-- Migration: Add index_id to memory_relationships for cross-index isolation
-- Purpose: Prevent relationship leakage across indexes in the same project
-- Date: 2025-01-18

-- Add index_id column (nullable initially for backfill)
ALTER TABLE memory_relationships
  ADD COLUMN index_id UUID REFERENCES memory_indexes(id) ON DELETE CASCADE;

-- Backfill index_id from source memory
UPDATE memory_relationships mr
SET index_id = m.index_id
FROM memories m
WHERE mr.source_id = m.id;

-- Make index_id NOT NULL after backfill
ALTER TABLE memory_relationships
  ALTER COLUMN index_id SET NOT NULL;

-- Add index for performance
CREATE INDEX idx_memory_relationships_index ON memory_relationships(index_id);

-- Update unique constraint to include index_id (drop old, create new)
ALTER TABLE memory_relationships
  DROP CONSTRAINT memory_relationships_source_id_target_id_relationship_type_key;

ALTER TABLE memory_relationships
  ADD CONSTRAINT memory_relationships_source_target_type_index_unique
  UNIQUE (source_id, target_id, relationship_type, index_id);

COMMENT ON COLUMN memory_relationships.index_id IS 'Index UUID for relationship scoping (prevents cross-index leakage)';
