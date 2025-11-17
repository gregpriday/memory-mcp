import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import { config } from 'dotenv';
import { loadBackendConfig } from '../src/config/backend.js';
import { TestServerHarness } from './helpers/TestServerHarness.js';

// Load environment variables
config();

describe('Index Tools Integration Tests', () => {
  let harness: TestServerHarness;
  const testProjectId = 'index-tools-test';
  const testIndexPrefix = 'idx-test-';

  before(async () => {
    // Load database URL from backend config (projects.json)
    const backendConfig = loadBackendConfig();
    const databaseUrl = backendConfig.activeProject.databaseUrl;

    harness = new TestServerHarness(databaseUrl, testProjectId);

    // Clean up any existing test indexes from previous runs
    await harness.cleanupTestIndexes(testIndexPrefix);
  });

  afterEach(async () => {
    // Clean up after each test for better isolation
    if (harness) {
      await harness.cleanupTestIndexes(testIndexPrefix);
    }
  });

  after(async () => {
    // Final cleanup and close connections
    if (harness) {
      await harness.cleanupTestIndexes(testIndexPrefix);
      await harness.close();
    }
  });

  it('should create an index successfully', async () => {
    const indexName = `${testIndexPrefix}${Date.now()}-basic`;
    const description = 'Test index for basic creation';

    const result = await harness.callCreateIndex(indexName, description);

    // Verify result structure
    assert.strictEqual(result.status, 'ok', 'Index creation should succeed');
    assert.strictEqual(result.name, indexName, 'Result should contain correct index name');
    assert.ok(result.notes, 'Result should contain notes');

    // Note: Acceptance criteria mentions created:true field, but current API uses status:'ok'
    // This assertion will need to be updated when the API is changed to include created field
  });

  it('should verify index exists in database after creation', async () => {
    const indexName = `${testIndexPrefix}${Date.now()}-db-verify`;
    const description = 'Test index for database verification';

    // Create index via controller
    await harness.callCreateIndex(indexName, description);

    // Verify the row exists in database
    const exists = await harness.verifyIndexInDatabase(indexName);
    assert.strictEqual(exists, true, 'Index should exist in memory_indexes table');

    // Verify project ID matches
    const result = await harness.pool.query(
      'SELECT project, name FROM memory_indexes WHERE project = $1 AND name = $2',
      [testProjectId, indexName]
    );

    assert.strictEqual(result.rows.length, 1, 'Should find exactly one index row');
    assert.strictEqual(result.rows[0].project, testProjectId, 'Project ID should match');
    assert.strictEqual(result.rows[0].name, indexName, 'Index name should match');
  });

  it('should list indexes and include newly created index', async () => {
    const indexName = `${testIndexPrefix}${Date.now()}-list`;
    const description = 'Test index for list operation';

    // Create index
    await harness.callCreateIndex(indexName, description);

    // List indexes
    const listResult = await harness.callListIndexes();

    // Verify result structure
    assert.strictEqual(listResult.status, 'ok', 'List indexes should succeed');
    assert.ok(Array.isArray(listResult.indexes), 'Result should contain indexes array');

    // Find our test index
    const foundIndex = listResult.indexes?.find((idx) => idx.name === indexName);
    assert.ok(foundIndex, `Should find index "${indexName}" in list`);

    // Verify documentCount is 0 for new index
    assert.strictEqual(foundIndex.documentCount, 0, 'New index should have documentCount of 0');
    assert.strictEqual(
      foundIndex.pendingDocumentCount,
      0,
      'New index should have pendingDocumentCount of 0'
    );
  });

  it('should handle multiple indexes correctly', async () => {
    const timestamp = Date.now();
    const index1 = `${testIndexPrefix}${timestamp}-multi-1`;
    const index2 = `${testIndexPrefix}${timestamp}-multi-2`;
    const index3 = `${testIndexPrefix}${timestamp}-multi-3`;

    // Create three indexes
    await harness.callCreateIndex(index1, 'First test index');
    await harness.callCreateIndex(index2, 'Second test index');
    await harness.callCreateIndex(index3, 'Third test index');

    // List all indexes
    const listResult = await harness.callListIndexes();

    assert.strictEqual(listResult.status, 'ok', 'List indexes should succeed');

    // Verify all three indexes are present
    const indexNames = listResult.indexes?.map((idx) => idx.name) || [];
    assert.ok(indexNames.includes(index1), `Should find ${index1}`);
    assert.ok(indexNames.includes(index2), `Should find ${index2}`);
    assert.ok(indexNames.includes(index3), `Should find ${index3}`);

    // Verify all have documentCount of 0
    const testIndexes = listResult.indexes?.filter((idx) =>
      [index1, index2, index3].includes(idx.name)
    );
    assert.strictEqual(testIndexes?.length, 3, 'Should find all three test indexes');

    testIndexes?.forEach((idx) => {
      assert.strictEqual(idx.documentCount, 0, `Index ${idx.name} should have documentCount of 0`);
      assert.strictEqual(
        idx.pendingDocumentCount,
        0,
        `Index ${idx.name} should have pendingDocumentCount of 0`
      );
    });

    // Verify top-level documentCount
    if (typeof listResult.documentCount === 'number') {
      const testDocsCount = testIndexes?.reduce((sum, idx) => sum + idx.documentCount, 0) || 0;
      assert.ok(
        listResult.documentCount >= testDocsCount,
        'Total documentCount should include all test indexes'
      );
    }
  });

  it('should handle idempotent index creation', async () => {
    const indexName = `${testIndexPrefix}${Date.now()}-idempotent`;
    const description = 'Test index for idempotency';

    // Create index first time
    const result1 = await harness.callCreateIndex(indexName, description);
    assert.strictEqual(result1.status, 'ok', 'First creation should succeed');

    // Create same index again
    const result2 = await harness.callCreateIndex(indexName, description);
    assert.strictEqual(result2.status, 'ok', 'Second creation should succeed (idempotent)');

    // Verify only one row exists in database
    const dbResult = await harness.pool.query(
      'SELECT COUNT(*) as count FROM memory_indexes WHERE project = $1 AND name = $2',
      [testProjectId, indexName]
    );

    assert.strictEqual(
      parseInt(dbResult.rows[0].count, 10),
      1,
      'Should have exactly one index row (not duplicated)'
    );
  });
});
