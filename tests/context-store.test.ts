import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ContextStore } from '../src/context-store.js';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';

const TEST_DIR = resolve('.rlm-test-data-context');

describe('ContextStore', () => {
  let store: ContextStore;

  beforeEach(async () => {
    store = new ContextStore(TEST_DIR, 1024 * 1024); // 1MB limit
    await store.init();
  });

  afterEach(async () => {
    await store.clear();
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  describe('set/get', () => {
    it('should store and retrieve a string value', async () => {
      await store.set('greeting', 'hello world');
      const value = await store.get('greeting');
      expect(value).toBe('hello world');
    });

    it('should store and retrieve a JSON object', async () => {
      const data = { name: 'test', count: 42, nested: { a: 1 } };
      await store.set('data', data);
      const value = await store.get('data');
      expect(value).toEqual(data);
    });

    it('should store and retrieve an array', async () => {
      const arr = [1, 2, 3, 'four', { five: 5 }];
      await store.set('array', arr);
      const value = await store.get('array');
      expect(value).toEqual(arr);
    });

    it('should throw on get for non-existent key', async () => {
      await expect(store.get('nonexistent')).rejects.toThrow('Variable not found');
    });

    it('should overwrite existing values', async () => {
      await store.set('key', 'value1');
      await store.set('key', 'value2');
      const value = await store.get('key');
      expect(value).toBe('value2');
    });
  });

  describe('ref', () => {
    it('should return a VariableRef with correct metadata', async () => {
      await store.set('myvar', 'test content', { type: 'text', scope: 'global' });
      const ref = store.ref('myvar');

      expect(ref.key).toBe('myvar');
      expect(ref.type).toBe('text');
      expect(ref.scope).toBe('global');
      expect(ref.sizeBytes).toBeGreaterThan(0);
      expect(ref.id).toBeTruthy();
      expect(ref.createdAt).toBeGreaterThan(0);
    });

    it('should be O(1) - does not load value', async () => {
      const largeData = 'x'.repeat(100000);
      await store.set('large', largeData);

      const start = performance.now();
      const ref = store.ref('large');
      const elapsed = performance.now() - start;

      // Should be < 1ms
      expect(elapsed).toBeLessThan(5);
      expect(ref.sizeBytes).toBeGreaterThan(99000);
      // ref should NOT have a value property
      expect('value' in ref).toBe(false);
    });

    it('should throw for non-existent key', () => {
      expect(() => store.ref('nonexistent')).toThrow('Variable not found');
    });
  });

  describe('resolve', () => {
    it('should resolve a ref back to its value', async () => {
      await store.set('data', { message: 'hello' });
      const ref = store.ref('data');
      const value = await store.resolve(ref);
      expect(value).toEqual({ message: 'hello' });
    });
  });

  describe('delete', () => {
    it('should remove a variable', async () => {
      await store.set('temp', 'temporary');
      expect(store.has('temp')).toBe(true);
      await store.delete('temp');
      expect(store.has('temp')).toBe(false);
    });

    it('should not throw when deleting non-existent key', async () => {
      // Verify delete resolves without error (compatible with both vitest and bun test)
      const result = await store.delete('nonexistent');
      expect(result).toBeUndefined();
    });
  });

  describe('list', () => {
    it('should list all variables', async () => {
      await store.set('a', 'alpha', { type: 'text' });
      await store.set('b', { x: 1 }, { type: 'json' });
      await store.set('c', 'result data', { type: 'result' });

      const list = await store.list();
      expect(list.length).toBe(3);
      expect(list.map((v) => v.key).sort()).toEqual(['a', 'b', 'c']);
    });

    it('should filter by scope', async () => {
      await store.set('g1', 'global1', { scope: 'global' });
      await store.set('a1', 'agent1', { scope: 'agent:123' });
      await store.set('g2', 'global2', { scope: 'global' });

      const globals = await store.list({ scope: 'global' });
      expect(globals.length).toBe(2);
    });

    it('should filter by type', async () => {
      await store.set('t1', 'text1', { type: 'text' });
      await store.set('j1', { x: 1 }, { type: 'json' });
      await store.set('t2', 'text2', { type: 'text' });

      const texts = await store.list({ type: 'text' });
      expect(texts.length).toBe(2);
    });
  });

  describe('summarize', () => {
    it('should return short content as-is', async () => {
      await store.set('short', 'hello');
      const summary = await store.summarize('short');
      expect(summary).toBe('hello');
    });

    it('should truncate long content', async () => {
      const longText = 'a'.repeat(10000);
      await store.set('long', longText);
      const summary = await store.summarize('long', 50); // 50 tokens = ~200 chars
      expect(summary.length).toBeLessThan(10000);
      expect(summary).toContain('truncated');
    });

    it('should cache summaries', async () => {
      await store.set('data', 'test data');
      const s1 = await store.summarize('data');
      const s2 = await store.summarize('data');
      expect(s1).toBe(s2);
    });
  });

  describe('has', () => {
    it('should return true for existing keys', async () => {
      await store.set('exists', 'yes');
      expect(store.has('exists')).toBe(true);
    });

    it('should return false for missing keys', () => {
      expect(store.has('missing')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all variables', async () => {
      await store.set('a', 1);
      await store.set('b', 2);
      await store.set('c', 3);

      await store.clear();
      const list = await store.list();
      expect(list.length).toBe(0);
    });
  });

  describe('persistence', () => {
    it('should persist and reload variables', async () => {
      await store.set('persistent', 'saved data', { persist: true });

      // Create a new store instance pointing to the same directory
      const store2 = new ContextStore(TEST_DIR);
      await store2.init();

      const value = await store2.get('persistent');
      expect(value).toBe('saved data');
    });
  });

  describe('memory management', () => {
    it('should track memory usage', async () => {
      const before = store.getMemoryUsage();
      expect(before.currentBytes).toBe(0);

      await store.set('data', 'x'.repeat(1000));
      const after = store.getMemoryUsage();
      expect(after.currentBytes).toBeGreaterThan(0);
    });

    it('should infer variable types', async () => {
      await store.set('str', 'hello');
      expect(store.ref('str').type).toBe('text');

      await store.set('obj', { x: 1 });
      expect(store.ref('obj').type).toBe('json');

      await store.set('arr', [1, 2, 3]);
      expect(store.ref('arr').type).toBe('json');
    });
  });

  describe('scoping', () => {
    it('should support different scopes', async () => {
      await store.set('g', 'global', { scope: 'global' });
      await store.set('a', 'agent-1', { scope: 'agent:abc' });
      await store.set('s', 'session-1', { scope: 'session:xyz' });

      expect(store.ref('g').scope).toBe('global');
      expect(store.ref('a').scope).toBe('agent:abc');
      expect(store.ref('s').scope).toBe('session:xyz');
    });
  });

  describe('performance', () => {
    it('should handle many variables efficiently', async () => {
      const start = performance.now();

      for (let i = 0; i < 100; i++) {
        await store.set(`var-${i}`, `value-${i}`);
      }

      const elapsed = performance.now() - start;
      // 100 in-memory sets should complete in under 500ms
      expect(elapsed).toBeLessThan(500);

      const list = await store.list();
      expect(list.length).toBe(100);
    });

    it('ref() should be consistently fast', async () => {
      await store.set('perf-test', 'x'.repeat(10000));

      const times: number[] = [];
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        store.ref('perf-test');
        times.push(performance.now() - start);
      }

      const avgTime = times.reduce((a, b) => a + b) / times.length;
      expect(avgTime).toBeLessThan(1); // < 1ms average
    });
  });
});
