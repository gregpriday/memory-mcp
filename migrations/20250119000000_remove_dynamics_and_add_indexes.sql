-- =====================================================================
-- Migration: 20250119000000_remove_dynamics_and_add_indexes
-- Description: Remove metadata.dynamics drift and add performance indexes
-- =====================================================================
-- This migration eliminates the dual-write of lifecycle fields by removing
-- the dynamics object from JSONB metadata (lifecycle data remains in
-- denormalized columns). It also adds composite indexes for common query
-- patterns: priority+type+topic filtering, relationship traversal, and
-- JSONB metadata queries.
-- =====================================================================

-- =====================================================================
-- UP Migration
-- =====================================================================

-- =====================================================================
-- Step 1: Remove metadata.dynamics to eliminate sync drift
-- This data is already stored in denormalized columns and will be
-- hydrated at read time by the application layer
-- =====================================================================

-- Remove the 'dynamics' key from all existing memory metadata
-- This prevents drift between denormalized columns and JSONB storage
UPDATE memories
SET metadata = metadata - 'dynamics'
WHERE metadata ? 'dynamics';

COMMENT ON COLUMN memories.metadata IS 'Extended metadata (excludes lifecycle dynamics which are stored in denormalized columns)';

-- =====================================================================
-- Step 2: Add composite indexes for query performance
-- =====================================================================

-- Composite index for recall operations filtering by type, topic, and priority
-- Supports queries like: WHERE index_id = X AND memory_type = Y AND topic = Z ORDER BY current_priority DESC
CREATE INDEX idx_memories_type_topic_priority
  ON memories(index_id, memory_type, topic, current_priority DESC);

-- Composite indexes for relationship traversal with type filtering
-- Supports forward traversal: WHERE source_id = X AND relationship_type = Y
CREATE INDEX idx_memory_relationships_source_type
  ON memory_relationships(source_id, relationship_type);

-- Supports backward traversal: WHERE target_id = X AND relationship_type = Y
CREATE INDEX idx_memory_relationships_target_type
  ON memory_relationships(target_id, relationship_type);

-- GIN index for custom JSONB metadata queries
-- Supports queries like: WHERE metadata @> '{"customField": "value"}'
-- Uses jsonb_path_ops for smaller index size and faster containment queries
CREATE INDEX idx_memories_metadata_gin
  ON memories USING GIN (metadata jsonb_path_ops);

-- =====================================================================
-- Comments for new indexes
-- =====================================================================

COMMENT ON INDEX idx_memories_type_topic_priority IS 'Composite index for recall operations with type, topic, and priority filters';
COMMENT ON INDEX idx_memory_relationships_source_type IS 'Composite index for forward relationship traversal with type filtering';
COMMENT ON INDEX idx_memory_relationships_target_type IS 'Composite index for backward relationship traversal with type filtering';
COMMENT ON INDEX idx_memories_metadata_gin IS 'GIN index for custom JSONB metadata queries using path ops';

-- =====================================================================
-- DOWN Migration (Rollback)
-- =====================================================================

-- DROP INDEX IF EXISTS idx_memories_metadata_gin;
-- DROP INDEX IF EXISTS idx_memory_relationships_target_type;
-- DROP INDEX IF EXISTS idx_memory_relationships_source_type;
-- DROP INDEX IF EXISTS idx_memories_type_topic_priority;

-- Note: Uncomment the above lines to enable rollback
-- For safety, rollback is commented out by default
-- Dynamics data cannot be restored (it was redundant with denormalized columns)
