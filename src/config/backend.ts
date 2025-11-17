import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export interface ProjectDatabaseConfig {
  databaseUrl: string;
}

export type ProjectRegistry = Record<string, ProjectDatabaseConfig>;

export interface ActiveProjectConfig {
  projectId: string;
  databaseUrl: string;
}

export interface BackendConfig {
  activeProject: ActiveProjectConfig;
  projectRegistry: ProjectRegistry;
}

function loadProjectRegistry(): ProjectRegistry {
  const registryPath = process.env.MEMORY_POSTGRES_PROJECT_REGISTRY?.trim();

  if (!registryPath) {
    throw new Error(
      'MEMORY_POSTGRES_PROJECT_REGISTRY is required. Point it at a JSON file that maps project ids to { "databaseUrl": "postgresql://..." }.'
    );
  }

  const absolutePath = resolve(registryPath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Project registry not found at ${absolutePath}`);
  }

  const content = readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(content);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'Project registry must be an object of { projectId: { databaseUrl } } entries.'
    );
  }

  const registry: ProjectRegistry = {};

  for (const [projectId, config] of Object.entries(parsed)) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(
        `Invalid configuration for project ${projectId}. Expected object with databaseUrl.`
      );
    }

    const databaseUrl = (config as ProjectDatabaseConfig).databaseUrl;
    if (!databaseUrl || typeof databaseUrl !== 'string') {
      throw new Error(`Project ${projectId} is missing a valid databaseUrl.`);
    }

    registry[projectId] = { databaseUrl };
  }

  return registry;
}

function resolveActiveProject(registry: ProjectRegistry): ActiveProjectConfig {
  const projectId = process.env.MEMORY_ACTIVE_PROJECT?.trim() || 'default';
  const config = registry[projectId];

  if (!config) {
    const projects = Object.keys(registry);
    throw new Error(
      `Project "${projectId}" not found in registry (${projects.join(', ') || 'no projects defined'}). Update MEMORY_ACTIVE_PROJECT or the registry file.`
    );
  }

  return { projectId, databaseUrl: config.databaseUrl };
}

export function loadBackendConfig(): BackendConfig {
  const projectRegistry = loadProjectRegistry();
  const activeProject = resolveActiveProject(projectRegistry);

  return {
    projectRegistry,
    activeProject,
  };
}
