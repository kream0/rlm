import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContextStore } from '../src/context-store.js';
import { FunctionRegistry } from '../src/function-registry.js';
import { MemoryManager } from '../src/memory-manager.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { RecursiveSpawner } from '../src/recursive-spawner.js';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import type { LLMProvider, ExecutionResult } from '../src/types.js';

const TEST_DIR = resolve('.rlm-test-data-integration');

describe('RLM Integration', () => {
  let store: ContextStore;
  let memory: MemoryManager;
  let registry: FunctionRegistry;
  let runtime: AgentRuntime;
  let spawner: RecursiveSpawner;

  beforeEach(async () => {
    store = new ContextStore(resolve(TEST_DIR, 'vars'));
    await store.init();
    memory = new MemoryManager(resolve(TEST_DIR, 'mem'));
    await memory.init();
    registry = new FunctionRegistry();
  });

  afterEach(async () => {
    await store.clear();
    await memory.clear();
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  describe('Store -> Agent -> Result', () => {
    it('should store data, run agent, get result', async () => {
      const dataRef = await store.set('input-data', {
        items: ['apple', 'banana', 'cherry'],
        metadata: { source: 'test' },
      }, { type: 'json' });

      expect(dataRef.type).toBe('json');

      const provider: LLMProvider = {
        execute: vi.fn(async () => ({
          result: 'Analysis complete. Found 3 items.',
          costUsd: 0.01,
        } as ExecutionResult)),
      };

      runtime = new AgentRuntime({ store, provider });

      const agent = runtime.create({
        id: 'int-agent', prompt: 'Analyze input-data',
        model: 'claude-sonnet-4-5-20250929', contextRef: dataRef,
      });

      const result = await runtime.run(agent);
      expect(result.iterations).toBe(1);
      expect(result.result).toContain('Analysis complete');
    });

    it('should log agent execution to episodic memory', async () => {
      const provider: LLMProvider = {
        execute: vi.fn(async () => ({
          result: 'Analysis done',
        } as ExecutionResult)),
      };

      runtime = new AgentRuntime({ store, provider, memory });
      const agent = runtime.create({
        id: 'mem-agent', prompt: 'Analyze data', model: 'opus',
      });
      await runtime.run(agent);

      const episodic = memory.getEpisodicMemory();
      expect(episodic.length).toBeGreaterThan(0);
      expect(
        episodic.some(e => e.metadata?.agentId === 'mem-agent')
      ).toBe(true);
    });

    it('should log agent failure to episodic memory', async () => {
      const errorProvider: LLMProvider = {
        execute: vi.fn(async () => { throw new Error('Provider failure'); }),
      };

      runtime = new AgentRuntime({ store, provider: errorProvider, memory });
      const agent = runtime.create({
        id: 'fail-agent', prompt: 'This will fail', model: 'opus',
      });
      await runtime.run(agent);

      const episodic = memory.getEpisodicMemory();
      expect(episodic.length).toBeGreaterThan(0);
      const failEntry = episodic.find(e => e.metadata?.agentId === 'fail-agent');
      expect(failEntry).toBeDefined();
      expect(failEntry!.metadata?.status).toBe('failed');
      expect(failEntry!.content).toContain('Provider failure');
    });
  });

  describe('Memory lifecycle', () => {
    it('should maintain memory across operations', async () => {
      for (let i = 0; i < 5; i++) {
        await memory.append('episodic', {
          id: `iter-${i}`, timestamp: Date.now() + i * 1000,
          content: `Iteration ${i}: Processed batch ${i * 100}-${(i + 1) * 100}`,
          metadata: { iteration: i, batchSize: 100 },
        });
      }

      await memory.learn({ key: 'batch-pattern', value: 'Batches of 100 process optimally' });

      const relevant = await memory.search('episodic', 'batch');
      expect(relevant.length).toBeGreaterThan(0);

      const knowledge = await memory.recall('batch-pattern');
      expect(knowledge).toBeTruthy();
      expect(knowledge!.value).toContain('100');

      await memory.compact('episodic', { keepLast: 2, summarizeOlder: true });
      expect(memory.getEpisodicMemory().length).toBe(3);

      const stats = memory.getStats();
      expect(stats.episodicEntryCount).toBe(3);
      expect(stats.semanticEntryCount).toBe(1);
    });
  });

  describe('Pass-by-reference', () => {
    it('should pass large data by reference', async () => {
      const largeData = 'x'.repeat(100_000);
      const ref = await store.set('large-data', largeData, { type: 'text' });

      const refSize = JSON.stringify(ref).length;
      expect(refSize).toBeLessThan(300);
      expect(ref.sizeBytes).toBeGreaterThan(99_000);

      const summary = await store.summarize('large-data', 50);
      expect(summary.length).toBeLessThan(1000);
      expect(summary).toContain('truncated');

      const resolved = await store.resolve(ref);
      expect((resolved as string).length).toBe(100_000);
    });
  });

  describe('Merge strategies', () => {
    it('should fan-out and merge', async () => {
      const r1 = await store.set('a-1', { findings: ['A', 'B'] }, { type: 'result' });
      const r2 = await store.set('a-2', { findings: ['C'] }, { type: 'result' });
      const r3 = await store.set('a-3', { findings: ['D', 'E'] }, { type: 'result' });

      const provider: LLMProvider = {
        execute: vi.fn(async () => ({
          result: 'Done',
        } as ExecutionResult)),
      };

      runtime = new AgentRuntime({ store, provider });
      spawner = new RecursiveSpawner({
        runtime, store,
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxDepth: 5, maxConcurrent: 3,
      });

      const merged = await spawner.merge([r1, r2, r3], { type: 'structured' });
      const value = await store.resolve(merged) as Record<string, unknown>;
      expect(value['a-1']).toEqual({ findings: ['A', 'B'] });
      expect(value['a-2']).toEqual({ findings: ['C'] });
      expect(value['a-3']).toEqual({ findings: ['D', 'E'] });

      const customMerged = await spawner.merge([r1, r2, r3], {
        type: 'custom',
        customMergeFn: async (results) => {
          const all = (results as Array<{ findings: string[] }>).flatMap((r) => r.findings);
          return { totalFindings: all.length, all };
        },
      });
      const cv = await store.resolve(customMerged) as { totalFindings: number; all: string[] };
      expect(cv.totalFindings).toBe(5);
      expect(cv.all).toEqual(['A', 'B', 'C', 'D', 'E']);
    });
  });

  describe('Full pipeline', () => {
    it('should run complete RLM pipeline', async () => {
      const input = await store.set('document', 'This is a long document about AI...', { type: 'text' });

      await memory.append('episodic', {
        id: 'e1', timestamp: Date.now(),
        content: 'Loaded document for analysis',
      });

      const vars = await store.list();
      expect(vars.length).toBe(1);
      expect(vars[0].key).toBe('document');

      expect(memory.getStats().episodicEntryCount).toBe(1);
      expect(registry.list().length).toBe(0);

      const docRef = store.ref('document');
      expect(JSON.stringify(docRef).length).toBeLessThan(300);
    });
  });

  describe('Performance', () => {
    it('should handle 100 variable ops efficiently', async () => {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        await store.set(`var-${i}`, `value-${i}`.repeat(100));
      }
      for (let i = 0; i < 100; i++) {
        store.ref(`var-${i}`);
      }
      const list = await store.list();
      expect(list.length).toBe(100);
      expect(performance.now() - start).toBeLessThan(2000);
    });

    it('should handle 500 memory ops efficiently', async () => {
      const start = performance.now();
      for (let i = 0; i < 500; i++) {
        await memory.append('working', {
          id: `w${i}`, timestamp: Date.now(),
          content: `Working memory entry ${i}`,
        });
      }
      const results = await memory.search('working', 'memory entry');
      expect(results.length).toBeGreaterThan(0);
      expect(performance.now() - start).toBeLessThan(3000);
    });
  });
});
