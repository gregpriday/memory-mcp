import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EmbeddingService } from '../EmbeddingService.js';

// Shared mock function for embeddings.create
const embeddingsCreateMock = jest.fn<() => Promise<{ data: Array<{ embedding: number[] }> }>>();

// Mock the OpenAI module
jest.mock('openai', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      embeddings: {
        create: embeddingsCreateMock,
      },
    })),
  };
});

describe('EmbeddingService', () => {
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    embeddingsCreateMock.mockReset();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('embedText', () => {
    it('should embed single text successfully with correct dimensions', async () => {
      const expectedDimensions = 1536;
      const embedding = new Array(expectedDimensions).fill(0.1);

      embeddingsCreateMock.mockResolvedValue({
        data: [{ embedding }],
      });

      const service = new EmbeddingService(
        'fake-api-key',
        'text-embedding-3-small',
        expectedDimensions
      );
      const result = await service.embedText('hello world');

      expect(result).toHaveLength(expectedDimensions);
      expect(result).toEqual(embedding);
      expect(embeddingsCreateMock).toHaveBeenCalledTimes(1);
      expect(embeddingsCreateMock).toHaveBeenCalledWith({
        model: 'text-embedding-3-small',
        input: 'hello world',
        dimensions: expectedDimensions,
        encoding_format: 'float',
      });
    });

    it('should throw dimension mismatch error when embedding length is incorrect', async () => {
      const expectedDimensions = 1536;
      const wrongDimensions = 1535;
      const embedding = new Array(wrongDimensions).fill(0.1);

      embeddingsCreateMock.mockResolvedValue({
        data: [{ embedding }],
      });

      const service = new EmbeddingService(
        'fake-api-key',
        'text-embedding-3-small',
        expectedDimensions
      );

      await expect(service.embedText('test text')).rejects.toThrow(
        `Embedding dimension mismatch: expected ${expectedDimensions}, got ${wrongDimensions}`
      );
    });

    it('should wrap generic API errors with descriptive message', async () => {
      const apiError = new Error('Rate limit exceeded');
      embeddingsCreateMock.mockRejectedValue(apiError);

      const service = new EmbeddingService('fake-api-key', 'text-embedding-3-small', 1536);

      await expect(service.embedText('test text')).rejects.toThrow(
        'Embedding request failed: Rate limit exceeded'
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith('Embedding API error:', apiError);
      expect(embeddingsCreateMock).toHaveBeenCalledTimes(1);
    });

    it('should re-throw dimension mismatch errors from API without wrapping', async () => {
      const dimensionError = new Error('some dimension mismatch in API response');
      embeddingsCreateMock.mockRejectedValue(dimensionError);

      const service = new EmbeddingService('fake-api-key', 'text-embedding-3-small', 1536);

      await expect(service.embedText('test text')).rejects.toBe(dimensionError);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(embeddingsCreateMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('embedBatch', () => {
    it('should embed multiple texts successfully', async () => {
      const expectedDimensions = 1536;
      const texts = ['first text', 'second text', 'third text'];
      const embeddings = texts.map(() => new Array(expectedDimensions).fill(0.2));

      embeddingsCreateMock.mockResolvedValue({
        data: embeddings.map((embedding) => ({ embedding })),
      });

      const service = new EmbeddingService(
        'fake-api-key',
        'text-embedding-3-small',
        expectedDimensions
      );
      const result = await service.embedBatch(texts);

      expect(result).toHaveLength(texts.length);
      expect(result).toEqual(embeddings);
      expect(embeddingsCreateMock).toHaveBeenCalledTimes(1);
      expect(embeddingsCreateMock).toHaveBeenCalledWith({
        model: 'text-embedding-3-small',
        input: texts,
        dimensions: expectedDimensions,
        encoding_format: 'float',
      });
    });

    it('should return empty array for empty input without calling API', async () => {
      const service = new EmbeddingService('fake-api-key', 'text-embedding-3-small', 1536);
      const result = await service.embedBatch([]);

      expect(result).toEqual([]);
      expect(embeddingsCreateMock).not.toHaveBeenCalled();
    });

    it('should throw error when batch size exceeds OpenAI limit', async () => {
      const texts = Array(2049).fill('text');
      const service = new EmbeddingService('fake-api-key', 'text-embedding-3-small', 1536);

      await expect(service.embedBatch(texts)).rejects.toThrow(
        'Batch size 2049 exceeds OpenAI limit of 2048'
      );
      expect(embeddingsCreateMock).not.toHaveBeenCalled();
    });

    it('should throw dimension mismatch error at specific index', async () => {
      const expectedDimensions = 1536;
      const correctEmbedding = new Array(expectedDimensions).fill(0.1);
      const wrongEmbedding = new Array(expectedDimensions - 1).fill(0.2);

      embeddingsCreateMock.mockResolvedValue({
        data: [{ embedding: correctEmbedding }, { embedding: wrongEmbedding }],
      });

      const service = new EmbeddingService(
        'fake-api-key',
        'text-embedding-3-small',
        expectedDimensions
      );

      await expect(service.embedBatch(['first', 'second'])).rejects.toThrow(
        `Embedding dimension mismatch at index 1: expected ${expectedDimensions}, got ${expectedDimensions - 1}`
      );
    });

    it('should wrap generic API errors with batch-specific message', async () => {
      const apiError = new Error('Service unavailable');
      embeddingsCreateMock.mockRejectedValue(apiError);

      const service = new EmbeddingService('fake-api-key', 'text-embedding-3-small', 1536);

      await expect(service.embedBatch(['text1', 'text2'])).rejects.toThrow(
        'Batch embedding request failed: Service unavailable'
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith('Embedding API error:', apiError);
      expect(embeddingsCreateMock).toHaveBeenCalledTimes(1);
    });

    it('should re-throw dimension mismatch errors from API without wrapping', async () => {
      const dimensionError = new Error('batch dimension mismatch from API');
      embeddingsCreateMock.mockRejectedValue(dimensionError);

      const service = new EmbeddingService('fake-api-key', 'text-embedding-3-small', 1536);

      await expect(service.embedBatch(['text1', 'text2'])).rejects.toBe(dimensionError);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(embeddingsCreateMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getModel', () => {
    it('should return the configured model name', () => {
      const service = new EmbeddingService('fake-api-key', 'text-embedding-3-large', 3072);
      expect(service.getModel()).toBe('text-embedding-3-large');
    });

    it('should return default model when not specified', () => {
      const service = new EmbeddingService('fake-api-key');
      expect(service.getModel()).toBe('text-embedding-3-small');
    });
  });

  describe('getExpectedDimensions', () => {
    it('should return the configured expected dimensions', () => {
      const service = new EmbeddingService('fake-api-key', 'text-embedding-3-large', 3072);
      expect(service.getExpectedDimensions()).toBe(3072);
    });

    it('should return default dimensions when not specified', () => {
      const service = new EmbeddingService('fake-api-key');
      expect(service.getExpectedDimensions()).toBe(1536);
    });
  });
});
