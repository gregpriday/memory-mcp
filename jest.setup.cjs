const { resolve } = require('path');

// Set NODE_ENV to test if not already set
process.env.NODE_ENV ??= 'test';

// Configure test project for database isolation
process.env.MEMORY_ACTIVE_PROJECT ??= 'test';

// Point to test project registry
process.env.MEMORY_POSTGRES_PROJECT_REGISTRY = resolve(
  __dirname,
  'config/projects.test.json',
);
