import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryManager } from '../src/memory-manager.js';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';

const TEST_DIR = resolve('.rlm-test-data-memory');

describe('MemoryManager', () => {
  let memory: MemoryManager;

  beforeEach(async () => {
    memory = new MemoryManager(TEST_DIR, 10);
    await memory.init();
  });

  afterEach(async () => {
    await memory.clear();
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  describe('append', () => {
    it('should append to working memory', async () => {
      await memory.append('working', { id: 'w1', timestamp: Date.now(), content: 'Test observation' });
      const entries = memory.getWorkingMemory();
      expect(entries.length).toBe(1);
      expect(entries[0].content).toBe('Test observation');
    });

    it('should auto-compact working memory over limit', async () => {
      for (let i = 0; i < 15; i++) {
        await memory.append('working', { id: `w${i}`, timestamp: Date.now(), content: `Entry ${i}` });
      }
      expect(memory.getWorkingMemory().length).toBe(10);
    });

    it('should append to episodic memory', async () => {
      await memory.append('episodic', { id: 'e1', timestamp: Date.now(), content: 'Completed task X', metadata: { task: 'X' } });
      expect(memory.getEpisodicMemory().length).toBe(1);
      expect(memory.getEpisodicMemory()[0].content).toBe('Completed task X');
    });

    it('should auto-assign id and timestamp', async () => {
      await memory.append('working', { id: '', timestamp: 0, content: 'auto' });
      const entries = memory.getWorkingMemory();
      expect(entries[0].id).toBeTruthy();
      expect(entries[0].timestamp).toBeGreaterThan(0);
    });

    it('should append to semantic memory', async () => {
      await memory.append('semantic', { id: 'k1', timestamp: Date.now(), content: 'Python is a language', metadata: { key: 'python-def' } });
      const recalled = await memory.recall('python-def');
      expect(recalled).toBeTruthy();
      expect(recalled!.value).toBe('Python is a language');
    });

    it('should append to procedural memory', async () => {
      await memory.append('procedural', { id: 'p1', timestamp: Date.now(), content: 'Run tests before committing', metadata: { condition: 'before commit' } });
      expect(memory.getStats().proceduralRuleCount).toBe(1);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await memory.append('working', { id: 'w1', timestamp: Date.now() - 3000, content: 'Analyzed the dataset for anomalies' });
      await memory.append('working', { id: 'w2', timestamp: Date.now() - 2000, content: 'Found 3 patterns in the code' });
      await memory.append('working', { id: 'w3', timestamp: Date.now() - 1000, content: 'Dataset analysis revealed correlation' });
      await memory.append('working', { id: 'w4', timestamp: Date.now(), content: 'Wrote test cases for validation' });
    });

    it('should find relevant entries', async () => {
      const results = await memory.search('working', 'dataset');
      expect(results.length).toBe(2);
    });

    it('should rank by relevance', async () => {
      const results = await memory.search('working', 'dataset analysis');
      expect(results[0].id).toBe('w3');
    });

    it('should respect limit', async () => {
      const results = await memory.search('working', 'the', 1);
      expect(results.length).toBe(1);
    });

    it('should return empty for no matches', async () => {
      const results = await memory.search('working', 'xyz_nonexistent');
      expect(results.length).toBe(0);
    });

    it('should search semantic memory', async () => {
      await memory.learn({ key: 'api-key', value: 'API key should be stored securely' });
      await memory.learn({ key: 'db-schema', value: 'Database schema includes users table' });
      const results = await memory.search('semantic', 'API');
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('API');
    });
  });

  describe('learn/recall', () => {
    it('should learn and recall', async () => {
      await memory.learn({ key: 'pattern-1', value: 'Use DI for testability' });
      const k = await memory.recall('pattern-1');
      expect(k).toBeTruthy();
      expect(k!.key).toBe('pattern-1');
      expect(k!.value).toBe('Use DI for testability');
    });

    it('should return null for unknown', async () => {
      expect(await memory.recall('unknown')).toBeNull();
    });

    it('should overwrite', async () => {
      await memory.learn({ key: 'fact', value: 'V1' });
      await memory.learn({ key: 'fact', value: 'V2' });
      expect((await memory.recall('fact'))!.value).toBe('V2');
    });

    it('should assign timestamp', async () => {
      await memory.learn({ key: 'timed', value: 'Has timestamp' });
      expect((await memory.recall('timed'))!.timestamp).toBeGreaterThan(0);
    });
  });

  describe('compact', () => {
    it('should compact working memory with summary', async () => {
      for (let i = 0; i < 20; i++) {
        await memory.append('working', { id: `w${i}`, timestamp: Date.now() + i, content: `Working entry ${i}` });
      }
      await memory.compact('working', { keepLast: 5, summarizeOlder: true });
      const entries = memory.getWorkingMemory();
      expect(entries.length).toBe(6); // 1 summary + 5 kept
      expect(entries[0].content).toContain('Summary');
    });

    it('should compact without summarizing', async () => {
      for (let i = 0; i < 20; i++) {
        await memory.append('working', { id: `w${i}`, timestamp: Date.now() + i, content: `Entry ${i}` });
      }
      await memory.compact('working', { keepLast: 5, summarizeOlder: false });
      expect(memory.getWorkingMemory().length).toBe(5);
    });

    it('should not compact when under limit', async () => {
      await memory.append('working', { id: 'w1', timestamp: Date.now(), content: 'Single entry' });
      await memory.compact('working', { keepLast: 5 });
      expect(memory.getWorkingMemory().length).toBe(1);
    });

    it('should compact episodic memory', async () => {
      for (let i = 0; i < 20; i++) {
        await memory.append('episodic', { id: `e${i}`, timestamp: Date.now() + i, content: `Episodic entry ${i}` });
      }
      await memory.compact('episodic', { keepLast: 3, summarizeOlder: true });
      expect(memory.getEpisodicMemory().length).toBe(4);
    });
  });

  describe('getStats', () => {
    it('should return correct stats', async () => {
      await memory.append('working', { id: 'w1', timestamp: Date.now(), content: 'Working' });
      await memory.append('episodic', { id: 'e1', timestamp: Date.now(), content: 'Episodic' });
      await memory.learn({ key: 'k1', value: 'Knowledge' });
      await memory.append('procedural', { id: 'p1', timestamp: Date.now(), content: 'Procedure', metadata: { condition: 'always' } });

      const stats = memory.getStats();
      expect(stats.episodicEntryCount).toBe(1);
      expect(stats.semanticEntryCount).toBe(1);
      expect(stats.proceduralRuleCount).toBe(1);
      expect(stats.workingMemoryTokens).toBeGreaterThan(0);
      expect(stats.totalStorageBytes).toBeGreaterThan(0);
    });
  });

  describe('clear', () => {
    it('should clear all', async () => {
      await memory.append('working', { id: 'w1', timestamp: Date.now(), content: 'W' });
      await memory.append('episodic', { id: 'e1', timestamp: Date.now(), content: 'E' });
      await memory.learn({ key: 'k1', value: 'K' });
      await memory.clear();
      const stats = memory.getStats();
      expect(stats.episodicEntryCount).toBe(0);
      expect(stats.semanticEntryCount).toBe(0);
      expect(stats.proceduralRuleCount).toBe(0);
    });

    it('should clear specific type', async () => {
      await memory.append('working', { id: 'w1', timestamp: Date.now(), content: 'W' });
      await memory.learn({ key: 'k1', value: 'K' });
      await memory.clear('working');
      expect(memory.getWorkingMemory().length).toBe(0);
      expect(await memory.recall('k1')).toBeTruthy();
    });
  });

  describe('persistence', () => {
    it('should persist episodic across instances', async () => {
      await memory.append('episodic', { id: 'e1', timestamp: Date.now(), content: 'Persistent episodic entry' });
      const memory2 = new MemoryManager(TEST_DIR);
      await memory2.init();
      const entries = memory2.getEpisodicMemory();
      expect(entries.length).toBe(1);
      expect(entries[0].content).toBe('Persistent episodic entry');
    });

    it('should persist semantic across instances', async () => {
      await memory.learn({ key: 'persistent-fact', value: 'This survives restart' });
      const memory2 = new MemoryManager(TEST_DIR);
      await memory2.init();
      const recalled = await memory2.recall('persistent-fact');
      expect(recalled).toBeTruthy();
      expect(recalled!.value).toBe('This survives restart');
    });
  });

  describe('performance', () => {
    it('should append quickly', async () => {
      const start = performance.now();
      for (let i = 0; i < 50; i++) {
        await memory.append('working', { id: `perf-${i}`, timestamp: Date.now(), content: `Entry ${i}` });
      }
      expect(performance.now() - start).toBeLessThan(500);
    });

    it('should search quickly', async () => {
      for (let i = 0; i < 100; i++) {
        await memory.append('episodic', { id: `s${i}`, timestamp: Date.now(), content: `Entry about topic ${i % 10} with detail ${i}` });
      }
      const start = performance.now();
      const results = await memory.search('episodic', 'topic 5');
      expect(performance.now() - start).toBeLessThan(100);
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
