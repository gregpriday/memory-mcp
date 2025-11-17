import { readFileSync, statSync, Stats } from 'fs';
import { resolve, normalize, relative } from 'path';

/**
 * ProjectFileLoader
 * Safely loads files from the project directory with security checks
 */
export class ProjectFileLoader {
  private rootDir: string;
  private maxFileSize: number;

  // Sensitive files that should never be read by the agent
  private static readonly BLOCKED_FILES = new Set([
    '.env',
    '.env.local',
    '.env.production',
    '.env.development',
    'data/indexes.json',
    '.mcp.json',
    'credentials.json',
    'secrets.json',
    '.npmrc',
    '.yarnrc',
    'config/secrets.yml',
    'config/credentials.yml',
  ]);

  constructor(rootDir: string, maxFileSize: number = 2 * 1024 * 1024) {
    // 2MB default
    this.rootDir = resolve(rootDir);
    this.maxFileSize = maxFileSize;
  }

  /**
   * Resolve and validate a file path relative to the project root
   */
  private resolveAndValidatePath(path: string): { absolutePath: string; relativePath: string } {
    const normalizedPath = normalize(path);
    const absolutePath = resolve(this.rootDir, normalizedPath);

    const relativePath = relative(this.rootDir, absolutePath);
    if (relativePath.startsWith('..') || absolutePath === this.rootDir) {
      throw new Error(`Access denied: Path "${path}" attempts to escape project directory`);
    }

    if (
      ProjectFileLoader.BLOCKED_FILES.has(relativePath) ||
      relativePath.endsWith('/.env') ||
      relativePath.includes('/.env.')
    ) {
      throw new Error(`Access denied: Cannot read sensitive file "${path}"`);
    }

    return { absolutePath, relativePath };
  }

  /**
   * Resolve path and return file stats (throws if path is invalid)
   */
  private getFileInfo(path: string): { absolutePath: string; relativePath: string; stats: Stats } {
    const { absolutePath, relativePath } = this.resolveAndValidatePath(path);

    let stats: Stats;
    try {
      stats = statSync(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`File not found: ${path}`);
      }
      throw new Error(`Cannot access file "${path}": ${(error as Error).message}`);
    }

    if (!stats.isFile()) {
      throw new Error(`Path "${path}" is not a file`);
    }

    return { absolutePath, relativePath, stats };
  }

  /**
   * Read a text file from the project directory
   * @param path Relative path from project root
   * @returns File contents as string
   */
  async readText(path: string): Promise<string> {
    const { absolutePath, stats } = this.getFileInfo(path);

    // Check file size
    if (stats.size > this.maxFileSize) {
      throw new Error(
        `File "${path}" is too large (${Math.round(stats.size / 1024)}KB). Maximum size is ${Math.round(this.maxFileSize / 1024)}KB.`
      );
    }

    // Read the file
    try {
      return readFileSync(absolutePath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read file "${path}": ${(error as Error).message}`);
    }
  }

  /**
   * Return the size of a file in bytes (after security checks)
   */
  async getFileSize(path: string): Promise<number> {
    const { stats } = this.getFileInfo(path);

    if (stats.size > this.maxFileSize) {
      throw new Error(
        `File "${path}" is too large (${Math.round(stats.size / 1024)}KB). Maximum size is ${Math.round(this.maxFileSize / 1024)}KB.`
      );
    }

    return stats.size;
  }

  /**
   * Get the project root directory
   */
  getRootDir(): string {
    return this.rootDir;
  }
}
