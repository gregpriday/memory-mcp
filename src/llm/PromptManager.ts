import { readFileSync, existsSync } from 'fs';
import { join, isAbsolute } from 'path';

/**
 * PromptManager
 * Loads and caches system prompts from the prompts directory
 */
export class PromptManager {
  private promptsDir: string;
  private cache: Map<string, string>;

  constructor(promptsDir: string) {
    this.promptsDir = promptsDir;
    this.cache = new Map();
  }

  /**
   * Check if a string is a valid file path that exists
   * @param value The string to check
   * @returns The resolved file path if it exists, undefined otherwise
   */
  private isExistingFilePath(value: string): string | undefined {
    // Try as absolute path first
    if (isAbsolute(value)) {
      try {
        if (existsSync(value)) {
          return value;
        }
      } catch {
        // Not a valid path
      }
      return undefined;
    }

    // Try as relative path from cwd
    try {
      const resolvedPath = join(process.cwd(), value);
      if (existsSync(resolvedPath)) {
        return resolvedPath;
      }
    } catch {
      // Not a valid path
    }

    return undefined;
  }

  /**
   * Load host context from env var - supports both inline text and file paths
   * @returns Host context content or undefined
   */
  private loadHostContext(): string | undefined {
    const envValue = process.env.MEMORY_MCP_SYSTEM_MESSAGE?.trim();
    if (!envValue) {
      return undefined;
    }

    // Check if the value is an existing file path
    const filePath = this.isExistingFilePath(envValue);
    if (filePath) {
      try {
        const content = readFileSync(filePath, 'utf-8').trim();
        if (content) {
          return content;
        }
        console.error(
          `Warning: File "${filePath}" exists but is empty. Falling back to treating env var as inline text.`
        );
      } catch (error) {
        console.error(
          `Warning: Failed to load MEMORY_MCP_SYSTEM_MESSAGE from file "${filePath}": ${(error as Error).message}`
        );
        console.error('Falling back to treating it as inline text.');
      }
    }

    // Treat as inline text
    return envValue;
  }

  /**
   * Load a prompt file by name
   * @param name Prompt file name (without .txt extension)
   * @returns Prompt content
   */
  getPrompt(name: string): string {
    // Check cache first
    if (this.cache.has(name)) {
      return this.cache.get(name)!;
    }

    // Load from file
    const filePath = join(this.promptsDir, `${name}.txt`);
    try {
      const content = readFileSync(filePath, 'utf-8');
      this.cache.set(name, content);
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Prompt file not found: ${name}.txt`);
      }
      throw new Error(`Failed to load prompt "${name}": ${(error as Error).message}`);
    }
  }

  /**
   * Compose a system prompt from multiple parts
   * @param promptNames Array of prompt names to compose
   * @param projectContext Optional project-specific system message
   * @returns Composed prompt
   */
  composePrompt(promptNames: string[], projectContext?: string): string {
    const parts = promptNames.map((name) => this.getPrompt(name));

    const projectPlaceholderToken = '{{project_system_message}}';
    const hostPlaceholderToken = '{{memory_host_system_message}}';

    // 1) Host-level MCP context from env var (optional)
    // Supports both inline text and file paths
    const hostContext = this.loadHostContext();
    if (hostContext) {
      // If the first prompt (usually memory-base) exposes an explicit placeholder,
      // inject there; otherwise prepend a generic HOST CONTEXT block.
      if (parts.length > 0 && parts[0].includes(hostPlaceholderToken)) {
        parts[0] = parts[0].replace(hostPlaceholderToken, hostContext);
      } else {
        parts.unshift(['[HOST CONTEXT]', hostContext, '[END HOST CONTEXT]'].join('\n'));
      }
    }

    // 2) Project-level context (existing behavior)
    if (projectContext) {
      if (parts.length > 0 && parts[0].includes(projectPlaceholderToken)) {
        parts[0] = parts[0].replace(projectPlaceholderToken, projectContext);
      } else {
        // If no placeholder, append project context
        parts.push('\n[PROJECT CONTEXT]\n' + projectContext + '\n[END PROJECT CONTEXT]\n');
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Clear the cache (useful for testing or hot-reloading)
   */
  clearCache(): void {
    this.cache.clear();
  }
}
