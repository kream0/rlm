import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RecursiveSpawner } from '../src/recursive-spawner.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { ContextStore } from '../src/context-store.js';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import type { LLMProvider } from '../src/types.js';

const TEST_DIR = resolve('.rlm-test-data-spawner');

function makeMockProvider(result = 'Sub-agent result'): LLMProvider {
  return {
    execute: vi.fn(async () => ({
      result: typeof result === 'string' ? result : JSON.stringify(result),
      costUsd: 0.01,
      durationMs: 100,
    })),
  };
}

describe('RecursiveSpawner', () => {
  let store: ContextStore;
  let runtime: AgentRuntime;
  let spawner: RecursiveSpawner;
  let logs: string[];

  beforeEach(async () => {
    store = new ContextStore(TEST_DIR);
    await store.init();
    logs = [];

    const provider = makeMockProvider();
    runtime = new AgentRuntime({
      store, provider,
      onLog: (_id, msg) => logs.push(msg),
    });

    spawner = new RecursiveSpawner({
      runtime, store,
      defaultModel: 'claude-sonnet-4-5-20250929',
      maxDepth: 3, maxConcurrent: 2,
      onLog: (msg) => logs.push(msg),
    });
  });

  afterEach(async () => {
    await store.clear();
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  describe('spawn', () => {
    it('should spawn a sub-agent and return result ref', async () => {
      const ref = await spawner.spawn({ prompt: 'Analyze', context: {} });
      expect(ref).toBeTruthy();
      expect(ref.key).toContain('sub-result-');
      expect(ref.type).toBe('result');
    });

    it('should pass context refs', async () => {
      await store.set('dataset', { values: [1, 2, 3] }, { type: 'json' });
      const dataRef = store.ref('dataset');
      const ref = await spawner.spawn({ prompt: 'Analyze', context: { data: dataRef } });
      expect(ref).toBeTruthy();
      const result = await store.resolve(ref);
      expect(result).toBeTruthy();
    });

    it('should throw on exceeding max depth', async () => {
      await expect(
        spawner.spawn({ prompt: 'Deep', context: {} }, undefined, 5)
      ).rejects.toThrow('Maximum recursion depth');
    });

    it('should use custom model', async () => {
      const ref = await spawner.spawn({
        prompt: 'Cheap model', context: {},
        model: 'claude-haiku-4-5-20251001',
      });
      expect(ref).toBeTruthy();
    });
  });

  describe('spawnMany', () => {
    it('should spawn multiple agents', async () => {
      const refs = await spawner.spawnMany([
        { prompt: 'Task 1', context: {} },
        { prompt: 'Task 2', context: {} },
      ]);
      expect(refs.length).toBe(2);
      expect(refs[0].key).toContain('sub-result-');
      expect(refs[1].key).toContain('sub-result-');
    });

    it('should handle empty array', async () => {
      const refs = await spawner.spawnMany([]);
      expect(refs.length).toBe(0);
    });
  });

  describe('merge', () => {
    it('should concatenate results', async () => {
      const r1 = await store.set('r1', 'Result one', { type: 'result' });
      const r2 = await store.set('r2', 'Result two', { type: 'result' });
      const merged = await spawner.merge([r1, r2], { type: 'concatenate' });
      const value = await store.resolve(merged);
      expect(value).toContain('Result one');
      expect(value).toContain('Result two');
    });

    it('should merge structured', async () => {
      const r1 = await store.set('r1', { count: 5 }, { type: 'result' });
      const r2 = await store.set('r2', { count: 10 }, { type: 'result' });
      const merged = await spawner.merge([r1, r2], { type: 'structured' });
      const value = await store.resolve(merged) as Record<string, unknown>;
      expect(value['r1']).toEqual({ count: 5 });
      expect(value['r2']).toEqual({ count: 10 });
    });

    it('should vote', async () => {
      const r1 = await store.set('r1', 'yes', { type: 'result' });
      const r2 = await store.set('r2', 'yes', { type: 'result' });
      const r3 = await store.set('r3', 'no', { type: 'result' });
      const merged = await spawner.merge([r1, r2, r3], { type: 'vote' });
      const value = await store.resolve(merged) as Record<string, unknown>;
      expect(value.winner).toBe('yes');
    });

    it('should summarize', async () => {
      const r1 = await store.set('r1', 'First finding', { type: 'result' });
      const r2 = await store.set('r2', 'Second finding', { type: 'result' });
      const merged = await spawner.merge([r1, r2], { type: 'summarize' });
      const value = await store.resolve(merged) as string;
      expect(value).toContain('Result 1');
      expect(value).toContain('Result 2');
    });

    it('should use custom merge fn', async () => {
      const r1 = await store.set('r1', 10, { type: 'result' });
      const r2 = await store.set('r2', 20, { type: 'result' });
      const merged = await spawner.merge([r1, r2], {
        type: 'custom',
        customMergeFn: async (results) => (results as number[]).reduce((a, b) => a + b, 0),
      });
      const value = await store.resolve(merged);
      expect(value).toBe(30);
    });

    it('should throw on custom without merge fn', async () => {
      const r1 = await store.set('r1', 'x', { type: 'result' });
      await expect(spawner.merge([r1], { type: 'custom' })).rejects.toThrow('customMergeFn');
    });
  });

  describe('getTree', () => {
    it('should return empty tree', () => {
      const tree = spawner.getTree();
      expect(tree.id).toBe('none');
      expect(tree.status).toBe('idle');
    });

    it('should track spawned agents', async () => {
      await spawner.spawn({ prompt: 'Root', context: {} });
      const tree = spawner.getTree();
      expect(tree.id).not.toBe('none');
      expect(tree.status).toBe('completed');
    });
  });

  describe('getTotalTokenUsage', () => {
    it('should aggregate tokens', async () => {
      await spawner.spawn({ prompt: 'Task', context: {} });
      const usage = spawner.getTotalTokenUsage();
      // Token usage is 0 because mock provider returns ExecutionResult without token info
      expect(usage.totalTokens).toBe(0);
    });
  });

  describe('getActiveCount', () => {
    it('should be 0 when idle', () => {
      expect(spawner.getActiveCount()).toBe(0);
    });
  });

  describe('reset', () => {
    it('should clear tracking', async () => {
      await spawner.spawn({ prompt: 'Task', context: {} });
      spawner.reset();
      expect(spawner.getTree().id).toBe('none');
      expect(spawner.getActiveCount()).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should handle agent failure', async () => {
      const errorProvider: LLMProvider = {
        execute: vi.fn(async () => { throw new Error('Agent died'); }),
      };

      const errorRuntime = new AgentRuntime({
        store, provider: errorProvider,
      });
      const errorSpawner = new RecursiveSpawner({
        runtime: errorRuntime, store,
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxDepth: 3, maxConcurrent: 2,
        onLog: (msg) => logs.push(msg),
      });

      const ref = await errorSpawner.spawn({ prompt: 'Fail', context: {} });
      const result = await store.resolve(ref);
      expect((result as Record<string, unknown>).error).toContain('Agent died');
    });
  });

  describe('timeout', () => {
    it('should timeout if agent takes too long', async () => {
      const slowProvider: LLMProvider = {
        execute: vi.fn(
          () => new Promise((resolve) =>
            setTimeout(() => resolve({ result: 'late' }), 5000)
          )
        ),
      };

      const slowRuntime = new AgentRuntime({
        store, provider: slowProvider,
      });
      const timeoutSpawner = new RecursiveSpawner({
        runtime: slowRuntime, store,
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxDepth: 5, maxConcurrent: 3,
        onLog: (msg) => logs.push(msg),
      });

      const ref = await timeoutSpawner.spawn({
        prompt: 'slow task',
        context: {},
        timeout: 50, // 50ms timeout
      });

      const result = await store.resolve(ref);
      expect((result as Record<string, string>).error).toContain('timed out');
    });
  });

  describe('context isolation', () => {
    it('should not pollute parent context', async () => {
      const before = (await store.list()).length;
      await spawner.spawn({ prompt: 'Work', context: {} });
      const after = (await store.list()).length;
      expect(after - before).toBeLessThanOrEqual(2);
    });
  });

  describe('context manifest (4.1)', () => {
    it('should create a manifest file when context is provided', async () => {
      await store.set('dataset', { values: [1, 2, 3] }, { type: 'json' });
      const dataRef = store.ref('dataset');

      const provider = makeMockProvider();
      const rt = new AgentRuntime({
        store, provider,
        onLog: (_id, msg) => logs.push(msg),
      });
      const sp = new RecursiveSpawner({
        runtime: rt, store,
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxDepth: 3, maxConcurrent: 2,
        onLog: (msg) => logs.push(msg),
      });

      await sp.spawn({ prompt: 'Analyze data', context: { data: dataRef } });

      // The prompt should contain 'Context manifest' instead of per-variable expansion
      const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executeCall.prompt).toContain('Context manifest: Read');
      expect(executeCall.prompt).toContain('filePath');
    });

    it('should not add manifest when context is empty', async () => {
      const provider = makeMockProvider();
      const rt = new AgentRuntime({
        store, provider,
        onLog: (_id, msg) => logs.push(msg),
      });
      const sp = new RecursiveSpawner({
        runtime: rt, store,
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxDepth: 3, maxConcurrent: 2,
        onLog: (msg) => logs.push(msg),
      });

      await sp.spawn({ prompt: 'No context', context: {} });

      const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executeCall.prompt).not.toContain('Context manifest');
    });

    it('should persist manifest as a JSON file on disk', async () => {
      await store.set('doc', 'Hello world', { type: 'text' });
      const docRef = store.ref('doc');

      await spawner.spawn({ prompt: 'Read doc', context: { document: docRef } });

      // Check that a manifest variable was created
      const vars = await store.list({ type: 'json' });
      const manifestVar = vars.find(v => v.key.startsWith('manifest-'));
      expect(manifestVar).toBeTruthy();
    });
  });

  describe('decompose (4.3)', () => {
    it('should split a large variable into chunks and merge results', async () => {
      const sourceRef = await store.set('big-text', 'AAABBBCCC', { type: 'text' });

      const ref = await spawner.decompose({
        prompt: 'Summarize this chunk',
        sourceRef,
        chunks: 3,
        mergeStrategy: { type: 'concatenate' },
      });

      expect(ref).toBeTruthy();
      const merged = await store.resolve(ref);
      expect(typeof merged).toBe('string');
      // Merged result should contain the sub-agent results (all return "Sub-agent result")
      expect(merged).toContain('Sub-agent result');
    });

    it('should create chunk variables in the store', async () => {
      const sourceRef = await store.set('source-data', 'Hello World!!!!', { type: 'text' });

      await spawner.decompose({
        prompt: 'Process chunk',
        sourceRef,
        chunks: 2,
        mergeStrategy: { type: 'concatenate' },
      });

      // Check chunk variables were created
      expect(store.has('chunk-source-data-0')).toBe(true);
      expect(store.has('chunk-source-data-1')).toBe(true);
    });

    it('should use the specified merge strategy', async () => {
      const sourceRef = await store.set('data', 'AABB', { type: 'text' });

      const ref = await spawner.decompose({
        prompt: 'Analyze',
        sourceRef,
        chunks: 2,
        mergeStrategy: { type: 'structured' },
      });

      const value = await store.resolve(ref) as Record<string, unknown>;
      // Structured merge uses ref keys as object keys
      const keys = Object.keys(value);
      expect(keys.length).toBe(2);
    });

    it('should handle JSON source values', async () => {
      const sourceRef = await store.set('json-data', { items: [1, 2, 3, 4] }, { type: 'json' });

      const ref = await spawner.decompose({
        prompt: 'Process',
        sourceRef,
        chunks: 2,
        mergeStrategy: { type: 'concatenate' },
      });

      expect(ref).toBeTruthy();
      const merged = await store.resolve(ref);
      expect(merged).toContain('Sub-agent result');
    });
  });

  describe('token budget (4.4)', () => {
    it('should throw when token budget is exhausted', async () => {
      const tokenProvider: LLMProvider = {
        execute: vi.fn(async () => ({
          result: 'Done',
          tokenUsage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
        })),
      };

      const tokenRuntime = new AgentRuntime({
        store, provider: tokenProvider,
      });

      const budgetSpawner = new RecursiveSpawner({
        runtime: tokenRuntime, store,
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxDepth: 5, maxConcurrent: 3,
        tokenBudget: 1000,
        onLog: (msg) => logs.push(msg),
      });

      // First spawn uses 700 tokens (under budget of 1000)
      await budgetSpawner.spawn({ prompt: 'Task 1', context: {} });
      expect(budgetSpawner.getTotalTokensUsed()).toBe(700);

      // Second spawn uses 700 more, but the budget check happens before the spawn
      // After 1st spawn: 700 used. Budget = 1000. 700 < 1000, so second spawn starts.
      // After 2nd spawn: 1400 used.
      await budgetSpawner.spawn({ prompt: 'Task 2', context: {} });
      expect(budgetSpawner.getTotalTokensUsed()).toBe(1400);

      // Third spawn should fail because 1400 >= 1000
      await expect(
        budgetSpawner.spawn({ prompt: 'Task 3', context: {} })
      ).rejects.toThrow('Token budget exhausted');
    });

    it('should track total tokens used', async () => {
      const tokenProvider: LLMProvider = {
        execute: vi.fn(async () => ({
          result: 'Done',
          tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        })),
      };

      const tokenRuntime = new AgentRuntime({
        store, provider: tokenProvider,
      });

      const budgetSpawner = new RecursiveSpawner({
        runtime: tokenRuntime, store,
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxDepth: 5, maxConcurrent: 3,
        onLog: (msg) => logs.push(msg),
      });

      expect(budgetSpawner.getTotalTokensUsed()).toBe(0);

      await budgetSpawner.spawn({ prompt: 'Task', context: {} });
      expect(budgetSpawner.getTotalTokensUsed()).toBe(150);

      await budgetSpawner.spawn({ prompt: 'Task 2', context: {} });
      expect(budgetSpawner.getTotalTokensUsed()).toBe(300);
    });

    it('should reset total tokens used on reset()', async () => {
      const tokenProvider: LLMProvider = {
        execute: vi.fn(async () => ({
          result: 'Done',
          tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        })),
      };

      const tokenRuntime = new AgentRuntime({
        store, provider: tokenProvider,
      });

      const budgetSpawner = new RecursiveSpawner({
        runtime: tokenRuntime, store,
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxDepth: 5, maxConcurrent: 3,
        tokenBudget: 500,
        onLog: (msg) => logs.push(msg),
      });

      await budgetSpawner.spawn({ prompt: 'Task', context: {} });
      expect(budgetSpawner.getTotalTokensUsed()).toBe(150);

      budgetSpawner.reset();
      expect(budgetSpawner.getTotalTokensUsed()).toBe(0);
    });

    it('should allow unlimited spawns with no budget set', async () => {
      const tokenProvider: LLMProvider = {
        execute: vi.fn(async () => ({
          result: 'Done',
          tokenUsage: { inputTokens: 100000, outputTokens: 50000, totalTokens: 150000 },
        })),
      };

      const tokenRuntime = new AgentRuntime({
        store, provider: tokenProvider,
      });

      const noBudgetSpawner = new RecursiveSpawner({
        runtime: tokenRuntime, store,
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxDepth: 5, maxConcurrent: 3,
        // No tokenBudget set - defaults to Infinity
        onLog: (msg) => logs.push(msg),
      });

      // Should not throw even with high token usage
      await noBudgetSpawner.spawn({ prompt: 'Task 1', context: {} });
      await noBudgetSpawner.spawn({ prompt: 'Task 2', context: {} });
      expect(noBudgetSpawner.getTotalTokensUsed()).toBe(300000);
    });
  });
});
