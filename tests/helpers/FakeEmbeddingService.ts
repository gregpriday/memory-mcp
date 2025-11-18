/**
 * FakeEmbeddingService
 * Test double for EmbeddingService that generates deterministic embeddings
 * without calling OpenAI API. Used for isolated, fast, deterministic tests.
 */
export class FakeEmbeddingService {
  private expectedDimensions: number;
  private model: string;

  /**
   * @param expectedDimensions Dimensions of generated vectors (default: 1536)
   * @param model Model name to report (default: 'fake-embedding-model')
   */
  constructor(expectedDimensions = 1536, model = 'fake-embedding-model') {
    this.expectedDimensions = expectedDimensions;
    this.model = model;
  }

  /**
   * Generate a deterministic embedding vector for a single text.
   * The vector is based on the text content to ensure different texts
   * produce different (but still deterministic) embeddings.
   *
   * @param text Text to embed
   * @returns Deterministic embedding vector
   */
  async embedText(text: string): Promise<number[]> {
    return this.generateDeterministicVector(text);
  }

  /**
   * Generate deterministic embedding vectors for multiple texts.
   *
   * @param texts Array of texts to embed
   * @returns Array of deterministic embedding vectors
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    return texts.map((text) => this.generateDeterministicVector(text));
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

  /**
   * Generate a deterministic vector based on text content.
   * Uses a simple hash-like approach to ensure:
   * - Same text always produces same vector
   * - Different texts produce different vectors
   * - All vectors have the correct dimensions
   *
   * @param text Input text
   * @returns Deterministic vector of length expectedDimensions
   */
  private generateDeterministicVector(text: string): number[] {
    // Simple hash function to generate a seed from text
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    // Use the hash as a seed for pseudo-random number generation
    const seed = Math.abs(hash);

    // Generate deterministic vector
    const vector: number[] = [];
    for (let i = 0; i < this.expectedDimensions; i++) {
      // Simple linear congruential generator for deterministic values
      // Values are normalized to roughly [-1, 1] range like real embeddings
      const value = ((seed * (i + 1) * 48271) % 2147483647) / 2147483647;
      vector.push(value * 2 - 1); // Scale to [-1, 1]
    }

    return vector;
  }
}
