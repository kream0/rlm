import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { ContextStore } from '../src/context-store.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { RecursiveSpawner } from '../src/recursive-spawner.js';
import { ClaudeCodeProvider } from '../src/claude-code-provider.js';
import { MemoryManager } from '../src/memory-manager.js';
import { FunctionRegistry } from '../src/function-registry.js';

// Path to mock CLI script
const MOCK_CLAUDE = resolve(__dirname, 'mock-claude.sh');
const TEST_DIR = resolve('.rlm-test-data-e2e');

/**
 * End-to-end tests using a mock Claude CLI binary.
 *
 * These tests exercise the full pipeline:
 *   ClaudeCodeProvider -> (spawns mock-claude.sh) -> AgentRuntime -> RecursiveSpawner
 *
 * No real API calls are made. The mock script is a bash script that mimics
 * the `claude -p` JSON output format.
 */
describe('E2E with mock Claude CLI', () => {
  let store: ContextStore;
  let provider: ClaudeCodeProvider;
  let runtime: AgentRuntime;
  let memory: MemoryManager;
  let functions: FunctionRegistry;

  beforeEach(async () => {
    store = new ContextStore(resolve(TEST_DIR, 'vars'));
    await store.init();
    memory = new MemoryManager(resolve(TEST_DIR, 'mem'));
    await memory.init();
    functions = new FunctionRegistry();

    // Point the provider at the mock bash script instead of real `claude`
    provider = new ClaudeCodeProvider({
      binary: MOCK_CLAUDE,
      model: 'opus',
      timeout: 10_000,
    });

    runtime = new AgentRuntime({
      provider,
      store,
      memory,
      functions,
      onLog: () => {}, // silent in tests
    });
  });

  afterEach(async () => {
    await store.clear();
    await memory.clear();
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ---------------------------------------------------------------
  // Verify the mock CLI script is accessible
  // ---------------------------------------------------------------
  it('mock-claude.sh should be executable', async () => {
    await expect(
      access(MOCK_CLAUDE, constants.X_OK),
    ).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------
  // Single agent run - full pipeline
  // ---------------------------------------------------------------
  describe('Single agent run', () => {
    it('should execute a basic prompt through the full pipeline', async () => {
      const agent = runtime.create({
        id: 'e2e-basic',
        prompt: 'analyze the input data',
        model: 'opus',
      });

      const result = await runtime.run(agent);

      expect(result.agentId).toBe('e2e-basic');
      expect(result.iterations).toBe(1);
      expect(typeof result.result).toBe('string');
      expect(result.result).toContain('Analysis complete');
    });

    it('should propagate token usage from the mock CLI', async () => {
      const agent = runtime.create({
        id: 'e2e-tokens',
        prompt: 'analyze something short',
        model: 'opus',
      });

      const result = await runtime.run(agent);

      // The mock calculates tokens from prompt length: input = len/4 + 10, output = input/2 + 5
      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(result.tokenUsage.outputTokens).toBeGreaterThan(0);
      expect(result.tokenUsage.totalTokens).toBe(
        result.tokenUsage.inputTokens + result.tokenUsage.outputTokens,
      );
    });

    it('should propagate cost and session metadata', async () => {
      const agent = runtime.create({
        id: 'e2e-meta',
        prompt: 'analyze metadata test',
        model: 'opus',
      });

      const result = await runtime.run(agent);

      expect(result.costUsd).toBe(0.001);
      expect(result.sessionId).toMatch(/^mock-session-/);
      expect(result.numTurns).toBe(1);
    });

    it('should echo back prompt content in echo mode', async () => {
      const agent = runtime.create({
        id: 'e2e-echo',
        prompt: 'echo: Hello world from e2e test',
        model: 'opus',
      });

      const result = await runtime.run(agent);

      expect(result.result).toContain('Hello world from e2e test');
    });

    it('should handle provider errors gracefully', async () => {
      const agent = runtime.create({
        id: 'e2e-error',
        prompt: 'trigger error simulation',
        model: 'opus',
      });

      const result = await runtime.run(agent);

      // AgentRuntime catches errors and returns them as result.error
      expect(agent.status).toBe('failed');
      expect(result.result).toBeDefined();
      expect((result.result as { error: string }).error).toContain('exited with code 1');
    });
  });

  // ---------------------------------------------------------------
  // Context variable pass-by-reference
  // ---------------------------------------------------------------
  describe('Context variables', () => {
    it('should pass context variables to the agent prompt', async () => {
      const dataRef = await store.set('test-input', {
        items: ['alpha', 'bravo', 'charlie'],
        count: 3,
      }, { type: 'json' });

      const agent = runtime.create({
        id: 'e2e-context',
        prompt: 'echo: received context',
        model: 'opus',
        contextRef: dataRef,
      });

      const result = await runtime.run(agent);

      // The agent should have received the prompt with context appended
      // (we can verify it ran successfully - the context ref was resolved)
      expect(result.result).toBeDefined();
      expect(result.iterations).toBe(1);

      // Verify the context variable is still in the store
      const resolved = await store.get('test-input');
      expect((resolved as { count: number }).count).toBe(3);
    });

    it('should handle large context variables by reference', async () => {
      const largeData = 'x'.repeat(50_000);
      const ref = await store.set('large-ctx', largeData, { type: 'text' });

      // The ref itself is small
      expect(JSON.stringify(ref).length).toBeLessThan(300);
      expect(ref.sizeBytes).toBeGreaterThan(49_000);

      const agent = runtime.create({
        id: 'e2e-large-ctx',
        prompt: 'echo: processed large context',
        model: 'opus',
        contextRef: ref,
      });

      const result = await runtime.run(agent);
      expect(result.iterations).toBe(1);
      expect(result.result).toContain('processed large context');
    });
  });

  // ---------------------------------------------------------------
  // Memory integration
  // ---------------------------------------------------------------
  describe('Memory integration', () => {
    it('should log agent execution to episodic memory', async () => {
      const agent = runtime.create({
        id: 'e2e-mem',
        prompt: 'analyze with memory tracking',
        model: 'opus',
      });

      await runtime.run(agent);

      const episodic = memory.getEpisodicMemory();
      expect(episodic.length).toBeGreaterThan(0);

      const entry = episodic.find((e) => e.metadata?.agentId === 'e2e-mem');
      expect(entry).toBeDefined();
      expect(entry!.metadata?.status).toBe('completed');
    });

    it('should log failures to episodic memory', async () => {
      const agent = runtime.create({
        id: 'e2e-mem-fail',
        prompt: 'trigger error for memory test',
        model: 'opus',
      });

      await runtime.run(agent);

      const episodic = memory.getEpisodicMemory();
      const failEntry = episodic.find((e) => e.metadata?.agentId === 'e2e-mem-fail');
      expect(failEntry).toBeDefined();
      expect(failEntry!.metadata?.status).toBe('failed');
    });
  });

  // ---------------------------------------------------------------
  // Function registry integration
  // ---------------------------------------------------------------
  describe('Function registry integration', () => {
    it('should include function descriptions in the agent prompt', async () => {
      functions.register({
        name: 'calculate',
        description: 'Perform a calculation',
        parameters: {
          expression: {
            type: 'string',
            description: 'Math expression to evaluate',
            required: true,
          },
        },
        handler: async (params) => {
          const expr = params.expression as string;
          return `calculated: ${expr}`;
        },
      });

      // Use echo mode so we can verify the prompt was built
      // (even though we cannot directly inspect it, the agent runs successfully
      //  with functions injected into the prompt)
      const agent = runtime.create({
        id: 'e2e-funcs',
        prompt: 'echo: function test',
        model: 'opus',
      });

      const result = await runtime.run(agent);
      expect(result.iterations).toBe(1);
      expect(result.result).toContain('function test');
    });
  });

  // ---------------------------------------------------------------
  // Fan-out/fan-in with RecursiveSpawner
  // ---------------------------------------------------------------
  describe('Fan-out / fan-in', () => {
    let spawner: RecursiveSpawner;

    beforeEach(() => {
      spawner = new RecursiveSpawner({
        runtime,
        store,
        defaultModel: 'opus',
        maxDepth: 5,
        maxConcurrent: 3,
        onLog: () => {},
      });
    });

    it('should spawn a single sub-agent and return a result ref', async () => {
      const resultRef = await spawner.spawn({
        prompt: 'echo: sub-agent result one',
        context: {},
      });

      expect(resultRef).toBeDefined();
      expect(resultRef.key).toMatch(/^sub-result-/);
      expect(resultRef.type).toBe('result');

      const resolved = await store.resolve(resultRef);
      expect(resolved).toContain('sub-agent result one');
    });

    it('should fan-out multiple sub-agents in parallel', async () => {
      const configs = [
        { prompt: 'echo: result-A', context: {} },
        { prompt: 'echo: result-B', context: {} },
        { prompt: 'echo: result-C', context: {} },
      ];

      const refs = await spawner.spawnMany(configs);

      expect(refs).toHaveLength(3);

      const results = await Promise.all(
        refs.map((ref) => store.resolve(ref)),
      );
      expect(results[0]).toContain('result-A');
      expect(results[1]).toContain('result-B');
      expect(results[2]).toContain('result-C');
    });

    it('should merge results with concatenate strategy', async () => {
      const configs = [
        { prompt: 'echo: part-1', context: {} },
        { prompt: 'echo: part-2', context: {} },
      ];

      const refs = await spawner.spawnMany(configs);
      const merged = await spawner.merge(refs, { type: 'concatenate' });
      const value = await store.resolve(merged) as string;

      expect(value).toContain('part-1');
      expect(value).toContain('part-2');
      expect(value).toContain('---'); // concatenate separator
    });

    it('should merge results with structured strategy', async () => {
      const configs = [
        { prompt: 'echo: alpha', context: {} },
        { prompt: 'echo: bravo', context: {} },
      ];

      const refs = await spawner.spawnMany(configs);
      const merged = await spawner.merge(refs, { type: 'structured' });
      const value = await store.resolve(merged) as Record<string, unknown>;

      // Structured merge keys are the ref keys (sub-result-{uuid})
      const keys = Object.keys(value);
      expect(keys).toHaveLength(2);
      const values = Object.values(value) as string[];
      expect(values.some((v) => v.includes('alpha'))).toBe(true);
      expect(values.some((v) => v.includes('bravo'))).toBe(true);
    });

    it('should merge results with vote strategy', async () => {
      const configs = [
        { prompt: 'echo: consensus', context: {} },
        { prompt: 'echo: consensus', context: {} },
        { prompt: 'echo: outlier', context: {} },
      ];

      const refs = await spawner.spawnMany(configs);
      const merged = await spawner.merge(refs, { type: 'vote' });
      const value = await store.resolve(merged) as { winner: string; votes: Record<string, unknown> };

      expect(value.winner).toContain('consensus');
      expect(value.votes).toBeDefined();
    });

    it('should merge results with custom strategy', async () => {
      const configs = [
        { prompt: 'echo: item-1', context: {} },
        { prompt: 'echo: item-2', context: {} },
      ];

      const refs = await spawner.spawnMany(configs);
      const merged = await spawner.merge(refs, {
        type: 'custom',
        customMergeFn: async (results) => ({
          combined: (results as string[]).join(' + '),
          count: results.length,
        }),
      });
      const value = await store.resolve(merged) as { combined: string; count: number };

      expect(value.count).toBe(2);
      expect(value.combined).toContain('item-1');
      expect(value.combined).toContain('item-2');
    });

    it('should track token usage across fan-out agents', async () => {
      const configs = [
        { prompt: 'echo: token-test-1', context: {} },
        { prompt: 'echo: token-test-2', context: {} },
        { prompt: 'echo: token-test-3', context: {} },
      ];

      await spawner.spawnMany(configs);

      const totalUsage = spawner.getTotalTokenUsage();
      expect(totalUsage.inputTokens).toBeGreaterThan(0);
      expect(totalUsage.outputTokens).toBeGreaterThan(0);
      expect(totalUsage.totalTokens).toBe(
        totalUsage.inputTokens + totalUsage.outputTokens,
      );

      // 3 agents should have accumulated more tokens than a single agent
      expect(totalUsage.totalTokens).toBeGreaterThan(30);
    });

    it('should track total tokens used for budget enforcement', async () => {
      expect(spawner.getTotalTokensUsed()).toBe(0);

      await spawner.spawn({ prompt: 'echo: budget-test', context: {} });

      expect(spawner.getTotalTokensUsed()).toBeGreaterThan(0);
    });

    it('should build an agent tree', async () => {
      await spawner.spawn({ prompt: 'echo: root-task', context: {} });

      const tree = spawner.getTree();
      expect(tree.id).not.toBe('none');
      expect(tree.status).toBe('completed');
      expect(tree.tokenUsage.totalTokens).toBeGreaterThan(0);
    });

    it('should pass context variables to sub-agents', async () => {
      const inputRef = await store.set('sub-input', {
        data: [1, 2, 3],
      }, { type: 'json', persist: true });

      const resultRef = await spawner.spawn({
        prompt: 'echo: got context',
        context: { myInput: inputRef },
      });

      // Verify the sub-agent ran and produced a result
      const result = await store.resolve(resultRef);
      expect(result).toContain('got context');

      // Verify a manifest file was created for the sub-agent
      const vars = await store.list({ type: 'json' });
      const manifestVars = vars.filter((v) => v.key.startsWith('manifest-'));
      expect(manifestVars.length).toBeGreaterThan(0);
    });

    it('should handle sub-agent errors without crashing the spawner', async () => {
      const configs = [
        { prompt: 'echo: success-result', context: {} },
        { prompt: 'trigger error in sub-agent', context: {} },
        { prompt: 'echo: another-success', context: {} },
      ];

      const refs = await spawner.spawnMany(configs);

      // All refs should exist (errors are stored as error results)
      expect(refs).toHaveLength(3);

      const results = await Promise.all(
        refs.map((ref) => store.resolve(ref)),
      );

      // First and third should be successful
      expect(results[0]).toContain('success-result');
      expect(results[2]).toContain('another-success');

      // Second should be an error object
      const errorResult = results[1] as { error: string };
      expect(errorResult.error).toBeDefined();
    });
  });

  // ---------------------------------------------------------------
  // Decompose (context chunking)
  // ---------------------------------------------------------------
  describe('Decompose', () => {
    let spawner: RecursiveSpawner;

    beforeEach(() => {
      spawner = new RecursiveSpawner({
        runtime,
        store,
        defaultModel: 'opus',
        maxDepth: 5,
        maxConcurrent: 3,
        onLog: () => {},
      });
    });

    it('should decompose a source variable into chunks and merge', async () => {
      const sourceData = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
      const sourceRef = await store.set('decompose-src', sourceData, { type: 'text' });

      const mergedRef = await spawner.decompose({
        prompt: 'summarize this chunk',
        sourceRef,
        chunks: 3,
        mergeStrategy: { type: 'concatenate' },
      });

      const merged = await store.resolve(mergedRef) as string;
      expect(merged).toBeDefined();
      expect(typeof merged).toBe('string');
      expect(merged.length).toBeGreaterThan(0);

      // Should have processed 3 chunks - result should contain separator
      expect(merged).toContain('---');

      // Tokens should have been consumed
      expect(spawner.getTotalTokensUsed()).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------
  // Token budget enforcement
  // ---------------------------------------------------------------
  describe('Token budget enforcement', () => {
    it('should reject spawn when budget is exhausted', async () => {
      const spawner = new RecursiveSpawner({
        runtime,
        store,
        defaultModel: 'opus',
        maxDepth: 5,
        maxConcurrent: 3,
        tokenBudget: 1, // extremely tight budget
        onLog: () => {},
      });

      // First spawn will succeed (budget checked before execution)
      // but after it completes, the totalTokensUsed will exceed the budget
      await spawner.spawn({ prompt: 'echo: first', context: {} });

      // Second spawn should fail because budget is now exhausted
      await expect(
        spawner.spawn({ prompt: 'echo: second', context: {} }),
      ).rejects.toThrow(/[Tt]oken budget/);
    });
  });

  // ---------------------------------------------------------------
  // Max depth enforcement
  // ---------------------------------------------------------------
  describe('Depth enforcement', () => {
    it('should reject spawn when max depth is exceeded', async () => {
      const spawner = new RecursiveSpawner({
        runtime,
        store,
        defaultModel: 'opus',
        maxDepth: 2,
        maxConcurrent: 3,
        onLog: () => {},
      });

      // Spawn at depth 0 - OK
      await spawner.spawn({ prompt: 'echo: depth-0', context: {} }, undefined, 0);

      // Spawn at depth 2 (= maxDepth) - should fail
      await expect(
        spawner.spawn({ prompt: 'echo: too-deep', context: {} }, undefined, 2),
      ).rejects.toThrow(/[Mm]aximum recursion depth/);
    });
  });

  // ---------------------------------------------------------------
  // Concurrency control
  // ---------------------------------------------------------------
  describe('Concurrency control', () => {
    it('should respect maxConcurrent limit', async () => {
      const spawner = new RecursiveSpawner({
        runtime,
        store,
        defaultModel: 'opus',
        maxDepth: 5,
        maxConcurrent: 2,
        onLog: () => {},
      });

      // Spawn 4 agents with maxConcurrent=2
      // They should all complete (concurrency is managed internally)
      const configs = [
        { prompt: 'echo: concurrent-1', context: {} },
        { prompt: 'echo: concurrent-2', context: {} },
        { prompt: 'echo: concurrent-3', context: {} },
        { prompt: 'echo: concurrent-4', context: {} },
      ];

      const refs = await spawner.spawnMany(configs);
      expect(refs).toHaveLength(4);

      const results = await Promise.all(
        refs.map((ref) => store.resolve(ref)),
      );
      expect(results[0]).toContain('concurrent-1');
      expect(results[1]).toContain('concurrent-2');
      expect(results[2]).toContain('concurrent-3');
      expect(results[3]).toContain('concurrent-4');

      // After all complete, active count should be 0
      expect(spawner.getActiveCount()).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // Provider options passthrough
  // ---------------------------------------------------------------
  describe('Provider configuration', () => {
    it('should use custom binary path', async () => {
      // Verify our provider is using the mock binary (already set in beforeEach)
      const agent = runtime.create({
        id: 'e2e-binary-test',
        prompt: 'echo: binary test passed',
        model: 'opus',
      });

      const result = await runtime.run(agent);
      expect(result.result).toContain('binary test passed');
    });

    it('should handle timeout configuration', async () => {
      // Create a provider with a very short timeout
      // The mock script is fast so this should still pass
      const fastProvider = new ClaudeCodeProvider({
        binary: MOCK_CLAUDE,
        model: 'opus',
        timeout: 5_000,
      });

      const fastRuntime = new AgentRuntime({
        provider: fastProvider,
        store,
        onLog: () => {},
      });

      const agent = fastRuntime.create({
        id: 'e2e-timeout-test',
        prompt: 'echo: fast response',
        model: 'opus',
      });

      const result = await fastRuntime.run(agent);
      expect(result.result).toContain('fast response');
    });
  });

  // ---------------------------------------------------------------
  // Full pipeline: store -> agent -> spawner -> merge -> retrieve
  // ---------------------------------------------------------------
  describe('Full pipeline', () => {
    it('should run a complete store -> spawn -> merge -> retrieve pipeline', async () => {
      // 1. Store input data
      const inputRef = await store.set('pipeline-input', {
        documents: ['doc-A', 'doc-B', 'doc-C'],
      }, { type: 'json' });

      // 2. Create spawner
      const spawner = new RecursiveSpawner({
        runtime,
        store,
        defaultModel: 'opus',
        maxDepth: 5,
        maxConcurrent: 3,
        onLog: () => {},
      });

      // 3. Fan-out: spawn one agent per document
      const configs = [
        { prompt: 'echo: analyzed doc-A', context: { input: inputRef } },
        { prompt: 'echo: analyzed doc-B', context: { input: inputRef } },
        { prompt: 'echo: analyzed doc-C', context: { input: inputRef } },
      ];
      const resultRefs = await spawner.spawnMany(configs);

      // 4. Fan-in: merge results
      const mergedRef = await spawner.merge(resultRefs, { type: 'structured' });

      // 5. Verify merged result
      const merged = await store.resolve(mergedRef) as Record<string, string>;
      const values = Object.values(merged);
      expect(values).toHaveLength(3);
      expect(values.some((v) => v.includes('doc-A'))).toBe(true);
      expect(values.some((v) => v.includes('doc-B'))).toBe(true);
      expect(values.some((v) => v.includes('doc-C'))).toBe(true);

      // 6. Verify token tracking
      const totalUsage = spawner.getTotalTokenUsage();
      expect(totalUsage.totalTokens).toBeGreaterThan(0);

      // 7. Verify tree
      const tree = spawner.getTree();
      expect(tree.status).toBe('completed');

      // 8. Verify memory recorded all executions
      const episodic = memory.getEpisodicMemory();
      expect(episodic.length).toBe(3); // 3 agents logged
    });
  });

  // ---------------------------------------------------------------
  // Reset behavior
  // ---------------------------------------------------------------
  describe('Reset', () => {
    it('should reset spawner state between runs', async () => {
      const spawner = new RecursiveSpawner({
        runtime,
        store,
        defaultModel: 'opus',
        maxDepth: 5,
        maxConcurrent: 3,
        onLog: () => {},
      });

      // First run
      await spawner.spawn({ prompt: 'echo: run-1', context: {} });
      expect(spawner.getTotalTokensUsed()).toBeGreaterThan(0);

      const firstTokens = spawner.getTotalTokensUsed();

      // Reset
      spawner.reset();
      expect(spawner.getTotalTokensUsed()).toBe(0);
      expect(spawner.getActiveCount()).toBe(0);
      expect(spawner.getTree().id).toBe('none');

      // Second run starts fresh
      await spawner.spawn({ prompt: 'echo: run-2', context: {} });
      const secondTokens = spawner.getTotalTokensUsed();

      // Second run should have roughly the same tokens as the first
      // (not accumulated from before reset)
      expect(secondTokens).toBeLessThan(firstTokens * 2);
    });
  });
});
