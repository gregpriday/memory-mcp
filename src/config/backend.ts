export interface BackendConfig {
  databaseUrl: string;
  projectId: string;
}

export function loadBackendConfig(): BackendConfig {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required. Provide a PostgreSQL connection string like: ' +
        'postgresql://user:password@host:port/database'
    );
  }

  // Validate it's a PostgreSQL URL
  if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
    throw new Error(
      'DATABASE_URL must be a PostgreSQL connection string (postgres:// or postgresql://)'
    );
  }

  // Allow optional project ID override, default to 'default'
  const projectId = process.env.MEMORY_PROJECT_ID?.trim() || 'default';

  return {
    databaseUrl,
    projectId,
  };
}
