import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RecursiveSpawner } from '../src/recursive-spawner.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { ContextStore } from '../src/context-store.js';
import { resolve } from 'node:path';
import { rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

  describe('manifest-based context passing', () => {
    it('should create a valid JSON file on disk', async () => {
      await store.set('doc', 'Hello world', { type: 'text' });
      const docRef = store.ref('doc');

      await spawner.spawn({ prompt: 'Read doc', context: { document: docRef } });

      // Find the manifest variable in the store
      const vars = await store.list({ type: 'json' });
      const manifestVar = vars.find(v => v.key.startsWith('manifest-'));
      expect(manifestVar).toBeTruthy();

      // Read the manifest file from disk and verify it is valid JSON
      const manifestPath = store.getFilePath(manifestVar!.key);
      expect(existsSync(manifestPath)).toBe(true);

      const rawContent = await readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(rawContent);
      // The file on disk has the StoredVariable wrapper: { ref, value, persist }
      expect(parsed).toHaveProperty('value');
      expect(parsed.value).toHaveProperty('document');
    });

    it('should contain correct variable paths, sizes, and types', async () => {
      await store.set('dataset', { values: [1, 2, 3] }, { type: 'json' });
      const dataRef = store.ref('dataset');

      await spawner.spawn({ prompt: 'Analyze', context: { data: dataRef } });

      // Retrieve the manifest value from the store
      const vars = await store.list({ type: 'json' });
      const manifestVar = vars.find(v => v.key.startsWith('manifest-'));
      expect(manifestVar).toBeTruthy();

      const manifestValue = await store.get(manifestVar!.key) as Record<
        string,
        { filePath: string; sizeBytes: number; type: string }
      >;

      // Verify structure for the 'data' entry
      expect(manifestValue).toHaveProperty('data');
      const entry = manifestValue['data'];
      expect(entry.filePath).toBeTruthy();
      expect(typeof entry.filePath).toBe('string');
      expect(entry.filePath).toContain('.json');
      expect(entry.sizeBytes).toBe(dataRef.sizeBytes);
      expect(entry.type).toBe('json');

      // The file pointed to by filePath should exist on disk
      expect(existsSync(entry.filePath)).toBe(true);
    });

    it('should include manifest file reference in the prompt', async () => {
      await store.set('code', 'function hello() {}', { type: 'text' });
      const codeRef = store.ref('code');

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

      await sp.spawn({ prompt: 'Review code', context: { source: codeRef } });

      const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // Prompt should contain the manifest reference instruction
      expect(executeCall.prompt).toContain('Context manifest: Read');
      // Prompt should contain instructions about how to use the manifest
      expect(executeCall.prompt).toContain('filePath');
      expect(executeCall.prompt).toContain('sizeBytes');
      expect(executeCall.prompt).toContain('value');
      // The original prompt should still be present
      expect(executeCall.prompt).toContain('Review code');
    });

    it('should return null manifest for empty context (no manifest in prompt)', async () => {
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

      await sp.spawn({ prompt: 'No context task', context: {} });

      const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executeCall.prompt).not.toContain('Context manifest');
      expect(executeCall.prompt).toBe('No context task');

      // No manifest variable should be created
      const vars = await store.list({ type: 'json' });
      const manifestVar = vars.find(v => v.key.startsWith('manifest-'));
      expect(manifestVar).toBeUndefined();
    });

    it('should handle multiple variables of different types', async () => {
      await store.set('text-var', 'plain text content', { type: 'text' });
      await store.set('json-var', { nested: { key: 'value' } }, { type: 'json' });
      await store.set('result-var', { output: 'computed result' }, { type: 'result' });

      const textRef = store.ref('text-var');
      const jsonRef = store.ref('json-var');
      const resultRef = store.ref('result-var');

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

      await sp.spawn({
        prompt: 'Process all data',
        context: {
          text: textRef,
          data: jsonRef,
          previous: resultRef,
        },
      });

      // Find the manifest
      const vars = await store.list({ type: 'json' });
      const manifestVar = vars.find(v => v.key.startsWith('manifest-'));
      expect(manifestVar).toBeTruthy();

      const manifestValue = await store.get(manifestVar!.key) as Record<
        string,
        { filePath: string; sizeBytes: number; type: string }
      >;

      // All three context variables should be in the manifest
      expect(Object.keys(manifestValue)).toHaveLength(3);
      expect(manifestValue).toHaveProperty('text');
      expect(manifestValue).toHaveProperty('data');
      expect(manifestValue).toHaveProperty('previous');

      // Each entry should have the correct type
      expect(manifestValue['text'].type).toBe('text');
      expect(manifestValue['data'].type).toBe('json');
      expect(manifestValue['previous'].type).toBe('result');

      // Each entry should have valid sizeBytes (> 0)
      expect(manifestValue['text'].sizeBytes).toBeGreaterThan(0);
      expect(manifestValue['data'].sizeBytes).toBeGreaterThan(0);
      expect(manifestValue['previous'].sizeBytes).toBeGreaterThan(0);

      // Each entry should have a file path that exists on disk
      for (const entry of Object.values(manifestValue)) {
        expect(existsSync(entry.filePath)).toBe(true);
      }
    });

    it('should handle persist error gracefully with fallback entry', async () => {
      // Create a variable but manually remove it from the store so persistForSubAgent fails
      await store.set('ephemeral', 'temporary data', { type: 'text' });
      const ephemeralRef = store.ref('ephemeral');

      // Delete the variable so persistForSubAgent will throw
      await store.delete('ephemeral');

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

      // Should not throw - should handle error gracefully
      await sp.spawn({
        prompt: 'Use missing data',
        context: { missing: ephemeralRef },
      });

      // The manifest should still be created with a fallback entry
      const vars = await store.list({ type: 'json' });
      const manifestVar = vars.find(v => v.key.startsWith('manifest-'));
      expect(manifestVar).toBeTruthy();

      const manifestValue = await store.get(manifestVar!.key) as Record<
        string,
        { filePath: string; sizeBytes: number; type: string }
      >;

      expect(manifestValue).toHaveProperty('missing');
      expect(manifestValue['missing'].filePath).toBe('[not available]');
      expect(manifestValue['missing'].sizeBytes).toBe(0);

      // A warning should have been logged
      const warningLog = logs.find(l => l.includes('Warning'));
      expect(warningLog).toBeTruthy();
    });

    it('should store manifest with correct key format', async () => {
      await store.set('item', 'test value', { type: 'text' });
      const itemRef = store.ref('item');

      await spawner.spawn({ prompt: 'Process', context: { item: itemRef } });

      // The manifest key should follow the format manifest-{agentId}
      const vars = await store.list({ type: 'json' });
      const manifestVar = vars.find(v => v.key.startsWith('manifest-'));
      expect(manifestVar).toBeTruthy();
      // The key format should be manifest-{uuid}
      expect(manifestVar!.key).toMatch(/^manifest-[0-9a-f-]{36}$/);
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

  describe('decompose', () => {
    describe('basic chunking', () => {
      it('should split input into exactly N chunks of roughly equal size', async () => {
        // 12 chars, 3 chunks => ceil(12/3) = 4 chars each
        const sourceRef = await store.set('even-text', 'aabbccddeeFF', { type: 'text' });

        await spawner.decompose({
          prompt: 'Process chunk',
          sourceRef,
          chunks: 3,
          mergeStrategy: { type: 'concatenate' },
        });

        const chunk0 = await store.get('chunk-even-text-0') as string;
        const chunk1 = await store.get('chunk-even-text-1') as string;
        const chunk2 = await store.get('chunk-even-text-2') as string;

        expect(chunk0).toBe('aabb');
        expect(chunk1).toBe('ccdd');
        expect(chunk2).toBe('eeFF');
      });

      it('should handle uneven splits with last chunk being smaller', async () => {
        // 10 chars, 3 chunks => ceil(10/3) = 4 chars each, last chunk = 2 chars
        const sourceRef = await store.set('uneven-text', '0123456789', { type: 'text' });

        await spawner.decompose({
          prompt: 'Process chunk',
          sourceRef,
          chunks: 3,
          mergeStrategy: { type: 'concatenate' },
        });

        const chunk0 = await store.get('chunk-uneven-text-0') as string;
        const chunk1 = await store.get('chunk-uneven-text-1') as string;
        const chunk2 = await store.get('chunk-uneven-text-2') as string;

        expect(chunk0).toBe('0123');
        expect(chunk1).toBe('4567');
        expect(chunk2).toBe('89');
        // All chunks concatenated should equal the original
        expect(chunk0 + chunk1 + chunk2).toBe('0123456789');
      });

      it('should spawn exactly N sub-agents for N chunks', async () => {
        const provider = makeMockProvider();
        const rt = new AgentRuntime({
          store, provider,
          onLog: (_id, msg) => logs.push(msg),
        });
        const sp = new RecursiveSpawner({
          runtime: rt, store,
          defaultModel: 'claude-sonnet-4-5-20250929',
          maxDepth: 5, maxConcurrent: 10,
          onLog: (msg) => logs.push(msg),
        });

        const sourceRef = await store.set('spawn-count-text', 'ABCDEFGHIJKLMNOP', { type: 'text' });

        await sp.decompose({
          prompt: 'Analyze chunk',
          sourceRef,
          chunks: 4,
          mergeStrategy: { type: 'concatenate' },
        });

        // Provider.execute should have been called exactly 4 times (once per chunk)
        expect(provider.execute).toHaveBeenCalledTimes(4);
      });

      it('should pass each chunk as context to sub-agents', async () => {
        const provider = makeMockProvider();
        const rt = new AgentRuntime({
          store, provider,
          onLog: (_id, msg) => logs.push(msg),
        });
        const sp = new RecursiveSpawner({
          runtime: rt, store,
          defaultModel: 'claude-sonnet-4-5-20250929',
          maxDepth: 5, maxConcurrent: 10,
          onLog: (msg) => logs.push(msg),
        });

        const sourceRef = await store.set('ctx-text', 'XXYYZZ', { type: 'text' });

        await sp.decompose({
          prompt: 'Read the chunk',
          sourceRef,
          chunks: 3,
          mergeStrategy: { type: 'concatenate' },
        });

        // Each sub-agent prompt should contain the original prompt
        const calls = (provider.execute as ReturnType<typeof vi.fn>).mock.calls;
        for (const call of calls) {
          expect(call[0].prompt).toContain('Read the chunk');
          // Should also contain manifest reference (since context has a chunk ref)
          expect(call[0].prompt).toContain('Context manifest');
        }
      });

      it('should convert JSON source values to string before chunking', async () => {
        const jsonObj = { a: 1, b: 2, c: 3 };
        const sourceRef = await store.set('json-src', jsonObj, { type: 'json' });

        await spawner.decompose({
          prompt: 'Process',
          sourceRef,
          chunks: 2,
          mergeStrategy: { type: 'concatenate' },
        });

        const chunk0 = await store.get('chunk-json-src-0') as string;
        const chunk1 = await store.get('chunk-json-src-1') as string;

        // Combined chunks should reconstruct the JSON string
        const combined = chunk0 + chunk1;
        expect(combined).toBe(JSON.stringify(jsonObj));
      });
    });

    describe('merge strategy application', () => {
      it('should apply concatenate strategy to decompose results', async () => {
        const sourceRef = await store.set('concat-src', 'AAABBB', { type: 'text' });

        const ref = await spawner.decompose({
          prompt: 'Summarize',
          sourceRef,
          chunks: 2,
          mergeStrategy: { type: 'concatenate' },
        });

        const merged = await store.resolve(ref) as string;
        // Concatenate joins with \n---\n separator
        expect(merged).toContain('Sub-agent result');
        expect(merged).toContain('---');
      });

      it('should apply structured strategy to decompose results', async () => {
        const sourceRef = await store.set('struct-src', 'AABBCC', { type: 'text' });

        const ref = await spawner.decompose({
          prompt: 'Analyze',
          sourceRef,
          chunks: 3,
          mergeStrategy: { type: 'structured' },
        });

        const value = await store.resolve(ref) as Record<string, unknown>;
        const keys = Object.keys(value);
        expect(keys.length).toBe(3);
        // Each key maps to a sub-agent result
        for (const key of keys) {
          expect(value[key]).toBe('Sub-agent result');
        }
      });

      it('should apply vote strategy to decompose results', async () => {
        const sourceRef = await store.set('vote-src', 'AABB', { type: 'text' });

        const ref = await spawner.decompose({
          prompt: 'Classify',
          sourceRef,
          chunks: 2,
          mergeStrategy: { type: 'vote' },
        });

        const value = await store.resolve(ref) as { winner: unknown; votes: Record<string, unknown> };
        // Both sub-agents return same result, so winner is "Sub-agent result"
        expect(value.winner).toBe('Sub-agent result');
      });

      it('should apply summarize strategy to decompose results', async () => {
        const sourceRef = await store.set('summ-src', 'AABB', { type: 'text' });

        const ref = await spawner.decompose({
          prompt: 'Summarize',
          sourceRef,
          chunks: 2,
          mergeStrategy: { type: 'summarize' },
        });

        const value = await store.resolve(ref) as string;
        expect(value).toContain('Result 1');
        expect(value).toContain('Result 2');
      });

      it('should apply custom merge function to decompose results', async () => {
        const sourceRef = await store.set('custom-src', 'AABB', { type: 'text' });

        const ref = await spawner.decompose({
          prompt: 'Count',
          sourceRef,
          chunks: 2,
          mergeStrategy: {
            type: 'custom',
            customMergeFn: async (results) => ({
              count: results.length,
              combined: (results as string[]).join(' + '),
            }),
          },
        });

        const value = await store.resolve(ref) as { count: number; combined: string };
        expect(value.count).toBe(2);
        expect(value.combined).toContain('Sub-agent result');
      });
    });

    describe('edge cases', () => {
      it('should handle empty string input', async () => {
        const sourceRef = await store.set('empty-text', '', { type: 'text' });

        const ref = await spawner.decompose({
          prompt: 'Process',
          sourceRef,
          chunks: 3,
          mergeStrategy: { type: 'concatenate' },
        });

        // With empty string, chunkSize = ceil(0/3) = 0, loop still runs 3 times
        // slice(0,0) produces empty strings
        expect(ref).toBeTruthy();
        const merged = await store.resolve(ref);
        expect(typeof merged).toBe('string');
      });

      it('should handle single chunk (chunks=1)', async () => {
        const sourceRef = await store.set('single-chunk', 'Hello World', { type: 'text' });

        await spawner.decompose({
          prompt: 'Process',
          sourceRef,
          chunks: 1,
          mergeStrategy: { type: 'concatenate' },
        });

        // With 1 chunk, the entire source should be in chunk 0
        const chunk0 = await store.get('chunk-single-chunk-0') as string;
        expect(chunk0).toBe('Hello World');
        // And no chunk-1 should exist
        expect(store.has('chunk-single-chunk-1')).toBe(false);
      });

      it('should handle chunks count greater than input length', async () => {
        // 3 chars but requesting 10 chunks
        const sourceRef = await store.set('tiny-text', 'ABC', { type: 'text' });

        const provider = makeMockProvider();
        const rt = new AgentRuntime({
          store, provider,
          onLog: (_id, msg) => logs.push(msg),
        });
        const sp = new RecursiveSpawner({
          runtime: rt, store,
          defaultModel: 'claude-sonnet-4-5-20250929',
          maxDepth: 5, maxConcurrent: 10,
          onLog: (msg) => logs.push(msg),
        });

        const ref = await sp.decompose({
          prompt: 'Process',
          sourceRef,
          chunks: 10,
          mergeStrategy: { type: 'concatenate' },
        });

        expect(ref).toBeTruthy();

        // chunkSize = ceil(3/10) = 1, so first 3 chunks get one char each
        // remaining 7 chunks get empty strings
        const chunk0 = await store.get('chunk-tiny-text-0') as string;
        const chunk1 = await store.get('chunk-tiny-text-1') as string;
        const chunk2 = await store.get('chunk-tiny-text-2') as string;
        expect(chunk0).toBe('A');
        expect(chunk1).toBe('B');
        expect(chunk2).toBe('C');

        // All 10 sub-agents should have been spawned
        expect(provider.execute).toHaveBeenCalledTimes(10);
      });

      it('should handle null source value by stringifying it', async () => {
        const sourceRef = await store.set('null-val', null, { type: 'json' });

        const ref = await spawner.decompose({
          prompt: 'Process',
          sourceRef,
          chunks: 2,
          mergeStrategy: { type: 'concatenate' },
        });

        // null gets JSON.stringified to "null" (4 chars), split into 2 chunks
        expect(ref).toBeTruthy();
        const chunk0 = await store.get('chunk-null-val-0') as string;
        const chunk1 = await store.get('chunk-null-val-1') as string;
        expect(chunk0 + chunk1).toBe('null');
      });
    });

    describe('optional parameters', () => {
      it('should pass model override to sub-agents', async () => {
        const provider = makeMockProvider();
        const rt = new AgentRuntime({
          store, provider,
          onLog: (_id, msg) => logs.push(msg),
        });
        const sp = new RecursiveSpawner({
          runtime: rt, store,
          defaultModel: 'claude-sonnet-4-5-20250929',
          maxDepth: 5, maxConcurrent: 10,
          onLog: (msg) => logs.push(msg),
        });

        const sourceRef = await store.set('model-test', 'AABB', { type: 'text' });

        await sp.decompose({
          prompt: 'Analyze',
          sourceRef,
          chunks: 2,
          mergeStrategy: { type: 'concatenate' },
          model: 'claude-haiku-4-5-20251001',
        });

        // Provider should have been called with the overridden model
        const calls = (provider.execute as ReturnType<typeof vi.fn>).mock.calls;
        for (const call of calls) {
          expect(call[0].model).toBe('claude-haiku-4-5-20251001');
        }
      });

      it('should pass timeout to sub-agents', async () => {
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
          maxDepth: 5, maxConcurrent: 10,
          onLog: (msg) => logs.push(msg),
        });

        const sourceRef = await store.set('timeout-src', 'AABB', { type: 'text' });

        const ref = await timeoutSpawner.decompose({
          prompt: 'Process',
          sourceRef,
          chunks: 2,
          mergeStrategy: { type: 'concatenate' },
          timeout: 50,
        });

        // Sub-agents should have timed out; merged results should contain error
        const merged = await store.resolve(ref) as string;
        expect(merged).toContain('timed out');
      });

      it('should respect parentId for agent tracking', async () => {
        const sourceRef = await store.set('parent-test', 'AABB', { type: 'text' });

        await spawner.decompose({
          prompt: 'Process',
          sourceRef,
          chunks: 2,
          mergeStrategy: { type: 'concatenate' },
          parentId: 'fake-parent-id',
        });

        // The spawner log should mention spawning agents with a parent
        const parentLogs = logs.filter((l) => l.includes('parent: fake-parent-id'));
        expect(parentLogs.length).toBe(2);
      });

      it('should respect depth parameter for recursion tracking', async () => {
        // maxDepth is 3, so passing depth=2 should work but depth=3 should fail
        const sourceRef = await store.set('depth-test', 'AB', { type: 'text' });

        // depth=2 should work (2 < 3)
        const ref = await spawner.decompose({
          prompt: 'Process',
          sourceRef,
          chunks: 1,
          mergeStrategy: { type: 'concatenate' },
          depth: 2,
        });
        expect(ref).toBeTruthy();

        // depth=3 should fail (3 >= maxDepth of 3)
        const sourceRef2 = await store.set('depth-test-2', 'CD', { type: 'text' });
        await expect(
          spawner.decompose({
            prompt: 'Process',
            sourceRef: sourceRef2,
            chunks: 1,
            mergeStrategy: { type: 'concatenate' },
            depth: 3,
          })
        ).rejects.toThrow('Maximum recursion depth');
      });
    });

    describe('error handling', () => {
      it('should handle sub-agent failures gracefully during decompose', async () => {
        const errorProvider: LLMProvider = {
          execute: vi.fn(async () => { throw new Error('Chunk processing failed'); }),
        };

        const errorRuntime = new AgentRuntime({
          store, provider: errorProvider,
        });
        const errorSpawner = new RecursiveSpawner({
          runtime: errorRuntime, store,
          defaultModel: 'claude-sonnet-4-5-20250929',
          maxDepth: 5, maxConcurrent: 10,
          onLog: (msg) => logs.push(msg),
        });

        const sourceRef = await store.set('fail-text', 'AABBCC', { type: 'text' });

        // decompose should not throw - errors are captured per sub-agent
        const ref = await errorSpawner.decompose({
          prompt: 'Process',
          sourceRef,
          chunks: 3,
          mergeStrategy: { type: 'concatenate' },
        });

        const merged = await store.resolve(ref) as string;
        // Merged result should contain the error messages
        expect(merged).toContain('Chunk processing failed');
      });

      it('should handle partial failures across sub-agents', async () => {
        let callCount = 0;
        const partialProvider: LLMProvider = {
          execute: vi.fn(async () => {
            callCount++;
            if (callCount === 2) {
              throw new Error('Second chunk failed');
            }
            return { result: `Success chunk ${callCount}` };
          }),
        };

        const partialRuntime = new AgentRuntime({
          store, provider: partialProvider,
        });
        const partialSpawner = new RecursiveSpawner({
          runtime: partialRuntime, store,
          defaultModel: 'claude-sonnet-4-5-20250929',
          maxDepth: 5, maxConcurrent: 1, // Sequential to control ordering
          onLog: (msg) => logs.push(msg),
        });

        const sourceRef = await store.set('partial-fail', 'AABBCC', { type: 'text' });

        const ref = await partialSpawner.decompose({
          prompt: 'Process',
          sourceRef,
          chunks: 3,
          mergeStrategy: { type: 'concatenate' },
        });

        const merged = await store.resolve(ref) as string;
        // Should contain both successful results and the error
        expect(merged).toContain('Success chunk');
        expect(merged).toContain('Second chunk failed');
      });

      it('should fail decompose when token budget is already exhausted', async () => {
        const tokenProvider: LLMProvider = {
          execute: vi.fn(async () => ({
            result: 'Done',
            tokenUsage: { inputTokens: 400, outputTokens: 200, totalTokens: 600 },
          })),
        };

        const tokenRuntime = new AgentRuntime({
          store, provider: tokenProvider,
        });
        const budgetSpawner = new RecursiveSpawner({
          runtime: tokenRuntime, store,
          defaultModel: 'claude-sonnet-4-5-20250929',
          maxDepth: 5, maxConcurrent: 5,
          tokenBudget: 500,
          onLog: (msg) => logs.push(msg),
        });

        // First, exhaust the budget with a prior spawn
        // 0 < 500 so spawn proceeds, after completion: totalTokensUsed = 600
        await budgetSpawner.spawn({ prompt: 'Prior task', context: {} });
        expect(budgetSpawner.getTotalTokensUsed()).toBe(600);

        const sourceRef = await store.set('budget-decompose', 'AABB', { type: 'text' });

        // Now decompose should fail immediately because 600 >= 500
        await expect(
          budgetSpawner.decompose({
            prompt: 'Process',
            sourceRef,
            chunks: 2,
            mergeStrategy: { type: 'concatenate' },
          })
        ).rejects.toThrow('Token budget exhausted');
      });
    });

    describe('result integrity', () => {
      it('should return a valid VariableRef from decompose', async () => {
        const sourceRef = await store.set('ref-check', 'TestData', { type: 'text' });

        const resultRef = await spawner.decompose({
          prompt: 'Process',
          sourceRef,
          chunks: 2,
          mergeStrategy: { type: 'concatenate' },
        });

        expect(resultRef.id).toBeTruthy();
        expect(resultRef.key).toContain('merged-');
        expect(resultRef.type).toBe('result');
        expect(resultRef.scope).toBe('global');
        expect(resultRef.sizeBytes).toBeGreaterThan(0);
        expect(resultRef.createdAt).toBeGreaterThan(0);
      });

      it('should preserve all chunks without data loss', async () => {
        const original = 'The quick brown fox jumps over the lazy dog';
        const sourceRef = await store.set('preserve-test', original, { type: 'text' });

        await spawner.decompose({
          prompt: 'Process',
          sourceRef,
          chunks: 5,
          mergeStrategy: { type: 'concatenate' },
        });

        // Reconstruct original from chunks
        let reconstructed = '';
        for (let i = 0; i < 5; i++) {
          const chunk = await store.get(`chunk-preserve-test-${i}`) as string;
          reconstructed += chunk;
        }
        expect(reconstructed).toBe(original);
      });
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

    it('should reject immediately with budget of 0', async () => {
      const tokenProvider: LLMProvider = {
        execute: vi.fn(async () => ({
          result: 'Done',
          tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        })),
      };

      const tokenRuntime = new AgentRuntime({
        store, provider: tokenProvider,
      });

      const zeroBudgetSpawner = new RecursiveSpawner({
        runtime: tokenRuntime, store,
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxDepth: 5, maxConcurrent: 3,
        tokenBudget: 0,
        onLog: (msg) => logs.push(msg),
      });

      // Budget is 0, totalTokensUsed starts at 0, and 0 >= 0 is true
      await expect(
        zeroBudgetSpawner.spawn({ prompt: 'Task', context: {} })
      ).rejects.toThrow('Token budget exhausted');

      // Provider should never have been called
      expect(tokenProvider.execute).not.toHaveBeenCalled();
    });

    it('should include usage details in budget exhaustion error', async () => {
      const tokenProvider: LLMProvider = {
        execute: vi.fn(async () => ({
          result: 'Done',
          tokenUsage: { inputTokens: 300, outputTokens: 200, totalTokens: 500 },
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

      await budgetSpawner.spawn({ prompt: 'Task 1', context: {} });

      // Error message should contain the current usage and budget limit
      await expect(
        budgetSpawner.spawn({ prompt: 'Task 2', context: {} })
      ).rejects.toThrow('500 / 500 tokens used');
    });

    it('should track cumulative tokens across multiple spawns with varying usage', async () => {
      let callCount = 0;
      const varyingProvider: LLMProvider = {
        execute: vi.fn(async () => {
          callCount++;
          // Each call uses a different amount of tokens
          const tokens = callCount * 100;
          return {
            result: `Done ${callCount}`,
            tokenUsage: {
              inputTokens: tokens * 0.6,
              outputTokens: tokens * 0.4,
              totalTokens: tokens,
            },
          };
        }),
      };

      const tokenRuntime = new AgentRuntime({
        store, provider: varyingProvider,
      });

      const budgetSpawner = new RecursiveSpawner({
        runtime: tokenRuntime, store,
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxDepth: 5, maxConcurrent: 3,
        tokenBudget: 1000,
        onLog: (msg) => logs.push(msg),
      });

      // Spawn 1: 100 tokens -> cumulative 100
      await budgetSpawner.spawn({ prompt: 'Task 1', context: {} });
      expect(budgetSpawner.getTotalTokensUsed()).toBe(100);

      // Spawn 2: 200 tokens -> cumulative 300
      await budgetSpawner.spawn({ prompt: 'Task 2', context: {} });
      expect(budgetSpawner.getTotalTokensUsed()).toBe(300);

      // Spawn 3: 300 tokens -> cumulative 600
      await budgetSpawner.spawn({ prompt: 'Task 3', context: {} });
      expect(budgetSpawner.getTotalTokensUsed()).toBe(600);

      // Spawn 4: 400 tokens -> cumulative 1000
      await budgetSpawner.spawn({ prompt: 'Task 4', context: {} });
      expect(budgetSpawner.getTotalTokensUsed()).toBe(1000);

      // Spawn 5 should fail: 1000 >= 1000
      await expect(
        budgetSpawner.spawn({ prompt: 'Task 5', context: {} })
      ).rejects.toThrow('Token budget exhausted');
    });

    it('should report detailed token breakdown via getTotalTokenUsage()', async () => {
      const tokenProvider: LLMProvider = {
        execute: vi.fn(async () => ({
          result: 'Done',
          tokenUsage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
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

      await budgetSpawner.spawn({ prompt: 'Task 1', context: {} });
      await budgetSpawner.spawn({ prompt: 'Task 2', context: {} });

      const usage = budgetSpawner.getTotalTokenUsage();
      expect(usage.inputTokens).toBe(160);
      expect(usage.outputTokens).toBe(40);
      expect(usage.totalTokens).toBe(200);

      // Scalar getter should match the detailed total
      expect(budgetSpawner.getTotalTokensUsed()).toBe(200);
    });

    it('should allow spawning again after reset() clears the budget', async () => {
      const tokenProvider: LLMProvider = {
        execute: vi.fn(async () => ({
          result: 'Done',
          tokenUsage: { inputTokens: 400, outputTokens: 200, totalTokens: 600 },
        })),
      };

      const tokenRuntime = new AgentRuntime({
        store, provider: tokenProvider,
      });

      const budgetSpawner = new RecursiveSpawner({
        runtime: tokenRuntime, store,
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxDepth: 5, maxConcurrent: 3,
        tokenBudget: 600,
        onLog: (msg) => logs.push(msg),
      });

      // First spawn uses entire budget
      await budgetSpawner.spawn({ prompt: 'Task 1', context: {} });
      expect(budgetSpawner.getTotalTokensUsed()).toBe(600);

      // Next spawn should fail
      await expect(
        budgetSpawner.spawn({ prompt: 'Task 2', context: {} })
      ).rejects.toThrow('Token budget exhausted');

      // Reset clears tokens used
      budgetSpawner.reset();
      expect(budgetSpawner.getTotalTokensUsed()).toBe(0);

      // Now spawning should succeed again
      const ref = await budgetSpawner.spawn({ prompt: 'Task 3', context: {} });
      expect(ref).toBeTruthy();
      expect(ref.type).toBe('result');
      expect(budgetSpawner.getTotalTokensUsed()).toBe(600);
    });

    it('should succeed when spawn is exactly at budget boundary', async () => {
      const tokenProvider: LLMProvider = {
        execute: vi.fn(async () => ({
          result: 'Done',
          tokenUsage: { inputTokens: 300, outputTokens: 200, totalTokens: 500 },
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

      // totalTokensUsed is 0, budget is 500, 0 < 500 so spawn proceeds
      const ref = await budgetSpawner.spawn({ prompt: 'Task', context: {} });
      expect(ref).toBeTruthy();
      // After spawn, totalTokensUsed = 500, which equals budget
      expect(budgetSpawner.getTotalTokensUsed()).toBe(500);

      // Now 500 >= 500, next spawn should fail
      await expect(
        budgetSpawner.spawn({ prompt: 'Next', context: {} })
      ).rejects.toThrow('Token budget exhausted');
    });

    it('should enforce budget across spawnMany', async () => {
      const tokenProvider: LLMProvider = {
        execute: vi.fn(async () => ({
          result: 'Done',
          tokenUsage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
        })),
      };

      const tokenRuntime = new AgentRuntime({
        store, provider: tokenProvider,
      });

      const budgetSpawner = new RecursiveSpawner({
        runtime: tokenRuntime, store,
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxDepth: 5, maxConcurrent: 5,
        tokenBudget: 700,
        onLog: (msg) => logs.push(msg),
      });

      // Spawn 2 tasks: first uses 300, then 600 total. Both succeed.
      const refs = await budgetSpawner.spawnMany([
        { prompt: 'Task 1', context: {} },
        { prompt: 'Task 2', context: {} },
      ]);
      expect(refs.length).toBe(2);
      expect(budgetSpawner.getTotalTokensUsed()).toBe(600);

      // Third spawn succeeds (600 < 700), totaling 900
      await budgetSpawner.spawn({ prompt: 'Task 3', context: {} });
      expect(budgetSpawner.getTotalTokensUsed()).toBe(900);

      // Fourth spawn should fail: 900 >= 700
      await expect(
        budgetSpawner.spawn({ prompt: 'Task 4', context: {} })
      ).rejects.toThrow('Token budget exhausted');
    });
  });
});
