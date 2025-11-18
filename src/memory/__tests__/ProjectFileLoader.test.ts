import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ProjectFileLoader } from '../ProjectFileLoader.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ProjectFileLoader', () => {
  let testRootDir: string;
  let loader: ProjectFileLoader;

  beforeEach(() => {
    // Create a unique temporary directory for each test
    testRootDir = join(
      tmpdir(),
      `test-project-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testRootDir, { recursive: true });
    loader = new ProjectFileLoader(testRootDir);
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testRootDir)) {
      rmSync(testRootDir, { recursive: true, force: true });
    }
  });

  describe('constructor', () => {
    it('should accept rootDir parameter', () => {
      const customLoader = new ProjectFileLoader('/custom/path');
      expect(customLoader.getRootDir()).toContain('custom');
    });

    it('should use default maxFileSize of 2MB', async () => {
      const filePath = join(testRootDir, 'large.txt');
      // Create a file just over 2MB
      const largeContent = 'a'.repeat(2 * 1024 * 1024 + 1);
      writeFileSync(filePath, largeContent);

      await expect(loader.readText('large.txt')).rejects.toThrow(/too large/);
    });

    it('should accept custom maxFileSize', async () => {
      const smallLoader = new ProjectFileLoader(testRootDir, 1024); // 1KB limit
      const filePath = join(testRootDir, 'medium.txt');
      const content = 'a'.repeat(2000); // 2KB
      writeFileSync(filePath, content);

      await expect(smallLoader.readText('medium.txt')).rejects.toThrow(/too large/);
    });
  });

  describe('getRootDir', () => {
    it('should return the root directory', () => {
      expect(loader.getRootDir()).toBe(testRootDir);
    });

    it('should return absolute path', () => {
      const relativeLoader = new ProjectFileLoader('.');
      const rootDir = relativeLoader.getRootDir();
      expect(rootDir.startsWith('/')).toBe(true);
    });
  });

  describe('readText', () => {
    describe('successful reads', () => {
      it('should read text file successfully', async () => {
        const filePath = join(testRootDir, 'test.txt');
        writeFileSync(filePath, 'Hello, World!');

        const content = await loader.readText('test.txt');
        expect(content).toBe('Hello, World!');
      });

      it('should read file from subdirectory', async () => {
        const subDir = join(testRootDir, 'subdir');
        mkdirSync(subDir);
        const filePath = join(subDir, 'nested.txt');
        writeFileSync(filePath, 'Nested content');

        const content = await loader.readText('subdir/nested.txt');
        expect(content).toBe('Nested content');
      });

      it('should read file with UTF-8 content', async () => {
        const filePath = join(testRootDir, 'utf8.txt');
        writeFileSync(filePath, 'Unicode: 你好世界 🌍');

        const content = await loader.readText('utf8.txt');
        expect(content).toBe('Unicode: 你好世界 🌍');
      });

      it('should read empty file', async () => {
        const filePath = join(testRootDir, 'empty.txt');
        writeFileSync(filePath, '');

        const content = await loader.readText('empty.txt');
        expect(content).toBe('');
      });

      it('should read file at size limit boundary', async () => {
        const smallLoader = new ProjectFileLoader(testRootDir, 1024);
        const filePath = join(testRootDir, 'boundary.txt');
        const content = 'a'.repeat(1024); // Exactly 1KB
        writeFileSync(filePath, content);

        const result = await smallLoader.readText('boundary.txt');
        expect(result).toBe(content);
      });

      it('should handle normalized paths', async () => {
        const filePath = join(testRootDir, 'test.txt');
        writeFileSync(filePath, 'Content');

        const content = await loader.readText('./test.txt');
        expect(content).toBe('Content');
      });

      it('should handle paths with multiple slashes', async () => {
        const subDir = join(testRootDir, 'subdir');
        mkdirSync(subDir);
        const filePath = join(subDir, 'test.txt');
        writeFileSync(filePath, 'Content');

        const content = await loader.readText('subdir//test.txt');
        expect(content).toBe('Content');
      });
    });

    describe('security: path traversal prevention', () => {
      it('should reject path traversal with ../', async () => {
        await expect(loader.readText('../outside.txt')).rejects.toThrow(/Access denied.*escape/);
      });

      it('should reject path traversal with ../../', async () => {
        await expect(loader.readText('../../outside.txt')).rejects.toThrow(/Access denied.*escape/);
      });

      it('should reject path traversal in middle of path', async () => {
        await expect(loader.readText('subdir/../../../outside.txt')).rejects.toThrow(
          /Access denied.*escape/
        );
      });

      it('should reject absolute path outside project', async () => {
        await expect(loader.readText('/etc/passwd')).rejects.toThrow(/Access denied.*escape/);
      });

      it('should reject reading root directory itself', async () => {
        await expect(loader.readText('.')).rejects.toThrow(/Access denied.*escape/);
      });

      it('should reject reading parent via normalized path', async () => {
        await expect(loader.readText('subdir/..')).rejects.toThrow(/Access denied.*escape/);
      });
    });

    describe('security: blocked files', () => {
      it('should reject .env file', async () => {
        const filePath = join(testRootDir, '.env');
        writeFileSync(filePath, 'SECRET=value');

        await expect(loader.readText('.env')).rejects.toThrow(/Access denied.*sensitive file/);
      });

      it('should reject .env.local file', async () => {
        const filePath = join(testRootDir, '.env.local');
        writeFileSync(filePath, 'SECRET=value');

        await expect(loader.readText('.env.local')).rejects.toThrow(
          /Access denied.*sensitive file/
        );
      });

      it('should reject .env.production file', async () => {
        const filePath = join(testRootDir, '.env.production');
        writeFileSync(filePath, 'SECRET=value');

        await expect(loader.readText('.env.production')).rejects.toThrow(
          /Access denied.*sensitive file/
        );
      });

      it('should reject .env.development file', async () => {
        const filePath = join(testRootDir, '.env.development');
        writeFileSync(filePath, 'SECRET=value');

        await expect(loader.readText('.env.development')).rejects.toThrow(
          /Access denied.*sensitive file/
        );
      });

      it('should reject .mcp.json file', async () => {
        const filePath = join(testRootDir, '.mcp.json');
        writeFileSync(filePath, '{}');

        await expect(loader.readText('.mcp.json')).rejects.toThrow(/Access denied.*sensitive file/);
      });

      it('should reject credentials.json file', async () => {
        const filePath = join(testRootDir, 'credentials.json');
        writeFileSync(filePath, '{}');

        await expect(loader.readText('credentials.json')).rejects.toThrow(
          /Access denied.*sensitive file/
        );
      });

      it('should reject secrets.json file', async () => {
        const filePath = join(testRootDir, 'secrets.json');
        writeFileSync(filePath, '{}');

        await expect(loader.readText('secrets.json')).rejects.toThrow(
          /Access denied.*sensitive file/
        );
      });

      it('should reject .npmrc file', async () => {
        const filePath = join(testRootDir, '.npmrc');
        writeFileSync(filePath, '//registry.npmjs.org/:_authToken=token');

        await expect(loader.readText('.npmrc')).rejects.toThrow(/Access denied.*sensitive file/);
      });

      it('should reject .yarnrc file', async () => {
        const filePath = join(testRootDir, '.yarnrc');
        writeFileSync(filePath, 'registry "https://registry.yarnpkg.com"');

        await expect(loader.readText('.yarnrc')).rejects.toThrow(/Access denied.*sensitive file/);
      });

      it('should reject .env file in subdirectory', async () => {
        const subDir = join(testRootDir, 'config');
        mkdirSync(subDir);
        const filePath = join(subDir, '.env');
        writeFileSync(filePath, 'SECRET=value');

        await expect(loader.readText('config/.env')).rejects.toThrow(
          /Access denied.*sensitive file/
        );
      });

      it('should reject nested .env.production file', async () => {
        const subDir = join(testRootDir, 'config');
        mkdirSync(subDir);
        const filePath = join(subDir, '.env.production');
        writeFileSync(filePath, 'PROD_SECRET=value');

        await expect(loader.readText('config/.env.production')).rejects.toThrow(
          /Access denied.*sensitive file/
        );
      });

      it('should reject deeply nested .env.local file', async () => {
        const deepDir = join(testRootDir, 'services', 'api');
        mkdirSync(deepDir, { recursive: true });
        const filePath = join(deepDir, '.env.local');
        writeFileSync(filePath, 'API_SECRET=value');

        await expect(loader.readText('services/api/.env.local')).rejects.toThrow(
          /Access denied.*sensitive file/
        );
      });

      it('should reject config/secrets.yml', async () => {
        const configDir = join(testRootDir, 'config');
        mkdirSync(configDir);
        const filePath = join(configDir, 'secrets.yml');
        writeFileSync(filePath, 'secret: value');

        await expect(loader.readText('config/secrets.yml')).rejects.toThrow(
          /Access denied.*sensitive file/
        );
      });

      it('should reject config/credentials.yml', async () => {
        const configDir = join(testRootDir, 'config');
        mkdirSync(configDir);
        const filePath = join(configDir, 'credentials.yml');
        writeFileSync(filePath, 'credential: value');

        await expect(loader.readText('config/credentials.yml')).rejects.toThrow(
          /Access denied.*sensitive file/
        );
      });
    });

    describe('file size limits', () => {
      it('should reject file exceeding size limit', async () => {
        const smallLoader = new ProjectFileLoader(testRootDir, 1024); // 1KB limit
        const filePath = join(testRootDir, 'large.txt');
        const largeContent = 'a'.repeat(2000); // 2KB
        writeFileSync(filePath, largeContent);

        await expect(smallLoader.readText('large.txt')).rejects.toThrow(
          /too large.*2KB.*Maximum size is 1KB/
        );
      });

      it('should include file size in error message', async () => {
        const smallLoader = new ProjectFileLoader(testRootDir, 1024);
        const filePath = join(testRootDir, 'large.txt');
        const largeContent = 'a'.repeat(5000); // 5KB
        writeFileSync(filePath, largeContent);

        await expect(smallLoader.readText('large.txt')).rejects.toThrow(/5KB/);
      });

      it('should accept file just under size limit', async () => {
        const smallLoader = new ProjectFileLoader(testRootDir, 1024);
        const filePath = join(testRootDir, 'ok.txt');
        const content = 'a'.repeat(1000); // Just under 1KB
        writeFileSync(filePath, content);

        const result = await smallLoader.readText('ok.txt');
        expect(result.length).toBe(1000);
      });
    });

    describe('error handling', () => {
      it('should throw error for non-existent file', async () => {
        await expect(loader.readText('nonexistent.txt')).rejects.toThrow(/File not found/);
      });

      it('should throw error when reading directory', async () => {
        const subDir = join(testRootDir, 'subdir');
        mkdirSync(subDir);

        await expect(loader.readText('subdir')).rejects.toThrow(/not a file/);
      });
    });
  });

  describe('getFileSize', () => {
    it('should return size of existing file', async () => {
      const filePath = join(testRootDir, 'test.txt');
      const content = 'Hello';
      writeFileSync(filePath, content);

      const size = await loader.getFileSize('test.txt');
      expect(size).toBe(5);
    });

    it('should return 0 for empty file', async () => {
      const filePath = join(testRootDir, 'empty.txt');
      writeFileSync(filePath, '');

      const size = await loader.getFileSize('empty.txt');
      expect(size).toBe(0);
    });

    it('should reject path traversal', async () => {
      await expect(loader.getFileSize('../outside.txt')).rejects.toThrow(/Access denied.*escape/);
    });

    it('should reject blocked files', async () => {
      const filePath = join(testRootDir, '.env');
      writeFileSync(filePath, 'SECRET=value');

      await expect(loader.getFileSize('.env')).rejects.toThrow(/Access denied.*sensitive file/);
    });

    it('should reject file exceeding size limit', async () => {
      const smallLoader = new ProjectFileLoader(testRootDir, 1024);
      const filePath = join(testRootDir, 'large.txt');
      const largeContent = 'a'.repeat(2000);
      writeFileSync(filePath, largeContent);

      await expect(smallLoader.getFileSize('large.txt')).rejects.toThrow(/too large/);
    });

    it('should accept file at size limit boundary', async () => {
      const smallLoader = new ProjectFileLoader(testRootDir, 1024);
      const filePath = join(testRootDir, 'boundary.txt');
      const content = 'a'.repeat(1024);
      writeFileSync(filePath, content);

      const size = await smallLoader.getFileSize('boundary.txt');
      expect(size).toBe(1024);
    });

    it('should throw error for non-existent file', async () => {
      await expect(loader.getFileSize('nonexistent.txt')).rejects.toThrow(/File not found/);
    });

    it('should throw error for directory', async () => {
      const subDir = join(testRootDir, 'subdir');
      mkdirSync(subDir);

      await expect(loader.getFileSize('subdir')).rejects.toThrow(/not a file/);
    });

    it('should return correct size for UTF-8 file', async () => {
      const filePath = join(testRootDir, 'utf8.txt');
      const content = '你好'; // 2 characters, but more bytes in UTF-8
      writeFileSync(filePath, content);

      const size = await loader.getFileSize('utf8.txt');
      // UTF-8 encoding: 你 = 3 bytes, 好 = 3 bytes, total = 6 bytes
      expect(size).toBe(6);
    });
  });

  describe('edge cases', () => {
    it('should handle file path with dots in filename', async () => {
      const filePath = join(testRootDir, 'file.test.txt');
      writeFileSync(filePath, 'content');

      const content = await loader.readText('file.test.txt');
      expect(content).toBe('content');
    });

    it('should handle deeply nested directories', async () => {
      const deepPath = 'a/b/c/d/e/f';
      const fullPath = join(testRootDir, deepPath);
      mkdirSync(fullPath, { recursive: true });
      const filePath = join(fullPath, 'deep.txt');
      writeFileSync(filePath, 'deeply nested');

      const content = await loader.readText('a/b/c/d/e/f/deep.txt');
      expect(content).toBe('deeply nested');
    });

    it('should handle normalized paths correctly', async () => {
      const subDir = join(testRootDir, 'subdir');
      mkdirSync(subDir);
      const filePath = join(subDir, 'test.txt');
      writeFileSync(filePath, 'content');

      // Test that path normalization works (removes . and redundant separators)
      const content = await loader.readText('./subdir/./test.txt');
      expect(content).toBe('content');
    });

    it('should handle multiple consecutive path separators', async () => {
      const subDir = join(testRootDir, 'sub');
      mkdirSync(subDir);
      const filePath = join(subDir, 'test.txt');
      writeFileSync(filePath, 'content');

      const content = await loader.readText('sub///test.txt');
      expect(content).toBe('content');
    });
  });
});
