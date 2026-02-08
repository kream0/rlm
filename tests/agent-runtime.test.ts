import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRuntime } from '../src/agent-runtime.js';
import { ContextStore } from '../src/context-store.js';
import { FunctionRegistry } from '../src/function-registry.js';
import { MemoryManager } from '../src/memory-manager.js';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import type { LLMProvider, ExecutionResult, IMemoryManager, MemoryType, MemoryEntry, KnowledgeEntry, CompactOptions, MemoryStats } from '../src/types.js';

const TEST_DIR = resolve('.rlm-test-data-runtime');

function createMockProvider(result: string = 'Task complete'): LLMProvider {
  return {
    execute: vi.fn(async () => ({
      result,
      costUsd: 0.01,
      durationMs: 500,
      sessionId: 'sess-123',
      numTurns: 3,
    } as ExecutionResult)),
  };
}

describe('AgentRuntime', () => {
  let store: ContextStore;
  let logs: string[];

  beforeEach(async () => {
    store = new ContextStore(TEST_DIR);
    await store.init();
    logs = [];
  });

  afterEach(async () => {
    await store.clear();
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('should create an agent', () => {
    const provider = createMockProvider();
    const runtime = new AgentRuntime({
      store, provider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'test-agent', prompt: 'Do something',
      model: 'claude-sonnet-4-5-20250929',
    });

    expect(agent.id).toBe('test-agent');
    expect(agent.status).toBe('idle');
    expect(agent.iterations).toBe(0);
  });

  it('should run an agent that returns text', async () => {
    const provider = createMockProvider('Hello, task complete!');

    const runtime = new AgentRuntime({
      store, provider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'text-agent', prompt: 'Say hello',
      model: 'claude-sonnet-4-5-20250929',
    });

    const result = await runtime.run(agent);
    expect(result.agentId).toBe('text-agent');
    expect(result.result).toBe('Hello, task complete!');
    expect(result.iterations).toBe(1);
    expect(agent.status).toBe('completed');
  });

  it('should return execution metadata', async () => {
    const provider = createMockProvider('Done');

    const runtime = new AgentRuntime({
      store, provider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'meta-agent', prompt: 'Work',
      model: 'claude-sonnet-4-5-20250929',
    });

    const result = await runtime.run(agent);
    expect(result.costUsd).toBe(0.01);
    expect(result.sessionId).toBe('sess-123');
    expect(result.numTurns).toBe(3);
  });

  it('should cancel an agent', async () => {
    const provider = createMockProvider();
    const runtime = new AgentRuntime({
      store, provider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'cancel-agent', prompt: 'Take your time',
      model: 'claude-sonnet-4-5-20250929',
    });

    await runtime.cancel('cancel-agent');
    const result = await runtime.run(agent);
    expect(agent.status).toBe('cancelled');
  });

  it('should get agent status', () => {
    const provider = createMockProvider();
    const runtime = new AgentRuntime({
      store, provider,
    });

    runtime.create({
      id: 'status-agent', prompt: 'Test',
      model: 'claude-sonnet-4-5-20250929',
    });

    expect(runtime.getStatus('status-agent')).toBe('idle');
    expect(runtime.getStatus('nonexistent')).toBeUndefined();
  });

  it('should include context ref summary in prompt', async () => {
    await store.set('my-context', 'Important context data');

    const provider = createMockProvider('Done with context');

    const runtime = new AgentRuntime({
      store, provider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const contextRef = store.ref('my-context');
    const agent = runtime.create({
      id: 'ctx-agent', prompt: 'Use the context',
      model: 'claude-sonnet-4-5-20250929', contextRef,
    });

    await runtime.run(agent);
    const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(executeCall.prompt).toContain('my-context');
  });

  it('should handle provider errors', async () => {
    const errorProvider: LLMProvider = {
      execute: vi.fn(async () => { throw new Error('API rate limit exceeded'); }),
    };

    const runtime = new AgentRuntime({
      store, provider: errorProvider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'error-llm', prompt: 'This will fail',
      model: 'claude-sonnet-4-5-20250929',
    });

    const result = await runtime.run(agent);
    expect(agent.status).toBe('failed');
    expect((result.result as Record<string, unknown>).error).toContain('rate limit');
  });

  it('should not store result in context store (delegated to RecursiveSpawner)', async () => {
    const provider = createMockProvider('Task result');

    const runtime = new AgentRuntime({
      store, provider,
    });

    const agent = runtime.create({
      id: 'no-store', prompt: 'Do work',
      model: 'claude-sonnet-4-5-20250929',
    });

    await runtime.run(agent);
    expect(store.has('agent-result-no-store')).toBe(false);
  });

  it('should propagate token usage from provider', async () => {
    const provider: LLMProvider = {
      execute: vi.fn(async () => ({
        result: 'Done',
        tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      } as ExecutionResult)),
    };

    const runtime = new AgentRuntime({ store, provider });
    const agent = runtime.create({ id: 'token-agent', prompt: 'Test', model: 'opus' });
    const result = await runtime.run(agent);

    expect(result.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect(agent.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  it('should pass model to provider', async () => {
    const provider = createMockProvider('Done');

    const runtime = new AgentRuntime({
      store, provider,
    });

    const agent = runtime.create({
      id: 'model-agent', prompt: 'Test',
      model: 'claude-haiku-4-5-20251001',
    });

    await runtime.run(agent);
    const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(executeCall.model).toBe('claude-haiku-4-5-20251001');
  });

  it('should include function descriptions in prompt', async () => {
    const provider = createMockProvider('Done');
    const registry = new FunctionRegistry();
    registry.register({
      name: 'analyzeData',
      description: 'Analyze a dataset',
      parameters: {
        input: { type: 'string', description: 'The input data', required: true },
        format: { type: 'string', description: 'Output format', required: false },
      },
      handler: async () => 'result',
    });

    const runtime = new AgentRuntime({
      store, provider, functions: registry,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'fn-agent', prompt: 'Use functions',
      model: 'opus',
    });

    await runtime.run(agent);
    const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(executeCall.prompt).toContain('Available functions');
    expect(executeCall.prompt).toContain('analyzeData');
    expect(executeCall.prompt).toContain('Analyze a dataset');
    expect(executeCall.prompt).toContain('input: string');
  });

  it('should inject relevant episodic memory into prompt', async () => {
    const memDir = resolve('.rlm-test-data-runtime-mem');
    const memory = new MemoryManager(memDir);
    await memory.init();

    // Pre-populate episodic memory
    await memory.append('episodic', {
      id: 'past-1',
      timestamp: Date.now(),
      content: 'Agent past-task completed: Analyzed customer data successfully',
      metadata: { agentId: 'past-task', status: 'completed' },
    });

    const provider = createMockProvider('Done');
    const runtime = new AgentRuntime({
      store, provider, memory,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'mem-prompt-agent', prompt: 'Analyze customer data',
      model: 'opus',
    });

    await runtime.run(agent);
    const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(executeCall.prompt).toContain('Relevant past agent executions');
    expect(executeCall.prompt).toContain('customer data');

    await memory.clear();
    try { await rm(memDir, { recursive: true, force: true }); } catch {}
  });

  describe('function registry integration', () => {
    it('should include function descriptions in agent prompts', async () => {
      const provider = createMockProvider('Done');
      const registry = new FunctionRegistry();
      registry.register({
        name: 'summarize',
        description: 'Summarize a text document',
        parameters: {
          text: { type: 'string', description: 'The text to summarize', required: true },
          maxLength: { type: 'number', description: 'Maximum summary length', required: false },
        },
        handler: async () => 'summary',
      });

      const runtime = new AgentRuntime({
        store, provider, functions: registry,
        onLog: (_id, msg) => logs.push(msg),
      });

      const agent = runtime.create({
        id: 'fn-desc-agent', prompt: 'Summarize this document',
        model: 'opus',
      });

      await runtime.run(agent);
      const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executeCall.prompt).toContain('Available functions (for reference):');
      expect(executeCall.prompt).toContain('summarize');
      expect(executeCall.prompt).toContain('Summarize a text document');
      expect(executeCall.prompt).toContain('text: string');
      expect(executeCall.prompt).toContain('The text to summarize');
      expect(executeCall.prompt).toContain('maxLength: number?');
      expect(executeCall.prompt).toContain('Maximum summary length');
    });

    it('should include multiple registered functions in prompts', async () => {
      const provider = createMockProvider('Done');
      const registry = new FunctionRegistry();

      registry.register({
        name: 'fetchData',
        description: 'Fetch data from a source',
        parameters: {
          url: { type: 'string', description: 'Data source URL', required: true },
        },
        handler: async () => '{}',
      });

      registry.register({
        name: 'transformData',
        description: 'Transform data into target format',
        parameters: {
          data: { type: 'object', description: 'Input data object', required: true },
          format: { type: 'string', description: 'Target format', required: true },
        },
        handler: async () => '{}',
      });

      registry.register({
        name: 'validateOutput',
        description: 'Validate the processed output',
        parameters: {
          output: { type: 'object', description: 'Output to validate', required: true },
          strict: { type: 'boolean', description: 'Use strict validation', required: false },
        },
        handler: async () => true,
      });

      const runtime = new AgentRuntime({
        store, provider, functions: registry,
        onLog: (_id, msg) => logs.push(msg),
      });

      const agent = runtime.create({
        id: 'multi-fn-agent', prompt: 'Process the pipeline',
        model: 'opus',
      });

      await runtime.run(agent);
      const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const prompt = executeCall.prompt as string;

      // All three functions should be present
      expect(prompt).toContain('fetchData');
      expect(prompt).toContain('Fetch data from a source');
      expect(prompt).toContain('transformData');
      expect(prompt).toContain('Transform data into target format');
      expect(prompt).toContain('validateOutput');
      expect(prompt).toContain('Validate the processed output');

      // Parameter details should be present for all functions
      expect(prompt).toContain('url: string');
      expect(prompt).toContain('data: object');
      expect(prompt).toContain('format: string');
      expect(prompt).toContain('strict: boolean?');
    });

    it('should add nothing to prompt when function registry is empty', async () => {
      const provider = createMockProvider('Done');
      const registry = new FunctionRegistry();
      // Registry exists but has no functions registered

      const runtime = new AgentRuntime({
        store, provider, functions: registry,
        onLog: (_id, msg) => logs.push(msg),
      });

      const agent = runtime.create({
        id: 'empty-fn-agent', prompt: 'Do a task',
        model: 'opus',
      });

      await runtime.run(agent);
      const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executeCall.prompt).not.toContain('Available functions');
    });

    it('should run normally when no function registry is provided', async () => {
      const provider = createMockProvider('Completed without functions');

      const runtime = new AgentRuntime({
        store, provider,
        onLog: (_id, msg) => logs.push(msg),
      });

      const agent = runtime.create({
        id: 'no-fn-agent', prompt: 'Run without functions',
        model: 'opus',
      });

      const result = await runtime.run(agent);
      expect(result.result).toBe('Completed without functions');
      expect(agent.status).toBe('completed');

      const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executeCall.prompt).not.toContain('Available functions');
      expect(executeCall.prompt).toContain('Run without functions');
    });
  });

  describe('memory integration', () => {
    function createMockMemory(overrides?: Partial<IMemoryManager>): IMemoryManager {
      return {
        append: vi.fn(async () => {}),
        search: vi.fn(async () => []),
        learn: vi.fn(async () => {}),
        recall: vi.fn(async () => null),
        compact: vi.fn(async () => {}),
        getStats: vi.fn(() => ({
          workingMemoryTokens: 0,
          episodicEntryCount: 0,
          semanticEntryCount: 0,
          proceduralRuleCount: 0,
          totalStorageBytes: 0,
        })),
        clear: vi.fn(async () => {}),
        ...overrides,
      };
    }

    it('should record agent completion in episodic memory', async () => {
      const mockMemory = createMockMemory();
      const provider = createMockProvider('Analysis complete');

      const runtime = new AgentRuntime({
        store, provider, memory: mockMemory,
        onLog: (_id, msg) => logs.push(msg),
      });

      const agent = runtime.create({
        id: 'mem-complete', prompt: 'Analyze data',
        model: 'opus',
      });

      await runtime.run(agent);

      const appendMock = mockMemory.append as ReturnType<typeof vi.fn>;
      expect(appendMock).toHaveBeenCalledWith(
        'episodic',
        expect.objectContaining({
          id: 'mem-complete',
          content: expect.stringContaining('Agent mem-complete completed'),
          metadata: expect.objectContaining({
            agentId: 'mem-complete',
            model: 'opus',
            iterations: 1,
            status: 'completed',
          }),
        }),
      );

      // Verify the content includes the result text
      const appendCall = appendMock.mock.calls.find(
        (call: [MemoryType, MemoryEntry]) => call[1].metadata?.status === 'completed'
      );
      expect(appendCall).toBeDefined();
      expect(appendCall![1].content).toContain('Analysis complete');
    });

    it('should record agent failure in episodic memory', async () => {
      const mockMemory = createMockMemory();
      const errorProvider: LLMProvider = {
        execute: vi.fn(async () => { throw new Error('Connection timeout'); }),
      };

      const runtime = new AgentRuntime({
        store, provider: errorProvider, memory: mockMemory,
        onLog: (_id, msg) => logs.push(msg),
      });

      const agent = runtime.create({
        id: 'mem-fail', prompt: 'Failing task',
        model: 'opus',
      });

      const result = await runtime.run(agent);
      expect(agent.status).toBe('failed');

      const appendMock = mockMemory.append as ReturnType<typeof vi.fn>;
      expect(appendMock).toHaveBeenCalledWith(
        'episodic',
        expect.objectContaining({
          id: 'mem-fail',
          content: expect.stringContaining('Agent mem-fail failed'),
          metadata: expect.objectContaining({
            agentId: 'mem-fail',
            model: 'opus',
            status: 'failed',
            error: 'Connection timeout',
          }),
        }),
      );
    });

    it('should inject relevant memories into agent prompts via buildPrompt', async () => {
      const pastMemories: MemoryEntry[] = [
        {
          id: 'mem-1',
          timestamp: Date.now(),
          content: 'Agent prev-1 completed: Summarized quarterly report',
          metadata: { agentId: 'prev-1', status: 'completed' },
        },
        {
          id: 'mem-2',
          timestamp: Date.now(),
          content: 'Agent prev-2 completed: Extracted key metrics from data',
          metadata: { agentId: 'prev-2', status: 'completed' },
        },
      ];

      const mockMemory = createMockMemory({
        search: vi.fn(async () => pastMemories),
      });

      const provider = createMockProvider('Done');
      const runtime = new AgentRuntime({
        store, provider, memory: mockMemory,
        onLog: (_id, msg) => logs.push(msg),
      });

      const agent = runtime.create({
        id: 'prompt-mem-agent', prompt: 'Summarize quarterly data',
        model: 'opus',
      });

      await runtime.run(agent);

      // Verify search was called with the agent's prompt
      const searchMock = mockMemory.search as ReturnType<typeof vi.fn>;
      expect(searchMock).toHaveBeenCalledWith('episodic', 'Summarize quarterly data', 3);

      // Verify the prompt sent to provider includes memory content
      const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executeCall.prompt).toContain('Relevant past agent executions');
      expect(executeCall.prompt).toContain('Summarized quarterly report');
      expect(executeCall.prompt).toContain('Extracted key metrics from data');
    });

    it('should not inject memory section when search returns empty results', async () => {
      const mockMemory = createMockMemory({
        search: vi.fn(async () => []),
      });

      const provider = createMockProvider('Done');
      const runtime = new AgentRuntime({
        store, provider, memory: mockMemory,
        onLog: (_id, msg) => logs.push(msg),
      });

      const agent = runtime.create({
        id: 'no-mem-agent', prompt: 'Unrelated new task',
        model: 'opus',
      });

      await runtime.run(agent);

      const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executeCall.prompt).not.toContain('Relevant past agent executions');
    });

    it('should handle memory search failures as non-fatal', async () => {
      const mockMemory = createMockMemory({
        search: vi.fn(async () => { throw new Error('Memory storage corrupted'); }),
      });

      const provider = createMockProvider('Still works');
      const runtime = new AgentRuntime({
        store, provider, memory: mockMemory,
        onLog: (_id, msg) => logs.push(msg),
      });

      const agent = runtime.create({
        id: 'search-fail-agent', prompt: 'Do work despite memory failure',
        model: 'opus',
      });

      const result = await runtime.run(agent);

      // Agent should still complete successfully
      expect(agent.status).toBe('completed');
      expect(result.result).toBe('Still works');

      // Memory search was attempted
      expect(mockMemory.search).toHaveBeenCalled();

      // Prompt should not contain memory section (search failed gracefully)
      const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executeCall.prompt).not.toContain('Relevant past agent executions');
    });

    it('should handle memory append failures as non-fatal on success', async () => {
      const mockMemory = createMockMemory({
        append: vi.fn(async () => { throw new Error('Disk full'); }),
      });

      const provider = createMockProvider('Task done');
      const runtime = new AgentRuntime({
        store, provider, memory: mockMemory,
        onLog: (_id, msg) => logs.push(msg),
      });

      const agent = runtime.create({
        id: 'append-fail-agent', prompt: 'Do work',
        model: 'opus',
      });

      const result = await runtime.run(agent);

      // Agent should still complete successfully even though memory logging failed
      expect(agent.status).toBe('completed');
      expect(result.result).toBe('Task done');

      // Warning should be logged
      expect(logs.some(l => l.includes('Warning: Failed to log to episodic memory'))).toBe(true);
      expect(logs.some(l => l.includes('Disk full'))).toBe(true);
    });

    it('should handle memory append failures as non-fatal on failure', async () => {
      const mockMemory = createMockMemory({
        append: vi.fn(async () => { throw new Error('Memory unavailable'); }),
      });

      const errorProvider: LLMProvider = {
        execute: vi.fn(async () => { throw new Error('Provider crashed'); }),
      };

      const runtime = new AgentRuntime({
        store, provider: errorProvider, memory: mockMemory,
        onLog: (_id, msg) => logs.push(msg),
      });

      const agent = runtime.create({
        id: 'double-fail-agent', prompt: 'Doomed task',
        model: 'opus',
      });

      const result = await runtime.run(agent);

      // Agent should be marked as failed (from provider error, not memory error)
      expect(agent.status).toBe('failed');
      expect((result.result as Record<string, unknown>).error).toBe('Provider crashed');

      // Memory append failure warning should also be logged
      expect(logs.some(l => l.includes('Warning: Failed to log to episodic memory'))).toBe(true);
      expect(logs.some(l => l.includes('Memory unavailable'))).toBe(true);
    });

    it('should run normally without memory manager', async () => {
      const provider = createMockProvider('No memory needed');

      const runtime = new AgentRuntime({
        store, provider,
        onLog: (_id, msg) => logs.push(msg),
      });

      const agent = runtime.create({
        id: 'no-mem', prompt: 'Simple task',
        model: 'opus',
      });

      const result = await runtime.run(agent);

      expect(agent.status).toBe('completed');
      expect(result.result).toBe('No memory needed');
      expect(result.iterations).toBe(1);

      // Prompt should not contain any memory sections
      const executeCall = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executeCall.prompt).not.toContain('Relevant past agent executions');
    });

    it('should truncate long results when recording to episodic memory', async () => {
      const mockMemory = createMockMemory();
      const longResult = 'A'.repeat(1000);
      const provider = createMockProvider(longResult);

      const runtime = new AgentRuntime({
        store, provider, memory: mockMemory,
        onLog: (_id, msg) => logs.push(msg),
      });

      const agent = runtime.create({
        id: 'long-result', prompt: 'Generate long output',
        model: 'opus',
      });

      await runtime.run(agent);

      const appendMock = mockMemory.append as ReturnType<typeof vi.fn>;
      const appendCall = appendMock.mock.calls.find(
        (call: [MemoryType, MemoryEntry]) => call[1].metadata?.status === 'completed'
      );
      expect(appendCall).toBeDefined();
      // Content is sliced to 500 chars (plus the prefix text)
      expect(appendCall![1].content.length).toBeLessThanOrEqual(
        'Agent long-result completed: '.length + 500
      );
    });

    it('should include costUsd in episodic memory metadata on completion', async () => {
      const mockMemory = createMockMemory();
      const provider: LLMProvider = {
        execute: vi.fn(async () => ({
          result: 'Expensive result',
          costUsd: 0.15,
        } as ExecutionResult)),
      };

      const runtime = new AgentRuntime({
        store, provider, memory: mockMemory,
        onLog: (_id, msg) => logs.push(msg),
      });

      const agent = runtime.create({
        id: 'cost-agent', prompt: 'Costly task',
        model: 'opus',
      });

      await runtime.run(agent);

      const appendMock = mockMemory.append as ReturnType<typeof vi.fn>;
      expect(appendMock).toHaveBeenCalledWith(
        'episodic',
        expect.objectContaining({
          metadata: expect.objectContaining({
            costUsd: 0.15,
          }),
        }),
      );
    });
  });
});
