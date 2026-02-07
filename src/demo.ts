/**
 * RLM Demo - Demonstrates the Recursive Language Model paradigm
 *
 * This demo shows:
 * 1. Context Store: Variables passed by reference, not value
 * 2. Registry: Custom callbacks via FunctionRegistry
 * 3. Memory Manager: Episodic, semantic, procedural memory
 * 4. Merge Strategies: Fan-out/fan-in result combination
 *
 * Run with: bun run demo
 */

import { ContextStore } from './context-store.js';
import { FunctionRegistry } from './function-registry.js';
import { MemoryManager } from './memory-manager.js';
import { AgentRuntime } from './agent-runtime.js';
import { RecursiveSpawner } from './recursive-spawner.js';
import { resolve } from 'node:path';
import type { LLMProvider, ExecutionResult } from './types.js';

async function demo() {
  console.log('=== RLM Demo: Recursive Language Model ===\n');

  // --- 1. Context Store Demo ---
  console.log('--- 1. Context Store: Pass-by-Reference Variables ---\n');

  const storageDir = resolve('.rlm-demo-data');
  const store = new ContextStore(resolve(storageDir, 'variables'));
  await store.init();

  // Store a large document
  const largeDoc = 'Lorem ipsum '.repeat(1000); // ~12KB
  const docRef = await store.set('large-document', largeDoc, { type: 'text' });
  console.log(`Stored document: ${docRef.sizeBytes} bytes`);
  console.log(`Reference size: ${JSON.stringify(docRef).length} bytes (the ref is tiny!)`);
  console.log(`Key insight: Sub-agents receive the ${JSON.stringify(docRef).length}-byte ref, NOT the ${docRef.sizeBytes}-byte document\n`);

  // Store structured data
  const dataset = Array.from({ length: 100 }, (_, i) => ({
    id: i,
    value: Math.random() * 100,
    category: ['A', 'B', 'C'][i % 3],
  }));
  const dataRef = await store.set('dataset', dataset, { type: 'json' });
  console.log(`Stored dataset: ${dataRef.sizeBytes} bytes, type: ${dataRef.type}`);

  // Get a summary (no LLM needed for basic summary)
  const summary = await store.summarize('dataset', 50);
  console.log(`Summary (50 tokens): ${summary.slice(0, 100)}...`);

  // List variables
  const vars = await store.list();
  console.log(`\nVariables in store: ${vars.length}`);
  for (const v of vars) {
    console.log(`  ${v.key}: ${v.type}, ${v.sizeBytes} bytes, scope: ${v.scope}`);
  }

  // --- 2. Registry Demo ---
  console.log('\n--- 2. Registry: Everything is a Callable ---\n');

  const registry = new FunctionRegistry();

  // Register a custom tool
  registry.register({
    name: 'add_numbers',
    description: 'Add two numbers together',
    parameters: {
      a: { type: 'number', description: 'First number', required: true },
      b: { type: 'number', description: 'Second number', required: true },
    },
    handler: async (params) => {
      return { result: (params.a as number) + (params.b as number) };
    },
  });

  const tools = registry.list();
  console.log(`Registered tools: ${tools.length}`);
  for (const tool of tools) {
    console.log(`  ${tool.name}: ${tool.description.slice(0, 60)}...`);
  }

  const addResult = await registry.execute('add_numbers', { a: 42, b: 58 });
  console.log(`\nadd_numbers(42, 58) = ${JSON.stringify(addResult)}`);

  // --- 3. Memory Manager Demo ---
  console.log('\n--- 3. Memory Manager: Infinite Context via Offloading ---\n');

  const memory = new MemoryManager(resolve(storageDir, 'memory'));
  await memory.init();

  for (let i = 0; i < 5; i++) {
    await memory.append('working', {
      id: `w${i}`,
      timestamp: Date.now() - (5 - i) * 1000,
      content: `Iteration ${i}: Analyzed section ${i} of the document`,
      metadata: { iteration: i },
    });
  }

  await memory.append('episodic', {
    id: 'e1',
    timestamp: Date.now(),
    content: 'Successfully processed the dataset and found 3 anomalies',
    metadata: { action: 'analyze', result: 'success' },
  });

  await memory.learn({
    key: 'anomaly-pattern',
    value: 'Anomalies in this dataset correlate with values > 90',
  });

  const searchResults = await memory.search('working', 'analyzed section');
  console.log(`Working memory search for "analyzed section": ${searchResults.length} results`);

  const recalled = await memory.recall('anomaly-pattern');
  console.log(`Recalled knowledge: ${recalled?.key} = ${recalled?.value}`);

  const stats = memory.getStats();
  console.log(`\nMemory stats:`);
  console.log(`  Working: ~${stats.workingMemoryTokens} tokens`);
  console.log(`  Episodic: ${stats.episodicEntryCount} entries`);
  console.log(`  Semantic: ${stats.semanticEntryCount} entries`);
  console.log(`  Procedural: ${stats.proceduralRuleCount} rules`);
  console.log(`  Total storage: ${stats.totalStorageBytes} bytes`);

  // --- 4. Merge Strategies Demo ---
  console.log('\n--- 4. Merge Strategies ---\n');

  const ref1 = await store.set('result-1', 'Found pattern A in section 1', { type: 'result' });
  const ref2 = await store.set('result-2', 'Found pattern B in section 2', { type: 'result' });
  const ref3 = await store.set('result-3', 'Found pattern A in section 3', { type: 'result' });

  // Mock provider for demo
  const mockProvider: LLMProvider = {
    execute: async () => ({ result: 'done' } as ExecutionResult),
  };

  const runtime = new AgentRuntime({
    store,
    onLog: () => {},
    provider: mockProvider,
  });

  const spawner = new RecursiveSpawner({
    runtime,
    store,
    defaultModel: 'claude-sonnet-4-5-20250929',
    maxDepth: 5,
    maxConcurrent: 3,
    onLog: (msg) => console.log(`  [spawner] ${msg}`),
  });

  const concatRef = await spawner.merge([ref1, ref2, ref3], { type: 'concatenate' });
  const concatResult = await store.get(concatRef.key);
  console.log(`Concatenated: ${JSON.stringify(concatResult).slice(0, 100)}...`);

  const structRef = await spawner.merge([ref1, ref2], { type: 'structured' });
  const structResult = await store.get(structRef.key);
  console.log(`Structured: ${JSON.stringify(structResult).slice(0, 100)}...`);

  const voteRef = await spawner.merge([ref1, ref3], { type: 'vote' });
  const voteResult = await store.get(voteRef.key);
  console.log(`Vote: ${JSON.stringify(voteResult).slice(0, 100)}...`);

  // --- Summary ---
  console.log('\n=== Demo Complete ===');
  console.log('\nKey Paradigm Shifts Demonstrated:');
  console.log('1. Variables are references, not values - sub-agents get handles, not copies');
  console.log('2. Custom callbacks via FunctionRegistry for extensibility');
  console.log('3. Memory is infinite - working memory compacts, episodic/semantic persist');
  console.log('4. Agents are recursive - they spawn more of themselves and merge results');
  console.log('5. Context windows stay clean - no matter how much work sub-agents do');

  // Cleanup
  await store.clear();
  await memory.clear();
}

demo().catch(console.error);
