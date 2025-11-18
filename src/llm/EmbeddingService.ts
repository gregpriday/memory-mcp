import OpenAI from 'openai';
import type { EmbeddingCreateParams } from 'openai/resources/embeddings';

/**
 * Models that support the dimensions parameter.
 * Legacy models like text-embedding-ada-002 do not support this parameter.
 */
const MODELS_SUPPORTING_DIMENSIONS = new Set(['text-embedding-3-small', 'text-embedding-3-large']);

/**
 * EmbeddingService
 * Wrapper around OpenAI SDK for text embeddings with batching support
 */
export class EmbeddingService {
  private openai: OpenAI;
  private model: string;
  private expectedDimensions: number;
  private supportsDimensions: boolean;

  /**
   * @param apiKey OpenAI API key
   * @param model Embedding model to use (default: 'text-embedding-3-small')
   * @param expectedDimensions Expected dimensions for validation (default: 1536)
   */
  constructor(apiKey: string, model = 'text-embedding-3-small', expectedDimensions = 1536) {
    this.openai = new OpenAI({ apiKey });
    this.model = model;
    this.expectedDimensions = expectedDimensions;
    this.supportsDimensions = MODELS_SUPPORTING_DIMENSIONS.has(model);
  }

  /**
   * Embed a single text string.
   *
   * @param text Text to embed
   * @returns Embedding vector
   * @throws Error if API request fails or dimensions don't match
   */
  async embedText(text: string): Promise<number[]> {
    try {
      // Build request params conditionally based on model support
      const params: EmbeddingCreateParams = {
        model: this.model,
        input: text,
        encoding_format: 'float',
      };

      // Only include dimensions for models that support it
      if (this.supportsDimensions) {
        params.dimensions = this.expectedDimensions;
      }

      const response = await this.openai.embeddings.create(params);

      const embedding = response.data[0].embedding;

      // Validate dimensions
      if (embedding.length !== this.expectedDimensions) {
        throw new Error(
          `Embedding dimension mismatch: expected ${this.expectedDimensions}, got ${embedding.length}. ` +
            `Check MEMORY_EMBEDDING_MODEL and MEMORY_EMBEDDING_DIMENSIONS configuration.`
        );
      }

      return embedding;
    } catch (error) {
      if (error instanceof Error && error.message.includes('dimension mismatch')) {
        throw error; // Re-throw dimension errors as-is
      }
      console.error('Embedding API error:', error);
      throw new Error(`Embedding request failed: ${(error as Error).message}`);
    }
  }

  /**
   * Embed multiple text strings in a single batch request.
   *
   * OpenAI allows up to 2048 inputs per batch, but we recommend smaller batches
   * for better error handling and to avoid timeout issues.
   *
   * @param texts Array of texts to embed
   * @returns Array of embedding vectors in the same order as inputs
   * @throws Error if API request fails or dimensions don't match
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    if (texts.length > 2048) {
      throw new Error(
        `Batch size ${texts.length} exceeds OpenAI limit of 2048. ` + `Split into smaller batches.`
      );
    }

    try {
      // Build request params conditionally based on model support
      const params: EmbeddingCreateParams = {
        model: this.model,
        input: texts,
        encoding_format: 'float',
      };

      // Only include dimensions for models that support it
      if (this.supportsDimensions) {
        params.dimensions = this.expectedDimensions;
      }

      const response = await this.openai.embeddings.create(params);

      const embeddings = response.data.map((item) => item.embedding);

      // Validate all dimensions
      for (let i = 0; i < embeddings.length; i++) {
        if (embeddings[i].length !== this.expectedDimensions) {
          throw new Error(
            `Embedding dimension mismatch at index ${i}: expected ${this.expectedDimensions}, got ${embeddings[i].length}. ` +
              `Check MEMORY_EMBEDDING_MODEL and MEMORY_EMBEDDING_DIMENSIONS configuration.`
          );
        }
      }

      return embeddings;
    } catch (error) {
      if (error instanceof Error && error.message.includes('dimension mismatch')) {
        throw error; // Re-throw dimension errors as-is
      }
      console.error('Embedding API error:', error);
      throw new Error(`Batch embedding request failed: ${(error as Error).message}`);
    }
  }

  /**
   * Get the configured model name.
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Get the expected embedding dimensions.
   */
  getExpectedDimensions(): number {
    return this.expectedDimensions;
  }
}
