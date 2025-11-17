import { IMemoryRepository } from '../memory/IMemoryRepository.js';
import { RefinementConfig } from '../config/refinement.js';
import {
  RefinementAction,
  UpdateRefinementAction,
  MergeRefinementAction,
  CreateRefinementAction,
  DeleteRefinementAction,
  MemoryMetadata,
} from '../memory/types.js';
import { MemorySearchError } from '../memory/MemorySearchError.js';
import { debugLog } from '../utils/logger.js';

/**
 * Result of validating a refinement action
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Context needed for validation
 */
export interface ValidationContext {
  indexName: string;
  repository: IMemoryRepository;
  config: RefinementConfig;
}

/**
 * Base interface for action validators
 */
export interface ActionValidator {
  validate(action: RefinementAction, context: ValidationContext): Promise<ValidationResult>;
}

/**
 * Helper function to check if a memory ID is a system memory
 * System memories have special protection and should not be modified by refinement
 */
function isSystemMemory(id: string): boolean {
  return id.startsWith('sys_');
}

/**
 * Helper function to check if a memory is marked as system in metadata
 */
function isSystemMemoryByMetadata(metadata?: MemoryMetadata): boolean {
  return metadata?.source === 'system';
}

/**
 * Validator for UPDATE actions
 */
export class UpdateActionValidator implements ActionValidator {
  async validate(action: RefinementAction, context: ValidationContext): Promise<ValidationResult> {
    const errors: string[] = [];

    if (action.type !== 'UPDATE') {
      errors.push(`Expected UPDATE action, got ${action.type}`);
      return { valid: false, errors };
    }

    const updateAction = action as UpdateRefinementAction;

    // Check required fields
    if (!updateAction.id) {
      errors.push('UPDATE action missing required field: id');
    }

    if (!updateAction.textUpdate && !updateAction.metadataUpdates) {
      errors.push('UPDATE action must have either textUpdate or metadataUpdates');
    }

    // Check for system memory protection
    if (updateAction.id) {
      if (isSystemMemory(updateAction.id)) {
        errors.push(`Cannot UPDATE system memory ${updateAction.id} (protected)`);
      }
    }

    // Verify ID exists in repository
    if (updateAction.id && errors.length === 0) {
      debugLog('validation', 'UPDATE: Fetching memory', {
        id: updateAction.id,
        index: context.indexName,
      });

      const memory = await context.repository.getMemory(context.indexName, updateAction.id);

      debugLog('validation', 'UPDATE: Fetch result', {
        id: updateAction.id,
        found: Boolean(memory),
        isSystem: memory ? isSystemMemoryByMetadata(memory.metadata) : false,
      });

      if (!memory) {
        errors.push(`Memory ${updateAction.id} not found in index ${context.indexName}`);
      } else if (isSystemMemoryByMetadata(memory.metadata)) {
        errors.push(`Cannot UPDATE system memory ${updateAction.id} (marked as system)`);
      }
    }

    // Validate metadata updates if present
    if (updateAction.metadataUpdates) {
      const forbidden = ['id', 'index'];
      const forbiddenFields = Object.keys(updateAction.metadataUpdates).filter((key) =>
        forbidden.includes(key)
      );
      if (forbiddenFields.length > 0) {
        errors.push(
          `UPDATE action contains forbidden metadata fields: ${forbiddenFields.join(', ')}`
        );
      }

      // Validate priority if present (using a generic metadata field approach)
      const priority = (updateAction.metadataUpdates as any).priority;
      if (priority !== undefined) {
        if (typeof priority !== 'number' || priority < 0 || priority > 1) {
          errors.push('Metadata field "priority" must be a number between 0 and 1');
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

/**
 * Validator for MERGE actions
 */
export class MergeActionValidator implements ActionValidator {
  async validate(action: RefinementAction, context: ValidationContext): Promise<ValidationResult> {
    const errors: string[] = [];

    if (action.type !== 'MERGE') {
      errors.push(`Expected MERGE action, got ${action.type}`);
      return { valid: false, errors };
    }

    const mergeAction = action as MergeRefinementAction;

    // Check required fields
    if (!mergeAction.targetId) {
      errors.push('MERGE action missing required field: targetId');
    }

    if (!mergeAction.mergeSourceIds || mergeAction.mergeSourceIds.length === 0) {
      errors.push('MERGE action missing required field: mergeSourceIds');
      return { valid: false, errors };
    }

    // Check for self-merge
    if (mergeAction.targetId && mergeAction.mergeSourceIds.includes(mergeAction.targetId)) {
      errors.push(`MERGE action cannot include targetId ${mergeAction.targetId} in mergeSourceIds`);
    }

    // Check for duplicate source IDs
    const uniqueSourceIds = new Set(mergeAction.mergeSourceIds);
    if (uniqueSourceIds.size !== mergeAction.mergeSourceIds.length) {
      errors.push('MERGE action contains duplicate IDs in mergeSourceIds');
    }

    // Ensure at least two distinct records would be merged
    if (uniqueSourceIds.size < 1) {
      errors.push('MERGE action must have at least one source ID besides the target');
    }

    // Check for system memory protection on target
    if (mergeAction.targetId) {
      if (isSystemMemory(mergeAction.targetId)) {
        errors.push(`Cannot use system memory ${mergeAction.targetId} as MERGE target (protected)`);
      }
    }

    // Only verify IDs exist if we have valid required fields
    if (mergeAction.targetId && mergeAction.mergeSourceIds.length > 0 && errors.length === 0) {
      const allIds = [mergeAction.targetId, ...mergeAction.mergeSourceIds];

      debugLog(
        'validation',
        `MERGE: Fetching ${allIds.length} memories from index ${context.indexName}`,
        {
          targetId: mergeAction.targetId,
          sourceCount: mergeAction.mergeSourceIds.length,
          sourceIds: mergeAction.mergeSourceIds,
        }
      );

      const memories = await context.repository.getMemories(context.indexName, allIds);

      debugLog('validation', 'MERGE: Fetch result', {
        requested: allIds.length,
        found: memories.length,
        foundIds: memories.map((m) => m.id),
      });

      const foundIds = new Set(memories.map((m) => m.id));
      const missingIds = allIds.filter((id) => !foundIds.has(id));

      if (missingIds.length > 0) {
        errors.push(
          `MERGE action references non-existent IDs in index ${context.indexName}: ${missingIds.join(', ')}`
        );
      }

      // Check for system memories in source IDs
      const systemSourceIds = mergeAction.mergeSourceIds.filter((id) => isSystemMemory(id));
      if (systemSourceIds.length > 0) {
        errors.push(`Cannot MERGE system memories ${systemSourceIds.join(', ')} (protected)`);
      }

      // Also check metadata source field
      const systemByMetadata = memories.filter((m) => isSystemMemoryByMetadata(m.metadata));
      if (systemByMetadata.length > 0) {
        const systemIds = systemByMetadata.map((m) => m.id);
        errors.push(`Cannot MERGE system memories ${systemIds.join(', ')} (marked as system)`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

/**
 * Validator for CREATE actions
 */
export class CreateActionValidator implements ActionValidator {
  async validate(action: RefinementAction, context: ValidationContext): Promise<ValidationResult> {
    const errors: string[] = [];

    if (action.type !== 'CREATE') {
      errors.push(`Expected CREATE action, got ${action.type}`);
      return { valid: false, errors };
    }

    const createAction = action as CreateRefinementAction;

    // Check required fields
    if (!createAction.newMemory) {
      errors.push('CREATE action missing required field: newMemory');
      return { valid: false, errors };
    }

    if (!createAction.newMemory.text || createAction.newMemory.text.trim() === '') {
      errors.push('CREATE action newMemory.text must be non-empty');
    }

    // Validate derivedFromIds if present in metadata
    const derivedFromIds = createAction.newMemory.metadata?.derivedFromIds;
    if (derivedFromIds && Array.isArray(derivedFromIds) && derivedFromIds.length > 0) {
      debugLog(
        'validation',
        `CREATE: Fetching ${derivedFromIds.length} derivedFrom memories from index ${context.indexName}`,
        {
          derivedFromIds,
        }
      );

      const memories = await context.repository.getMemories(context.indexName, derivedFromIds);

      debugLog('validation', 'CREATE: Fetch result', {
        requested: derivedFromIds.length,
        found: memories.length,
        foundIds: memories.map((m) => m.id),
      });

      const foundIds = new Set(memories.map((m) => m.id));
      const missingIds = derivedFromIds.filter((id: string) => !foundIds.has(id));

      if (missingIds.length > 0) {
        errors.push(
          `CREATE action derivedFromIds references non-existent IDs in index ${context.indexName}: ${missingIds.join(', ')}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

/**
 * Validator for DELETE actions
 */
export class DeleteActionValidator implements ActionValidator {
  async validate(action: RefinementAction, context: ValidationContext): Promise<ValidationResult> {
    const errors: string[] = [];

    if (action.type !== 'DELETE') {
      errors.push(`Expected DELETE action, got ${action.type}`);
      return { valid: false, errors };
    }

    const deleteAction = action as DeleteRefinementAction;

    // Check if deletion is allowed by config
    if (!context.config.allowDelete) {
      errors.push('DELETE action not allowed: allowDelete is false in configuration');
      return { valid: false, errors };
    }

    // Check required fields
    if (!deleteAction.deleteIds || deleteAction.deleteIds.length === 0) {
      errors.push('DELETE action missing required field: deleteIds');
      return { valid: false, errors };
    }

    // Verify IDs exist and check for system memories
    debugLog(
      'validation',
      `DELETE: Fetching ${deleteAction.deleteIds.length} memories from index ${context.indexName}`,
      {
        deleteIds: deleteAction.deleteIds,
      }
    );

    const memories = await context.repository.getMemories(
      context.indexName,
      deleteAction.deleteIds
    );

    debugLog('validation', 'DELETE: Fetch result', {
      requested: deleteAction.deleteIds.length,
      found: memories.length,
      foundIds: memories.map((m) => m.id),
    });

    const foundIds = new Set(memories.map((m) => m.id));
    const missingIds = deleteAction.deleteIds.filter((id: string) => !foundIds.has(id));

    if (missingIds.length > 0) {
      errors.push(
        `DELETE action references non-existent IDs in index ${context.indexName}: ${missingIds.join(', ')}`
      );
    }

    // Check for system memories
    const systemMemories = memories.filter(
      (m) => m.id.startsWith('sys_') || m.metadata?.source === 'system'
    );

    if (systemMemories.length > 0) {
      const systemIds = systemMemories.map((m) => m.id);
      errors.push(`DELETE action cannot delete system memories: ${systemIds.join(', ')}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

/**
 * Create the appropriate validator for an action type
 */
export function createActionValidator(actionType: RefinementAction['type']): ActionValidator {
  switch (actionType) {
    case 'UPDATE':
      return new UpdateActionValidator();
    case 'MERGE':
      return new MergeActionValidator();
    case 'CREATE':
      return new CreateActionValidator();
    case 'DELETE':
      return new DeleteActionValidator();
    default:
      throw new Error(`Unknown action type: ${actionType}`);
  }
}

/**
 * Validate a refinement action
 */
export async function validateAction(
  action: RefinementAction,
  context: ValidationContext
): Promise<ValidationResult> {
  debugLog('validation', `Validating ${action.type} action`, {
    actionType: action.type,
    index: context.indexName,
  });

  try {
    const validator = createActionValidator(action.type);
    const result = await validator.validate(action, context);

    // Deduplicate error messages
    const uniqueErrors = Array.from(new Set(result.errors));

    debugLog('validation', `Validation ${result.valid ? 'PASSED' : 'FAILED'}`, {
      actionType: action.type,
      valid: result.valid,
      errorCount: uniqueErrors.length,
      errors: uniqueErrors,
    });

    return {
      valid: result.valid,
      errors: uniqueErrors,
    };
  } catch (error) {
    debugLog('validation', 'Validation EXCEPTION', {
      actionType: action.type,
      error: (error as Error).message,
      isMemorySearchError: error instanceof MemorySearchError,
    });

    // Treat MemorySearchError as a soft validation failure with detailed diagnostics
    if (error instanceof MemorySearchError) {
      const errorMessage = error.diagnostics.status
        ? `${error.message} (status: ${error.diagnostics.status})`
        : error.message;

      return {
        valid: false,
        errors: [errorMessage],
      };
    }

    // Generic validation error for unexpected exceptions
    return {
      valid: false,
      errors: [`Validation error: ${(error as Error).message}`],
    };
  }
}
