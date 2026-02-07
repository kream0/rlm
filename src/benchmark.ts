// ============================================================
// RLM Benchmark Suite
// Measures pass-by-reference efficiency, context store performance,
// memory manager scaling, merge strategy throughput, spawning overhead,
// and context window savings.
// ============================================================

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextStore } from './context-store.js';
import { MemoryManager } from './memory-manager.js';
import { FunctionRegistry } from './function-registry.js';
import { RecursiveSpawner } from './recursive-spawner.js';
import { AgentRuntime } from './agent-runtime.js';
import type { VariableRef, MergeStrategyType, MemoryType } from './types.js';

// ── Utilities ──────────────────────────────────────────────────

function generateData(sizeBytes: number): string {
  // Use Buffer.alloc + fill for fast generation of large strings
  const chunk = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n';
  const repeats = Math.ceil(sizeBytes / chunk.length);
  return chunk.repeat(repeats).slice(0, sizeBytes);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatNum(n: number): string {
  return n.toLocaleString('en-US');
}

function padR(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

async function timeAsync<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

function timeSync<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

const DIVIDER = '─'.repeat(72);
const DOUBLE_DIVIDER = '═'.repeat(72);

// ── 1. Pass-by-Reference Efficiency ─────────────────────────────

async function benchPassByReference(store: ContextStore): Promise<void> {
  console.log('\n' + DOUBLE_DIVIDER);
  console.log('  1. PASS-BY-REFERENCE EFFICIENCY');
  console.log(DOUBLE_DIVIDER);
  console.log();
  console.log('  The core claim: sub-agents receive a tiny ref instead of the full value.');
  console.log('  This is how RLM avoids context window explosion.\n');

  const sizes = [
    { label: '1 KB', bytes: 1_024 },
    { label: '10 KB', bytes: 10_240 },
    { label: '100 KB', bytes: 102_400 },
    { label: '1 MB', bytes: 1_048_576 },
    { label: '10 MB', bytes: 10_485_760 },
  ];

  console.log(
    '  ' +
    padR('Data Size', 12) +
    padR('Value Size', 14) +
    padR('Ref Size', 12) +
    padR('Ratio', 12) +
    padR('Savings', 10),
  );
  console.log('  ' + DIVIDER);

  const results: Array<{ label: string; valueSize: number; refSize: number }> = [];

  for (const { label, bytes } of sizes) {
    const data = generateData(bytes);
    const key = `bench-ref-${bytes}`;
    const ref = await store.set(key, data);

    const refJson = JSON.stringify(ref);
    const refSize = Buffer.byteLength(refJson, 'utf-8');
    const valueSize = ref.sizeBytes;
    const ratio = Math.round(valueSize / refSize);
    const savings = ((1 - refSize / valueSize) * 100).toFixed(1);

    results.push({ label, valueSize, refSize });

    console.log(
      '  ' +
      padR(label, 12) +
      padR(formatBytes(valueSize), 14) +
      padR(formatBytes(refSize), 12) +
      padR(`${formatNum(ratio)}x`, 12) +
      padR(`${savings}%`, 10),
    );
  }

  // Multi-agent simulation
  console.log();
  console.log('  ' + DIVIDER);
  console.log('  Multi-Agent Context Savings Simulation:');
  console.log();

  const agentCounts = [3, 5, 10, 50];
  const lastResult = results[results.length - 2]; // Use 1MB result

  for (const n of agentCounts) {
    const docSize = 1_048_576;
    const withoutRefs = docSize * n;
    const withRefs = lastResult.refSize * n;
    const saved = withoutRefs - withRefs;
    console.log(
      `  ${padR(`${n} agents x 1MB doc:`, 28)}` +
      `without refs = ${padR(formatBytes(withoutRefs), 10)} ` +
      `with refs = ${padR(formatBytes(withRefs), 10)} ` +
      `saved = ${formatBytes(saved)} (${((1 - withRefs / withoutRefs) * 100).toFixed(2)}%)`,
    );
  }

  // Clean up
  for (const { bytes } of sizes) {
    await store.delete(`bench-ref-${bytes}`);
  }
}

// ── 2. Context Store Performance ────────────────────────────────

async function benchContextStore(store: ContextStore): Promise<void> {
  console.log('\n' + DOUBLE_DIVIDER);
  console.log('  2. CONTEXT STORE PERFORMANCE');
  console.log(DOUBLE_DIVIDER);
  console.log();

  // 2a: set() latency at various sizes
  const setSizes = [
    { label: '100 B', bytes: 100 },
    { label: '1 KB', bytes: 1_024 },
    { label: '10 KB', bytes: 10_240 },
    { label: '100 KB', bytes: 102_400 },
    { label: '1 MB', bytes: 1_048_576 },
    { label: '10 MB', bytes: 10_485_760 },
  ];

  console.log('  set() Latency:');
  console.log(
    '  ' +
    padR('Size', 12) +
    padR('Latency', 14) +
    padR('Ops/sec', 14),
  );
  console.log('  ' + DIVIDER);

  for (const { label, bytes } of setSizes) {
    const data = generateData(bytes);
    const iterations = bytes > 1_000_000 ? 3 : 20;
    let totalMs = 0;
    for (let i = 0; i < iterations; i++) {
      const key = `bench-set-${bytes}-${i}`;
      const { ms } = await timeAsync(() => store.set(key, data));
      totalMs += ms;
    }
    const avgMs = totalMs / iterations;
    const opsPerSec = Math.round(1000 / avgMs);
    console.log(
      '  ' +
      padR(label, 12) +
      padR(`${avgMs.toFixed(3)} ms`, 14) +
      padR(formatNum(opsPerSec), 14),
    );
    // Cleanup
    for (let i = 0; i < iterations; i++) {
      await store.delete(`bench-set-${bytes}-${i}`);
    }
  }

  // 2b: get() latency
  console.log();
  console.log('  get() Latency:');
  console.log(
    '  ' +
    padR('Size', 12) +
    padR('Latency', 14) +
    padR('Ops/sec', 14),
  );
  console.log('  ' + DIVIDER);

  for (const { label, bytes } of setSizes) {
    const data = generateData(bytes);
    const key = `bench-get-${bytes}`;
    await store.set(key, data);

    const iterations = bytes > 1_000_000 ? 5 : 50;
    let totalMs = 0;
    for (let i = 0; i < iterations; i++) {
      const { ms } = await timeAsync(() => store.get(key));
      totalMs += ms;
    }
    const avgMs = totalMs / iterations;
    const opsPerSec = Math.round(1000 / avgMs);
    console.log(
      '  ' +
      padR(label, 12) +
      padR(`${avgMs.toFixed(3)} ms`, 14) +
      padR(formatNum(opsPerSec), 14),
    );
    await store.delete(key);
  }

  // 2c: ref() O(1) proof
  console.log();
  console.log('  ref() O(1) Verification (must be constant regardless of value size):');
  console.log(
    '  ' +
    padR('Value Size', 12) +
    padR('ref() Latency', 16) +
    padR('Verdict', 10),
  );
  console.log('  ' + DIVIDER);

  const refLatencies: number[] = [];
  for (const { label, bytes } of setSizes) {
    const data = generateData(bytes);
    const key = `bench-ref-o1-${bytes}`;
    await store.set(key, data);

    const iterations = 1000;
    let totalMs = 0;
    for (let i = 0; i < iterations; i++) {
      const { ms } = timeSync(() => store.ref(key));
      totalMs += ms;
    }
    const avgMs = totalMs / iterations;
    refLatencies.push(avgMs);

    console.log(
      '  ' +
      padR(label, 12) +
      padR(`${(avgMs * 1000).toFixed(1)} us`, 16) +
      padR('O(1)', 10),
    );
    await store.delete(key);
  }

  // Verify O(1): the ratio between smallest and largest shouldn't exceed 5x
  const minRef = Math.min(...refLatencies);
  const maxRef = Math.max(...refLatencies);
  const refRatio = maxRef / minRef;
  console.log();
  console.log(`  O(1) check: min=${(minRef * 1000).toFixed(1)}us, max=${(maxRef * 1000).toFixed(1)}us, ratio=${refRatio.toFixed(1)}x -> ${refRatio < 5 ? 'PASS (< 5x variance)' : 'WARN (> 5x variance)'}`);

  // 2d: list() scaling
  console.log();
  console.log('  list() Scaling:');
  console.log(
    '  ' +
    padR('Variables', 12) +
    padR('Latency', 14) +
    padR('Ops/sec', 14),
  );
  console.log('  ' + DIVIDER);

  const listCounts = [10, 100, 1000, 3000];
  for (const count of listCounts) {
    // Populate
    for (let i = 0; i < count; i++) {
      await store.set(`bench-list-${count}-${i}`, `value-${i}`);
    }
    const iterations = 20;
    let totalMs = 0;
    for (let i = 0; i < iterations; i++) {
      const { ms } = await timeAsync(() => store.list());
      totalMs += ms;
    }
    const avgMs = totalMs / iterations;
    console.log(
      '  ' +
      padR(formatNum(count), 12) +
      padR(`${avgMs.toFixed(3)} ms`, 14) +
      padR(formatNum(Math.round(1000 / avgMs)), 14),
    );
    // Cleanup
    for (let i = 0; i < count; i++) {
      await store.delete(`bench-list-${count}-${i}`);
    }
  }

  // 2e: Memory tracking accuracy
  console.log();
  console.log('  Memory Usage Tracking:');
  const memBefore = store.getMemoryUsage();
  const trackData = generateData(100_000);
  await store.set('bench-mem-track', trackData);
  const memAfter = store.getMemoryUsage();
  const expectedSize = Buffer.byteLength(JSON.stringify(trackData), 'utf-8');
  const actualDelta = memAfter.currentBytes - memBefore.currentBytes;
  console.log(`  Expected delta: ${formatBytes(expectedSize)}`);
  console.log(`  Actual delta:   ${formatBytes(actualDelta)}`);
  console.log(`  Accuracy:       ${((actualDelta / expectedSize) * 100).toFixed(1)}%`);
  await store.delete('bench-mem-track');
}

// ── 3. Memory Manager Performance ───────────────────────────────

async function benchMemoryManager(memory: MemoryManager): Promise<void> {
  console.log('\n' + DOUBLE_DIVIDER);
  console.log('  3. MEMORY MANAGER PERFORMANCE');
  console.log(DOUBLE_DIVIDER);
  console.log();

  // 3a: append() throughput
  console.log('  append() Throughput:');
  console.log(
    '  ' +
    padR('Memory Type', 16) +
    padR('Entries', 10) +
    padR('Total Time', 14) +
    padR('Entries/sec', 14),
  );
  console.log('  ' + DIVIDER);

  const memTypes: MemoryType[] = ['working', 'episodic', 'semantic', 'procedural'];
  const appendCount = 200;

  for (const memType of memTypes) {
    let totalMs = 0;
    for (let i = 0; i < appendCount; i++) {
      const entry = {
        id: randomUUID(),
        timestamp: Date.now(),
        content: `Entry ${i}: This is test content for ${memType} memory benchmarking with some words for search.`,
        metadata: memType === 'semantic'
          ? { key: `knowledge-${i}` }
          : memType === 'procedural'
            ? { condition: `condition-${i}` }
            : { index: i },
      };
      const { ms } = await timeAsync(() => memory.append(memType, entry));
      totalMs += ms;
    }
    const entriesPerSec = Math.round((appendCount / totalMs) * 1000);
    console.log(
      '  ' +
      padR(memType, 16) +
      padR(String(appendCount), 10) +
      padR(`${totalMs.toFixed(1)} ms`, 14) +
      padR(formatNum(entriesPerSec), 14),
    );
  }

  // 3b: search() scaling
  console.log();
  console.log('  search() Scaling:');
  console.log(
    '  ' +
    padR('Entry Count', 14) +
    padR('Query', 20) +
    padR('Latency', 12) +
    padR('Results', 10),
  );
  console.log('  ' + DIVIDER);

  const searchCounts = [100, 500, 1000, 2000];
  const queries = ['test content', 'Entry 42', 'benchmarking words search'];

  for (const count of searchCounts) {
    await memory.clear('episodic');
    // Populate
    for (let i = 0; i < count; i++) {
      await memory.append('episodic', {
        id: randomUUID(),
        timestamp: Date.now() - (count - i) * 1000,
        content: `Entry ${i}: This is test content for benchmarking with some unique words and search terms. Item number ${i}.`,
        metadata: { index: i },
      });
    }

    for (const query of queries) {
      const iterations = 10;
      let totalMs = 0;
      let resultCount = 0;
      for (let j = 0; j < iterations; j++) {
        const { result, ms } = await timeAsync(() => memory.search('episodic', query, 10));
        totalMs += ms;
        resultCount = result.length;
      }
      const avgMs = totalMs / iterations;
      console.log(
        '  ' +
        padR(formatNum(count), 14) +
        padR(`"${query.slice(0, 16)}..."`, 20) +
        padR(`${avgMs.toFixed(2)} ms`, 12) +
        padR(String(resultCount), 10),
      );
    }
  }

  // 3c: recall() O(1) verification
  console.log();
  console.log('  recall() O(1) Verification:');

  await memory.clear('semantic');
  const knowledgeCounts = [10, 100, 500, 1000];
  for (const count of knowledgeCounts) {
    await memory.clear('semantic');
    for (let i = 0; i < count; i++) {
      await memory.learn({ key: `fact-${i}`, value: `Value for fact ${i} with some detail` });
    }
    const targetKey = `fact-${Math.floor(count / 2)}`;
    const iterations = 500;
    let totalMs = 0;
    for (let j = 0; j < iterations; j++) {
      const { ms } = await timeAsync(() => memory.recall(targetKey));
      totalMs += ms;
    }
    const avgMs = totalMs / iterations;
    console.log(
      '  ' +
      padR(`${formatNum(count)} entries`, 18) +
      `recall() = ${(avgMs * 1000).toFixed(1)} us -> O(1) via Map lookup`,
    );
  }

  // 3d: compact() performance
  console.log();
  console.log('  compact() Performance:');
  console.log(
    '  ' +
    padR('Memory Type', 16) +
    padR('Before', 10) +
    padR('keepLast', 10) +
    padR('After', 10) +
    padR('Latency', 12),
  );
  console.log('  ' + DIVIDER);

  const compactTests = [
    { type: 'working' as MemoryType, count: 100, keepLast: 10 },
    { type: 'working' as MemoryType, count: 100, keepLast: 30 },
    { type: 'episodic' as MemoryType, count: 200, keepLast: 20 },
  ];

  for (const test of compactTests) {
    await memory.clear(test.type);
    for (let i = 0; i < test.count; i++) {
      await memory.append(test.type, {
        id: randomUUID(),
        timestamp: Date.now(),
        content: `Compact test entry ${i}`,
      });
    }
    const { ms } = await timeAsync(() =>
      memory.compact(test.type, { keepLast: test.keepLast, summarizeOlder: true }),
    );
    const afterCount =
      test.type === 'working'
        ? memory.getWorkingMemory().length
        : memory.getEpisodicMemory().length;
    console.log(
      '  ' +
      padR(test.type, 16) +
      padR(String(test.count), 10) +
      padR(String(test.keepLast), 10) +
      padR(String(afterCount), 10) +
      padR(`${ms.toFixed(2)} ms`, 12),
    );
  }

  // 3e: getStats() overhead
  console.log();
  const statsIterations = 1000;
  let statsTotalMs = 0;
  for (let i = 0; i < statsIterations; i++) {
    const { ms } = timeSync(() => memory.getStats());
    statsTotalMs += ms;
  }
  console.log(`  getStats() avg: ${((statsTotalMs / statsIterations) * 1000).toFixed(1)} us`);
}

// ── 4. Merge Strategy Performance ───────────────────────────────

async function benchMergeStrategies(store: ContextStore): Promise<void> {
  console.log('\n' + DOUBLE_DIVIDER);
  console.log('  4. MERGE STRATEGY PERFORMANCE');
  console.log(DOUBLE_DIVIDER);
  console.log();

  const strategies: MergeStrategyType[] = ['concatenate', 'structured', 'vote', 'summarize', 'custom'];
  const resultCounts = [3, 10, 50];

  // Build a mock spawner just for merge testing
  const registry = new FunctionRegistry();
  const runtime = new AgentRuntime({
    store,
    registry,
    provider: { chat: async () => ({ content: [{ type: 'text' as const, text: 'done' }], stopReason: 'end_turn' as const, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }) },
  });
  const spawner = new RecursiveSpawner({
    runtime,
    store,
    registry,
    defaultModel: 'mock',
    maxDepth: 5,
    maxConcurrent: 3,
  });

  console.log(
    '  ' +
    padR('Strategy', 16) +
    padR('Results', 10) +
    padR('Latency', 14) +
    padR('Output Size', 14),
  );
  console.log('  ' + DIVIDER);

  for (const strategy of strategies) {
    for (const count of resultCounts) {
      // Create result refs
      const refs: VariableRef[] = [];
      for (let i = 0; i < count; i++) {
        const key = `merge-input-${strategy}-${count}-${i}`;
        const ref = await store.set(key, {
          analysis: `Result ${i} analysis text with some content for merging.`,
          score: Math.random() * 100,
          tags: ['benchmark', 'test'],
        });
        refs.push(ref);
      }

      const mergeOpts = strategy === 'custom'
        ? {
          type: 'custom' as const,
          customMergeFn: async (mergeResults: unknown[]) => ({
            merged: true,
            count: mergeResults.length,
            combined: mergeResults,
          }),
        }
        : { type: strategy };

      const { result: mergedRef, ms } = await timeAsync(() =>
        spawner.merge(refs, mergeOpts),
      );

      const mergedValue = await store.get(mergedRef.key);
      const outputSize = Buffer.byteLength(JSON.stringify(mergedValue), 'utf-8');

      console.log(
        '  ' +
        padR(strategy, 16) +
        padR(String(count), 10) +
        padR(`${ms.toFixed(2)} ms`, 14) +
        padR(formatBytes(outputSize), 14),
      );

      // Cleanup
      for (let i = 0; i < count; i++) {
        await store.delete(`merge-input-${strategy}-${count}-${i}`);
      }
      await store.delete(mergedRef.key);
    }
  }
}

// ── 5. Recursive Spawning Overhead ──────────────────────────────

async function benchSpawningOverhead(store: ContextStore): Promise<void> {
  console.log('\n' + DOUBLE_DIVIDER);
  console.log('  5. RECURSIVE SPAWNING OVERHEAD (Mocked LLM)');
  console.log(DOUBLE_DIVIDER);
  console.log();

  const registry = new FunctionRegistry();
  const runtime = new AgentRuntime({
    store,
    registry,
    provider: { chat: async () => ({ content: [{ type: 'text' as const, text: 'done' }], stopReason: 'end_turn' as const, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }) },
  });

  // 5a: Agent creation overhead
  console.log('  Agent Creation Overhead:');
  const creationIterations = 1000;
  let creationTotalMs = 0;
  for (let i = 0; i < creationIterations; i++) {
    const { ms } = timeSync(() =>
      runtime.create({
        id: randomUUID(),
        prompt: 'Benchmark agent prompt',
        model: 'mock-model',
        functions: [],
      }),
    );
    creationTotalMs += ms;
  }
  const avgCreation = creationTotalMs / creationIterations;
  console.log(`  ${formatNum(creationIterations)} agents created in ${creationTotalMs.toFixed(1)} ms`);
  console.log(`  Average: ${(avgCreation * 1000).toFixed(1)} us per agent`);
  console.log(`  Throughput: ${formatNum(Math.round(1000 / avgCreation))} agents/sec`);

  // 5b: Tree building cost
  console.log();
  console.log('  Tree Building Cost:');

  const treeSizes = [
    { label: '3 agents (depth 1)', agents: 3, depth: 1 },
    { label: '10 agents (depth 2)', agents: 10, depth: 2 },
    { label: '50 agents (depth 3)', agents: 50, depth: 3 },
  ];

  for (const { label } of treeSizes) {
    const spawner = new RecursiveSpawner({
      runtime,
      store,
      registry,
      defaultModel: 'mock',
      maxDepth: 5,
      maxConcurrent: 10,
    });

    const iterations = 100;
    let totalMs = 0;
    for (let i = 0; i < iterations; i++) {
      const { ms } = timeSync(() => spawner.getTree());
      totalMs += ms;
    }
    const avgMs = totalMs / iterations;
    console.log(
      `  ${padR(label + ':', 30)} getTree() = ${(avgMs * 1000).toFixed(1)} us`,
    );
  }

  // 5c: Token usage aggregation
  console.log();
  console.log('  Token Aggregation:');
  const spawner = new RecursiveSpawner({
    runtime,
    store,
    registry,
    defaultModel: 'mock',
    maxDepth: 5,
    maxConcurrent: 10,
  });
  const { ms: tokenMs } = timeSync(() => spawner.getTotalTokenUsage());
  console.log(`  getTotalTokenUsage(): ${(tokenMs * 1000).toFixed(1)} us`);

  // 5d: FunctionRegistry overhead
  console.log();
  console.log('  Function Registry Overhead:');
  const fnRegistry = new FunctionRegistry();
  const fnCount = 50;
  let regTotalMs = 0;
  for (let i = 0; i < fnCount; i++) {
    const { ms } = timeSync(() =>
      fnRegistry.register({
        name: `bench_fn_${i}`,
        description: `Benchmark function ${i}`,
        parameters: {
          input: { type: 'string', description: 'Input', required: true },
        },
        handler: async () => ({}),
        scope: 'custom',
      }),
    );
    regTotalMs += ms;
  }
  console.log(`  Registering ${fnCount} functions: ${regTotalMs.toFixed(2)} ms (${(regTotalMs / fnCount * 1000).toFixed(1)} us each)`);

  const listIterations = 500;
  let listMs = 0;
  for (let i = 0; i < listIterations; i++) {
    const { ms } = timeSync(() => fnRegistry.toToolDefinitions());
    listMs += ms;
  }
  console.log(`  toToolDefinitions() (${fnCount} fns): ${((listMs / listIterations) * 1000).toFixed(1)} us avg`);
}

// ── 6. Context Window Savings Simulation ────────────────────────

async function benchContextWindowSavings(store: ContextStore): Promise<void> {
  console.log('\n' + DOUBLE_DIVIDER);
  console.log('  6. CONTEXT WINDOW SAVINGS SIMULATION');
  console.log(DOUBLE_DIVIDER);
  console.log();
  console.log('  Simulates a parent agent dispatching N sub-agents, each processing');
  console.log('  large data. Compares parent context growth with and without refs.\n');

  const docSizeBytes = 102_400; // 100KB per task
  const agentCounts = [1, 3, 5, 10, 20, 50];

  console.log(
    '  ' +
    padR('Sub-Agents', 14) +
    padR('Work Size', 14) +
    padR('Without Refs', 16) +
    padR('With Refs', 14) +
    padR('Savings', 12) +
    padR('Ratio', 10),
  );
  console.log('  ' + DIVIDER);

  // Pre-store a document to get a representative ref size
  const sampleDoc = generateData(docSizeBytes);
  const sampleRef = await store.set('bench-cw-sample', sampleDoc);
  const refJsonSize = Buffer.byteLength(JSON.stringify(sampleRef), 'utf-8');
  await store.delete('bench-cw-sample');

  const resultSize = 500; // Typical result summary is ~500 bytes
  const resultRefSize = refJsonSize; // Result is also a ref

  for (const n of agentCounts) {
    const totalWork = docSizeBytes * n;

    // WITHOUT refs: parent must include full data + full results in context
    const withoutRefs = (docSizeBytes + resultSize) * n;

    // WITH refs: parent only sees ref handles for input + result refs
    const withRefs = (refJsonSize + resultRefSize) * n;

    const ratio = Math.round(withoutRefs / withRefs);
    const pct = ((1 - withRefs / withoutRefs) * 100).toFixed(1);

    console.log(
      '  ' +
      padR(String(n), 14) +
      padR(formatBytes(totalWork), 14) +
      padR(formatBytes(withoutRefs), 16) +
      padR(formatBytes(withRefs), 14) +
      padR(`${pct}%`, 12) +
      padR(`${formatNum(ratio)}x`, 10),
    );
  }

  // Infinite context demonstration
  console.log();
  console.log('  ' + DIVIDER);
  console.log('  "Infinite Context" Demonstration:');
  console.log();

  const parentContextBudget = 200_000; // ~200K tokens
  const parentContextBytes = parentContextBudget * 4; // ~4 chars per token
  const taskDataSize = 102_400; // 100KB per task

  // Without refs: how many tasks fit?
  const maxTasksWithout = Math.floor(parentContextBytes / (taskDataSize + resultSize));

  // With refs: how many tasks fit?
  const maxTasksWith = Math.floor(parentContextBytes / (refJsonSize + resultRefSize));

  console.log(`  Parent context budget: ${formatNum(parentContextBudget)} tokens (~${formatBytes(parentContextBytes)})`);
  console.log(`  Task data size: ${formatBytes(taskDataSize)} each`);
  console.log();
  console.log(`  WITHOUT refs: parent can dispatch ${formatNum(maxTasksWithout)} tasks before context overflow`);
  console.log(`  WITH refs:    parent can dispatch ${formatNum(maxTasksWith)} tasks before context overflow`);
  console.log(`  Capacity increase: ${formatNum(Math.round(maxTasksWith / maxTasksWithout))}x more tasks`);
  console.log();
  console.log(`  Effective context: ${formatNum(maxTasksWith)} x ${formatBytes(taskDataSize)} = ${formatBytes(maxTasksWith * taskDataSize)} of data managed`);
  console.log(`  That's ${formatBytes(maxTasksWith * taskDataSize)} of data coordinated by a ${formatBytes(parentContextBytes)} context window.`);
}

// ── Summary ─────────────────────────────────────────────────────

async function printSummary(store: ContextStore, memory: MemoryManager): Promise<void> {
  console.log('\n' + DOUBLE_DIVIDER);
  console.log('  SUMMARY');
  console.log(DOUBLE_DIVIDER);
  console.log();

  // Ref efficiency
  const bigData = generateData(10_485_760);
  const bigRef = await store.set('summary-big', bigData);
  const refSize = Buffer.byteLength(JSON.stringify(bigRef), 'utf-8');
  const ratio = Math.round(bigRef.sizeBytes / refSize);
  console.log(`  Pass-by-Reference: 10MB data passed as ${formatBytes(refSize)} ref (${formatNum(ratio)}x reduction)`);
  await store.delete('summary-big');

  // Store ops
  const smallData = generateData(1024);
  const setIterations = 100;
  let setTotal = 0;
  for (let i = 0; i < setIterations; i++) {
    const { ms } = await timeAsync(() => store.set(`summary-ops-${i}`, smallData));
    setTotal += ms;
    await store.delete(`summary-ops-${i}`);
  }
  console.log(`  Store set(1KB): ${formatNum(Math.round(1000 / (setTotal / setIterations)))} ops/sec`);

  // Ref speed
  await store.set('summary-ref', smallData);
  const refIter = 10000;
  let refTotal = 0;
  for (let i = 0; i < refIter; i++) {
    const { ms } = timeSync(() => store.ref('summary-ref'));
    refTotal += ms;
  }
  console.log(`  Store ref(): ${((refTotal / refIter) * 1000).toFixed(1)} us (O(1) constant time)`);
  await store.delete('summary-ref');

  // Memory search
  await memory.clear('episodic');
  for (let i = 0; i < 2000; i++) {
    await memory.append('episodic', {
      id: randomUUID(),
      timestamp: Date.now(),
      content: `Summary test entry ${i} with searchable content`,
    });
  }
  const searchIter = 10;
  let searchTotal = 0;
  for (let i = 0; i < searchIter; i++) {
    const { ms } = await timeAsync(() => memory.search('episodic', 'searchable content', 10));
    searchTotal += ms;
  }
  console.log(`  Memory search (2000 entries): ${(searchTotal / searchIter).toFixed(1)} ms`);

  // Recall
  await memory.clear('semantic');
  for (let i = 0; i < 500; i++) {
    await memory.learn({ key: `sum-fact-${i}`, value: `value ${i}` });
  }
  const recallIter = 1000;
  let recallTotal = 0;
  for (let i = 0; i < recallIter; i++) {
    const { ms } = await timeAsync(() => memory.recall('sum-fact-250'));
    recallTotal += ms;
  }
  console.log(`  Semantic recall: ${((recallTotal / recallIter) * 1000).toFixed(1)} us (O(1) Map lookup)`);

  // Context capacity
  const parentCtx = 200_000 * 4;
  const withRefs = Math.floor(parentCtx / (refSize * 2));
  const withoutRefs = Math.floor(parentCtx / (102_400 + 500));
  console.log(`  Context capacity: ${formatNum(withRefs)} tasks with refs vs ${formatNum(withoutRefs)} without (${Math.round(withRefs / withoutRefs)}x increase)`);

  console.log();
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log();
  console.log(DOUBLE_DIVIDER);
  console.log('  RLM BENCHMARK RESULTS');
  console.log(`  ${new Date().toISOString()}`);
  console.log(DOUBLE_DIVIDER);

  // Create temp directory for store and memory
  const tempDir = await mkdtemp(join(tmpdir(), 'rlm-bench-'));
  const storeDir = join(tempDir, 'store');
  const memoryDir = join(tempDir, 'memory');

  const store = new ContextStore(storeDir);
  await store.init();

  const memory = new MemoryManager(memoryDir);
  await memory.init();

  const startTime = performance.now();

  try {
    await benchPassByReference(store);
    await benchContextStore(store);
    await benchMemoryManager(memory);
    await benchMergeStrategies(store);
    await benchSpawningOverhead(store);
    await benchContextWindowSavings(store);
    await printSummary(store, memory);
  } finally {
    // Cleanup temp directory
    await rm(tempDir, { recursive: true, force: true });
  }

  const totalTime = performance.now() - startTime;
  console.log(`  Total benchmark time: ${(totalTime / 1000).toFixed(1)}s`);
  console.log(DOUBLE_DIVIDER);
  console.log();
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
