export interface RefinementConfig {
  defaultBudget: number;
  allowDelete: boolean;
  accessTrackingEnabled: boolean;
  accessTrackingTopN: number;
  accessPriorityBoost: number;
  queryExpansionEnabled: boolean;
  queryExpansionCount: number;
}

const boolFromEnv = (value: string | undefined, defaultValue: boolean) => {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  return value.trim().toLowerCase() === 'true';
};

export function loadRefinementConfig(): RefinementConfig {
  const defaultBudget = Math.max(0, Number(process.env.MEMORY_REFINE_DEFAULT_BUDGET ?? 100)) || 100;
  const allowDelete = boolFromEnv(process.env.MEMORY_REFINE_ALLOW_DELETE, false);
  const accessTrackingEnabled = boolFromEnv(process.env.MEMORY_ACCESS_TRACKING_ENABLED, true);
  const accessTrackingTopN =
    Math.max(1, Number(process.env.MEMORY_ACCESS_TRACKING_TOP_N ?? 3)) || 3;

  const boostEnv = process.env.MEMORY_ACCESS_PRIORITY_BOOST;
  const parsedBoost = boostEnv ? Number(boostEnv) : 0.01;
  const accessPriorityBoost = Math.max(
    0,
    Math.min(1, Number.isFinite(parsedBoost) ? parsedBoost : 0.01)
  );

  const queryExpansionEnabled = boolFromEnv(process.env.MEMORY_QUERY_EXPANSION_ENABLED, true);
  const queryExpansionCount = Math.max(
    1,
    Math.min(3, Number(process.env.MEMORY_QUERY_EXPANSION_COUNT ?? 2) || 2)
  );

  return {
    defaultBudget,
    allowDelete,
    accessTrackingEnabled,
    accessTrackingTopN,
    accessPriorityBoost,
    queryExpansionEnabled,
    queryExpansionCount,
  };
}
