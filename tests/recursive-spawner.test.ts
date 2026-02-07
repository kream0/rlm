import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RecursiveSpawner } from '../src/recursive-spawner.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { ContextStore } from '../src/context-store.js';
import { FunctionRegistry } from '../src/function-registry.js';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';

const TEST_DIR = resolve('.rlm-test-data-spawner');

function makeMockClient(result = 'Sub-agent result') {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{
          type: 'tool_use',
          id: 'call-1',
          name: 'return_result',
          input: { value: JSON.stringify(result) },
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 30 },
      })),
    },
  } as unknown as Anthropic;
}

describe('RecursiveSpawner', () => {
  let store: ContextStore;
  let registry: FunctionRegistry;
  let runtime: AgentRuntime;
  let spawner: RecursiveSpawner;
  let logs: string[];

  beforeEach(async () => {
    store = new ContextStore(TEST_DIR);
    await store.init();
    registry = new FunctionRegistry();
    logs = [];

    const client = makeMockClient();
    runtime = new AgentRuntime({
      store, registry, anthropicClient: client,
      onLog: (_id, msg) => logs.push(msg),
    });

    spawner = new RecursiveSpawner({
      runtime, store, registry,
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
      expect(usage.totalTokens).toBeGreaterThan(0);
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
      const errorClient = {
        messages: {
          create: vi.fn(async () => { throw new Error('Agent died'); }),
        },
      } as unknown as Anthropic;

      const errorRuntime = new AgentRuntime({
        store, registry, anthropicClient: errorClient,
      });
      const errorSpawner = new RecursiveSpawner({
        runtime: errorRuntime, store, registry,
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxDepth: 3, maxConcurrent: 2,
        onLog: (msg) => logs.push(msg),
      });

      const ref = await errorSpawner.spawn({ prompt: 'Fail', context: {} });
      const result = await store.resolve(ref);
      expect((result as Record<string, unknown>).error).toContain('Agent died');
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
});
