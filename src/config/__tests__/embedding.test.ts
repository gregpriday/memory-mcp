import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { loadEmbeddingConfig, KNOWN_EMBEDDING_MODELS } from '../embedding.js';

describe('loadEmbeddingConfig', () => {
  // Capture original env at module load to avoid mutation issues
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Reset process.env to a clean state
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    // Restore original environment
    process.env = ORIGINAL_ENV;
  });

  it('should use defaults when env is unset', () => {
    delete process.env.MEMORY_EMBEDDING_MODEL;
    delete process.env.MEMORY_EMBEDDING_DIMENSIONS;

    const config = loadEmbeddingConfig();

    expect(config.model).toBe('text-embedding-3-small');
    expect(config.dimensions).toBe(1536);
    expect(config.dimensions).toBe(KNOWN_EMBEDDING_MODELS['text-embedding-3-small']);
  });

  it('should use known model mapping for text-embedding-3-large', () => {
    process.env.MEMORY_EMBEDDING_MODEL = 'text-embedding-3-large';
    delete process.env.MEMORY_EMBEDDING_DIMENSIONS;

    const config = loadEmbeddingConfig();

    expect(config.model).toBe('text-embedding-3-large');
    expect(config.dimensions).toBe(3072);
    expect(config.dimensions).toBe(KNOWN_EMBEDDING_MODELS['text-embedding-3-large']);
  });

  it('should use known model mapping for text-embedding-ada-002', () => {
    process.env.MEMORY_EMBEDDING_MODEL = 'text-embedding-ada-002';
    delete process.env.MEMORY_EMBEDDING_DIMENSIONS;

    const config = loadEmbeddingConfig();

    expect(config.model).toBe('text-embedding-ada-002');
    expect(config.dimensions).toBe(1536);
    expect(config.dimensions).toBe(KNOWN_EMBEDDING_MODELS['text-embedding-ada-002']);
  });

  it('should allow custom dimension override for known model', () => {
    process.env.MEMORY_EMBEDDING_MODEL = 'text-embedding-3-large';
    process.env.MEMORY_EMBEDDING_DIMENSIONS = '1024';

    const config = loadEmbeddingConfig();

    expect(config.model).toBe('text-embedding-3-large');
    expect(config.dimensions).toBe(1024);
  });

  it('should support custom model with explicit dimensions', () => {
    process.env.MEMORY_EMBEDDING_MODEL = 'my-custom-model';
    process.env.MEMORY_EMBEDDING_DIMENSIONS = '512';

    const config = loadEmbeddingConfig();

    expect(config.model).toBe('my-custom-model');
    expect(config.dimensions).toBe(512);
  });

  it('should throw when unknown model without dimensions', () => {
    process.env.MEMORY_EMBEDDING_MODEL = 'my-custom-model';
    delete process.env.MEMORY_EMBEDDING_DIMENSIONS;

    expect(() => loadEmbeddingConfig()).toThrow(
      'Embedding dimensions unknown for model "my-custom-model"'
    );
  });

  it('should throw when dimensions is not a number', () => {
    process.env.MEMORY_EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.MEMORY_EMBEDDING_DIMENSIONS = 'not-a-number';

    expect(() => loadEmbeddingConfig()).toThrow(
      'Invalid MEMORY_EMBEDDING_DIMENSIONS value: "not-a-number"'
    );
  });

  it('should throw when dimensions is zero', () => {
    process.env.MEMORY_EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.MEMORY_EMBEDDING_DIMENSIONS = '0';

    expect(() => loadEmbeddingConfig()).toThrow('Invalid MEMORY_EMBEDDING_DIMENSIONS value: "0"');
  });

  it('should throw when dimensions is negative', () => {
    process.env.MEMORY_EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.MEMORY_EMBEDDING_DIMENSIONS = '-1';

    expect(() => loadEmbeddingConfig()).toThrow('Invalid MEMORY_EMBEDDING_DIMENSIONS value: "-1"');
  });

  it('should throw when dimensions is Infinity', () => {
    process.env.MEMORY_EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.MEMORY_EMBEDDING_DIMENSIONS = 'Infinity';

    expect(() => loadEmbeddingConfig()).toThrow(
      'Invalid MEMORY_EMBEDDING_DIMENSIONS value: "Infinity"'
    );
  });

  it('should handle whitespace in model name', () => {
    process.env.MEMORY_EMBEDDING_MODEL = '  text-embedding-3-small  ';
    delete process.env.MEMORY_EMBEDDING_DIMENSIONS;

    const config = loadEmbeddingConfig();

    expect(config.model).toBe('text-embedding-3-small');
    expect(config.dimensions).toBe(1536);
  });

  it('should handle whitespace in dimensions', () => {
    process.env.MEMORY_EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.MEMORY_EMBEDDING_DIMENSIONS = '  1024  ';

    const config = loadEmbeddingConfig();

    expect(config.model).toBe('text-embedding-3-small');
    expect(config.dimensions).toBe(1024);
  });

  it('should handle both model and dimensions with whitespace', () => {
    process.env.MEMORY_EMBEDDING_MODEL = '  text-embedding-3-large  ';
    process.env.MEMORY_EMBEDDING_DIMENSIONS = '  2048  ';

    const config = loadEmbeddingConfig();

    expect(config.model).toBe('text-embedding-3-large');
    expect(config.dimensions).toBe(2048);
  });

  it('should accept decimal dimensions (OpenAI SDK handles rounding)', () => {
    process.env.MEMORY_EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.MEMORY_EMBEDDING_DIMENSIONS = '1536.5';

    const config = loadEmbeddingConfig();

    // Number(1536.5) is finite and > 0, so it should be accepted
    // Note: OpenAI SDK will handle any necessary rounding
    expect(config.dimensions).toBe(1536.5);
  });

  it('should throw when dimensions is NaN string', () => {
    process.env.MEMORY_EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.MEMORY_EMBEDDING_DIMENSIONS = 'NaN';

    expect(() => loadEmbeddingConfig()).toThrow('Invalid MEMORY_EMBEDDING_DIMENSIONS value: "NaN"');
  });

  it('should use custom dimensions with default model when only dimensions set', () => {
    delete process.env.MEMORY_EMBEDDING_MODEL;
    process.env.MEMORY_EMBEDDING_DIMENSIONS = '768';

    const config = loadEmbeddingConfig();

    expect(config.model).toBe('text-embedding-3-small');
    expect(config.dimensions).toBe(768);
  });

  it('should treat empty string model as default model', () => {
    process.env.MEMORY_EMBEDDING_MODEL = '';
    delete process.env.MEMORY_EMBEDDING_DIMENSIONS;

    const config = loadEmbeddingConfig();

    expect(config.model).toBe('text-embedding-3-small');
    expect(config.dimensions).toBe(1536);
  });

  it('should treat whitespace-only model as default model', () => {
    process.env.MEMORY_EMBEDDING_MODEL = '   ';
    delete process.env.MEMORY_EMBEDDING_DIMENSIONS;

    const config = loadEmbeddingConfig();

    expect(config.model).toBe('text-embedding-3-small');
    expect(config.dimensions).toBe(1536);
  });

  it('should use known model dimensions when empty dimensions string provided', () => {
    process.env.MEMORY_EMBEDDING_MODEL = 'text-embedding-3-large';
    process.env.MEMORY_EMBEDDING_DIMENSIONS = '';

    const config = loadEmbeddingConfig();

    expect(config.model).toBe('text-embedding-3-large');
    expect(config.dimensions).toBe(3072);
  });

  it('should include helpful error message for unknown model', () => {
    process.env.MEMORY_EMBEDDING_MODEL = 'unknown-model';
    delete process.env.MEMORY_EMBEDDING_DIMENSIONS;

    expect(() => loadEmbeddingConfig()).toThrow(
      'Embedding dimensions unknown for model "unknown-model"'
    );
    expect(() => loadEmbeddingConfig()).toThrow(
      'Either use a known model or set MEMORY_EMBEDDING_DIMENSIONS'
    );
  });
});
