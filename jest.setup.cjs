// Set NODE_ENV to test if not already set
process.env.NODE_ENV ??= 'test';

// Configure test database URL
// Use DATABASE_URL if set, otherwise default to test database
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5433/memory_test';

// Set default project ID for tests
process.env.MEMORY_PROJECT_ID ??= 'test';
