import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type {
  IMemoryManager,
  MemoryType,
  MemoryEntry,
  KnowledgeEntry,
  ProceduralRule,
  CompactOptions,
  MemoryStats,
} from './types.js';

export class MemoryManager implements IMemoryManager {
  private working: MemoryEntry[] = [];
  private episodic: MemoryEntry[] = [];
  private semantic: Map<string, KnowledgeEntry> = new Map();
  private procedural: ProceduralRule[] = [];
  private storageDir: string;
  private maxWorkingEntries: number;

  constructor(storageDir: string, maxWorkingEntries = 50) {
    this.storageDir = storageDir;
    this.maxWorkingEntries = maxWorkingEntries;
  }

  async init(): Promise<void> {
    if (!existsSync(this.storageDir)) {
      await mkdir(this.storageDir, { recursive: true });
    }
    // Load persisted memories
    await this.loadFromDisk('episodic');
    await this.loadFromDisk('semantic');
    await this.loadFromDisk('procedural');
  }

  async append(type: MemoryType, entry: MemoryEntry): Promise<void> {
    // Ensure entry has an ID and timestamp
    if (!entry.id) entry.id = randomUUID();
    if (!entry.timestamp) entry.timestamp = Date.now();

    switch (type) {
      case 'working':
        this.working.push(entry);
        // Auto-compact working memory if over limit
        if (this.working.length > this.maxWorkingEntries) {
          this.working = this.working.slice(-this.maxWorkingEntries);
        }
        break;
      case 'episodic':
        this.episodic.push(entry);
        await this.saveToDisk('episodic');
        break;
      case 'semantic': {
        // Semantic memory: extract key from content or metadata
        const key = entry.metadata?.key as string || entry.id;
        this.semantic.set(key, {
          key,
          value: entry.content,
          timestamp: entry.timestamp,
        });
        await this.saveToDisk('semantic');
        break;
      }
      case 'procedural': {
        this.procedural.push({
          condition: entry.metadata?.condition as string || '',
          action: entry.content,
          timestamp: entry.timestamp,
        });
        await this.saveToDisk('procedural');
        break;
      }
    }
  }

  async search(type: MemoryType, query: string, limit = 10): Promise<MemoryEntry[]> {
    const entries = this.getEntries(type);
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);

    // Score each entry by relevance
    const scored = entries.map((entry) => {
      const contentLower = entry.content.toLowerCase();
      const metaStr = entry.metadata ? JSON.stringify(entry.metadata).toLowerCase() : '';
      const fullText = contentLower + ' ' + metaStr;

      let score = 0;
      for (const term of queryTerms) {
        // Exact substring match
        const occurrences = (fullText.match(new RegExp(escapeRegex(term), 'g')) || []).length;
        score += occurrences * 2;

        // Partial match (term appears within a word)
        if (fullText.includes(term)) {
          score += 1;
        }
      }

      // Recency bonus: only applied if there was at least one term match
      if (score > 0) {
        const ageMs = Date.now() - entry.timestamp;
        const ageHours = ageMs / (1000 * 60 * 60);
        const recencyBonus = Math.max(0, 1 - ageHours / 24);
        score += recencyBonus * 0.5;
      }

      return { entry, score };
    });

    // Filter out zero-score entries, sort by score descending
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entry);
  }

  async learn(knowledge: KnowledgeEntry): Promise<void> {
    if (!knowledge.timestamp) knowledge.timestamp = Date.now();
    this.semantic.set(knowledge.key, knowledge);
    await this.saveToDisk('semantic');
  }

  async recall(key: string): Promise<KnowledgeEntry | null> {
    return this.semantic.get(key) ?? null;
  }

  async compact(type: MemoryType, opts?: CompactOptions): Promise<void> {
    const keepLast = opts?.keepLast ?? 10;
    const summarizeOlder = opts?.summarizeOlder ?? true;

    switch (type) {
      case 'working': {
        if (this.working.length <= keepLast) return;
        if (summarizeOlder) {
          const older = this.working.slice(0, -keepLast);
          const summary = this.createSummary(older);
          const kept = this.working.slice(-keepLast);
          this.working = [summary, ...kept];
        } else {
          this.working = this.working.slice(-keepLast);
        }
        break;
      }
      case 'episodic': {
        if (this.episodic.length <= keepLast) return;
        if (summarizeOlder) {
          const older = this.episodic.slice(0, -keepLast);
          const summary = this.createSummary(older);
          const kept = this.episodic.slice(-keepLast);
          this.episodic = [summary, ...kept];
        } else {
          this.episodic = this.episodic.slice(-keepLast);
        }
        await this.saveToDisk('episodic');
        break;
      }
      case 'semantic':
        // Semantic memory doesn't compact - it's key-value, already concise
        break;
      case 'procedural':
        // Keep only most recent rules if over limit
        if (this.procedural.length > keepLast) {
          this.procedural = this.procedural.slice(-keepLast);
          await this.saveToDisk('procedural');
        }
        break;
    }
  }

  getStats(): MemoryStats {
    const workingStr = JSON.stringify(this.working);
    const episodicStr = JSON.stringify(this.episodic);
    const semanticStr = JSON.stringify(Array.from(this.semantic.values()));
    const proceduralStr = JSON.stringify(this.procedural);

    // Approximate tokens at 4 chars per token
    const workingTokens = Math.ceil(workingStr.length / 4);

    return {
      workingMemoryTokens: workingTokens,
      episodicEntryCount: this.episodic.length,
      semanticEntryCount: this.semantic.size,
      proceduralRuleCount: this.procedural.length,
      totalStorageBytes:
        Buffer.byteLength(workingStr) +
        Buffer.byteLength(episodicStr) +
        Buffer.byteLength(semanticStr) +
        Buffer.byteLength(proceduralStr),
    };
  }

  async clear(type?: MemoryType): Promise<void> {
    if (!type || type === 'working') this.working = [];
    if (!type || type === 'episodic') {
      this.episodic = [];
      await this.saveToDisk('episodic');
    }
    if (!type || type === 'semantic') {
      this.semantic.clear();
      await this.saveToDisk('semantic');
    }
    if (!type || type === 'procedural') {
      this.procedural = [];
      await this.saveToDisk('procedural');
    }
  }

  getWorkingMemory(): MemoryEntry[] {
    return [...this.working];
  }

  getEpisodicMemory(): MemoryEntry[] {
    return [...this.episodic];
  }

  // --- Private helpers ---

  private getEntries(type: MemoryType): MemoryEntry[] {
    switch (type) {
      case 'working':
        return this.working;
      case 'episodic':
        return this.episodic;
      case 'semantic':
        return Array.from(this.semantic.values()).map((k) => ({
          id: k.key,
          timestamp: k.timestamp ?? Date.now(),
          content: `${k.key}: ${k.value}`,
          metadata: { key: k.key },
        }));
      case 'procedural':
        return this.procedural.map((r, i) => ({
          id: `rule-${i}`,
          timestamp: r.timestamp ?? Date.now(),
          content: `When ${r.condition} then ${r.action}`,
          metadata: { condition: r.condition, action: r.action },
        }));
    }
  }

  private createSummary(entries: MemoryEntry[]): MemoryEntry {
    // Create a local summary without LLM - just concatenate key info
    const summaryParts = entries.map((e) => {
      const meta = e.metadata ? ` [${Object.entries(e.metadata).map(([k, v]) => `${k}=${v}`).join(', ')}]` : '';
      return `- ${e.content.slice(0, 200)}${meta}`;
    });

    return {
      id: randomUUID(),
      timestamp: Date.now(),
      content: `[Summary of ${entries.length} entries]\n${summaryParts.join('\n')}`,
      metadata: { isSummary: true, entryCount: entries.length },
    };
  }

  private async saveToDisk(type: 'episodic' | 'semantic' | 'procedural'): Promise<void> {
    const filePath = join(this.storageDir, `${type}.json`);
    let data: unknown;

    switch (type) {
      case 'episodic':
        data = this.episodic;
        break;
      case 'semantic':
        data = Array.from(this.semantic.entries());
        break;
      case 'procedural':
        data = this.procedural;
        break;
    }

    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private async loadFromDisk(type: 'episodic' | 'semantic' | 'procedural'): Promise<void> {
    const filePath = join(this.storageDir, `${type}.json`);
    try {
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);

      switch (type) {
        case 'episodic':
          this.episodic = data as MemoryEntry[];
          break;
        case 'semantic': {
          const entries = data as [string, KnowledgeEntry][];
          this.semantic = new Map(entries);
          break;
        }
        case 'procedural':
          this.procedural = data as ProceduralRule[];
          break;
      }
    } catch {
      // File doesn't exist, start fresh
    }
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
