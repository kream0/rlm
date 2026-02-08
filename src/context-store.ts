import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type {
  IContextStore,
  VariableRef,
  VariableMeta,
  SetOptions,
  ListFilter,
  VariableType,
} from './types.js';

interface StoredVariable {
  ref: VariableRef;
  value: unknown;
  persist: boolean;
  summaryCache?: string;
}

export class ContextStore implements IContextStore {
  private variables = new Map<string, StoredVariable>();
  private storageDir: string;
  private maxMemoryBytes: number;
  private currentMemoryBytes = 0;

  constructor(storageDir: string, maxMemoryBytes = 256 * 1024 * 1024) {
    this.storageDir = storageDir;
    this.maxMemoryBytes = maxMemoryBytes;
  }

  async init(): Promise<void> {
    if (!existsSync(this.storageDir)) {
      await mkdir(this.storageDir, { recursive: true });
    }
    // Load persisted variables from disk
    await this.loadPersistedVariables();
  }

  async set(key: string, value: unknown, opts?: SetOptions): Promise<VariableRef> {
    const serialized = JSON.stringify(value);
    const sizeBytes = Buffer.byteLength(serialized, 'utf-8');
    const scope = opts?.scope ?? 'global';
    const type = opts?.type ?? this.inferType(value);
    const persist = opts?.persist ?? false;

    // Remove old variable if exists
    if (this.variables.has(key)) {
      const old = this.variables.get(key)!;
      this.currentMemoryBytes -= old.ref.sizeBytes;
    }

    const ref: VariableRef = {
      id: randomUUID(),
      key,
      scope,
      type,
      sizeBytes,
      createdAt: Date.now(),
    };

    const stored: StoredVariable = { ref, value, persist, summaryCache: undefined };
    this.variables.set(key, stored);
    this.currentMemoryBytes += sizeBytes;

    // Spill to disk if over memory limit
    if (this.currentMemoryBytes > this.maxMemoryBytes) {
      await this.spillToDisk(key);
    }

    // Persist to disk if requested
    if (persist) {
      await this.persistVariable(key, stored);
    }

    return ref;
  }

  async get(key: string): Promise<unknown> {
    const stored = this.variables.get(key);
    if (!stored) {
      // Try loading from disk
      const diskValue = await this.loadFromDisk(key);
      if (diskValue !== undefined) {
        return diskValue;
      }
      throw new Error(`Variable not found: ${key}`);
    }

    // If spilled to disk, load it
    if (stored.value === null && stored.persist) {
      const diskValue = await this.loadFromDisk(key);
      return diskValue;
    }

    return stored.value;
  }

  ref(key: string): VariableRef {
    const stored = this.variables.get(key);
    if (!stored) {
      throw new Error(`Variable not found: ${key}`);
    }
    // O(1) - just returns the pre-computed metadata
    return { ...stored.ref };
  }

  async resolve(ref: VariableRef): Promise<unknown> {
    return this.get(ref.key);
  }

  async delete(key: string): Promise<void> {
    const stored = this.variables.get(key);
    if (stored) {
      this.currentMemoryBytes -= stored.ref.sizeBytes;
      this.variables.delete(key);
    }
    // Also remove from disk
    const filePath = join(this.storageDir, `${this.sanitizeKey(key)}.json`);
    try {
      await unlink(filePath);
    } catch {
      // File doesn't exist on disk, that's fine
    }
  }

  async list(filter?: ListFilter): Promise<VariableMeta[]> {
    const results: VariableMeta[] = [];
    for (const [, stored] of this.variables) {
      if (filter?.scope && stored.ref.scope !== filter.scope) continue;
      if (filter?.type && stored.ref.type !== filter.type) continue;
      results.push({
        key: stored.ref.key,
        type: stored.ref.type,
        scope: stored.ref.scope,
        sizeBytes: stored.ref.sizeBytes,
        createdAt: stored.ref.createdAt,
        persist: stored.persist,
      });
    }
    return results;
  }

  async summarize(key: string, maxTokens = 200): Promise<string> {
    const stored = this.variables.get(key);
    if (!stored) {
      throw new Error(`Variable not found: ${key}`);
    }

    // Return cached summary if available
    if (stored.summaryCache) {
      return stored.summaryCache;
    }

    const value = await this.get(key);
    const str = typeof value === 'string' ? value : JSON.stringify(value, null, 2);

    // Simple truncation-based summarization (no LLM call needed for basic summary)
    // Approximate 4 chars per token
    const maxChars = maxTokens * 4;
    let summary: string;

    if (str.length <= maxChars) {
      summary = str;
    } else {
      const preview = str.slice(0, maxChars);
      summary = `${preview}... [truncated, ${stored.ref.sizeBytes} bytes total, type: ${stored.ref.type}]`;
    }

    // Cache the summary
    stored.summaryCache = summary;
    return summary;
  }

  has(key: string): boolean {
    return this.variables.has(key);
  }

  async clear(): Promise<void> {
    this.variables.clear();
    this.currentMemoryBytes = 0;
    // Clean disk storage too
    try {
      const files = await readdir(this.storageDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          await unlink(join(this.storageDir, file));
        }
      }
    } catch {
      // Directory might not exist
    }
  }

  async persistForSubAgent(key: string): Promise<string> {
    const stored = this.variables.get(key);
    if (!stored) {
      throw new Error(`Variable not found: ${key}`);
    }
    await this.persistVariable(key, stored);
    return this.getFilePath(key);
  }

  getStorageDir(): string {
    return this.storageDir;
  }

  getFilePath(key: string): string {
    return resolve(this.storageDir, `${this.sanitizeKey(key)}.json`);
  }

  getMemoryUsage(): { currentBytes: number; maxBytes: number; percentage: number } {
    return {
      currentBytes: this.currentMemoryBytes,
      maxBytes: this.maxMemoryBytes,
      percentage: (this.currentMemoryBytes / this.maxMemoryBytes) * 100,
    };
  }

  // --- Private helpers ---

  private inferType(value: unknown): VariableType {
    if (typeof value === 'string') return 'text';
    if (Array.isArray(value)) return 'json';
    if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if ('entries' in obj || 'memories' in obj) return 'memory';
      if ('result' in obj || 'output' in obj) return 'result';
      return 'json';
    }
    return 'json';
  }

  private sanitizeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private async persistVariable(key: string, stored: StoredVariable): Promise<void> {
    const filePath = join(this.storageDir, `${this.sanitizeKey(key)}.json`);
    const data = {
      ref: stored.ref,
      value: stored.value,
      persist: true,
    };
    await writeFile(filePath, JSON.stringify(data), 'utf-8');
  }

  private async spillToDisk(key: string): Promise<void> {
    const stored = this.variables.get(key);
    if (!stored) return;

    await this.persistVariable(key, stored);
    // Keep the ref but null out the value in memory
    stored.value = null;
    stored.persist = true;
    this.currentMemoryBytes -= stored.ref.sizeBytes;
  }

  private async loadFromDisk(key: string): Promise<unknown> {
    const filePath = join(this.storageDir, `${this.sanitizeKey(key)}.json`);
    try {
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      return data.value;
    } catch {
      return undefined;
    }
  }

  private async loadPersistedVariables(): Promise<void> {
    try {
      const files = await readdir(this.storageDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = join(this.storageDir, file);
        try {
          const content = await readFile(filePath, 'utf-8');
          const data = JSON.parse(content);
          if (data.ref && data.ref.key) {
            const stored: StoredVariable = {
              ref: data.ref,
              value: data.value,
              persist: true,
            };
            this.variables.set(data.ref.key, stored);
            const serialized = JSON.stringify(data.value);
            this.currentMemoryBytes += Buffer.byteLength(serialized, 'utf-8');
          }
        } catch (err: unknown) {
          // Log corrupt files but continue loading others
          const error = err as Error;
          process.stderr.write(
            `[ContextStore] Warning: Skipping corrupt file `
              + `${filePath}: ${error.message}\n`
          );
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
  }
}
