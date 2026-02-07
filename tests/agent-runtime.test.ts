import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRuntime } from '../src/agent-runtime.js';
import { ContextStore } from '../src/context-store.js';
import { FunctionRegistry } from '../src/function-registry.js';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import type { LLMProvider, LLMResponse } from '../src/types.js';

const TEST_DIR = resolve('.rlm-test-data-runtime');

interface MockResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

function createMockProvider(responses: MockResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    chat: vi.fn(async () => {
      if (callIndex >= responses.length) {
        return {
          content: [{ type: 'text' as const, text: 'Done' }],
          stopReason: 'end_turn' as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      }
      return responses[callIndex++] as LLMResponse;
    }),
  };
}

describe('AgentRuntime', () => {
  let store: ContextStore;
  let registry: FunctionRegistry;
  let logs: string[];

  beforeEach(async () => {
    store = new ContextStore(TEST_DIR);
    await store.init();
    registry = new FunctionRegistry();
    logs = [];
  });

  afterEach(async () => {
    await store.clear();
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('should create an agent', () => {
    const provider = createMockProvider([]);
    const runtime = new AgentRuntime({
      store, registry, provider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'test-agent', prompt: 'Do something',
      model: 'claude-sonnet-4-5-20250929', functions: [],
    });

    expect(agent.id).toBe('test-agent');
    expect(agent.status).toBe('idle');
    expect(agent.iterations).toBe(0);
  });

  it('should run an agent that returns text', async () => {
    const provider = createMockProvider([{
      content: [{ type: 'text', text: 'Hello, task complete!' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }]);

    const runtime = new AgentRuntime({
      store, registry, provider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'text-agent', prompt: 'Say hello',
      model: 'claude-sonnet-4-5-20250929', functions: [],
    });

    const result = await runtime.run(agent);
    expect(result.agentId).toBe('text-agent');
    expect(result.result).toBe('Hello, task complete!');
    expect(result.iterations).toBe(1);
    expect(result.tokenUsage.totalTokens).toBe(150);
    expect(agent.status).toBe('completed');
  });

  it('should handle tool calls', async () => {
    registry.register({
      name: 'greet', description: 'Greet someone',
      parameters: { name: { type: 'string', description: 'Name', required: true } },
      handler: async (params) => `Hello, ${params.name}!`,
      scope: 'core',
    });

    const provider = createMockProvider([
      {
        content: [{ type: 'tool_use', id: 'call-1', name: 'greet', input: { name: 'World' } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
      },
      {
        content: [{ type: 'text', text: 'Greeted successfully.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      },
    ]);

    const runtime = new AgentRuntime({
      store, registry, provider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'tool-agent', prompt: 'Greet the world',
      model: 'claude-sonnet-4-5-20250929', functions: registry.list(),
    });

    const result = await runtime.run(agent);
    expect(result.iterations).toBe(2);
    expect(result.result).toBe('Greeted successfully.');
    expect(result.tokenUsage.totalTokens).toBe(180);
  });

  it('should terminate on return_result', async () => {
    const provider = createMockProvider([{
      content: [{ type: 'tool_use', id: 'call-1', name: 'return_result', input: { value: '{"answer": 42}' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
    }]);

    const runtime = new AgentRuntime({
      store, registry, provider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'return-agent', prompt: 'Calculate and return',
      model: 'claude-sonnet-4-5-20250929', parentId: 'parent-1', functions: [],
    });

    const result = await runtime.run(agent);
    expect(agent.status).toBe('completed');
    expect(result.result).toEqual({ answer: 42 });
  });

  it('should terminate on final_answer', async () => {
    const provider = createMockProvider([{
      content: [{ type: 'tool_use', id: 'call-1', name: 'final_answer', input: { result: 'The answer is 42' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
    }]);

    const runtime = new AgentRuntime({
      store, registry, provider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'final-agent', prompt: 'Give final answer',
      model: 'claude-sonnet-4-5-20250929', functions: [],
    });

    const result = await runtime.run(agent);
    expect(agent.status).toBe('completed');
    expect(result.result).toBe('The answer is 42');
  });

  it('should respect maxIterations', async () => {
    const loopProvider: LLMProvider = {
      chat: vi.fn(async () => ({
        content: [{ type: 'tool_use' as const, id: `call-${Date.now()}`, name: 'store_list', input: {} }],
        stopReason: 'tool_use' as const,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      })),
    };

    registry.register({
      name: 'store_list', description: 'List', parameters: {},
      handler: async () => [], scope: 'core',
    });

    const runtime = new AgentRuntime({
      store, registry, provider: loopProvider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'loop-agent', prompt: 'Keep going',
      model: 'claude-sonnet-4-5-20250929', maxIterations: 3, functions: registry.list(),
    });

    const result = await runtime.run(agent);
    expect(result.iterations).toBe(3);
    expect((result.result as Record<string, unknown>).maxIterationsReached).toBe(true);
  });

  it('should handle tool errors gracefully', async () => {
    registry.register({
      name: 'failing_tool', description: 'Fails', parameters: {},
      handler: async () => { throw new Error('Tool crashed'); }, scope: 'core',
    });

    const provider = createMockProvider([
      {
        content: [{ type: 'tool_use', id: 'call-1', name: 'failing_tool', input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
      },
      {
        content: [{ type: 'text', text: 'Tool failed, wrapping up.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      },
    ]);

    const runtime = new AgentRuntime({
      store, registry, provider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'error-agent', prompt: 'Use failing tool',
      model: 'claude-sonnet-4-5-20250929', functions: registry.list(),
    });

    const result = await runtime.run(agent);
    expect(agent.status).toBe('completed');
    expect(result.result).toContain('Tool failed');
  });

  it('should cancel an agent', async () => {
    const provider = createMockProvider([]);
    const runtime = new AgentRuntime({
      store, registry, provider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'cancel-agent', prompt: 'Take your time',
      model: 'claude-sonnet-4-5-20250929', maxIterations: 100, functions: [],
    });

    await runtime.cancel('cancel-agent');
    const result = await runtime.run(agent);
    expect(agent.status).toBe('cancelled');
  });

  it('should get agent status', () => {
    const provider = createMockProvider([]);
    const runtime = new AgentRuntime({
      store, registry, provider,
    });

    runtime.create({
      id: 'status-agent', prompt: 'Test',
      model: 'claude-sonnet-4-5-20250929', functions: [],
    });

    expect(runtime.getStatus('status-agent')).toBe('idle');
    expect(runtime.getStatus('nonexistent')).toBeUndefined();
  });

  it('should include context ref summary', async () => {
    await store.set('my-context', 'Important context data');

    const provider = createMockProvider([{
      content: [{ type: 'text', text: 'Done with context' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }]);

    const runtime = new AgentRuntime({
      store, registry, provider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const contextRef = store.ref('my-context');
    const agent = runtime.create({
      id: 'ctx-agent', prompt: 'Use the context',
      model: 'claude-sonnet-4-5-20250929', contextRef, functions: [],
    });

    await runtime.run(agent);
    const chatCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const firstMessage = chatCall.messages[0];
    expect(firstMessage.content).toContain('my-context');
  });

  it('should handle LLM API errors', async () => {
    const errorProvider: LLMProvider = {
      chat: vi.fn(async () => { throw new Error('API rate limit exceeded'); }),
    };

    const runtime = new AgentRuntime({
      store, registry, provider: errorProvider,
      onLog: (_id, msg) => logs.push(msg),
    });

    const agent = runtime.create({
      id: 'error-llm', prompt: 'This will fail',
      model: 'claude-sonnet-4-5-20250929', functions: [],
    });

    const result = await runtime.run(agent);
    expect(agent.status).toBe('failed');
    expect((result.result as Record<string, unknown>).error).toContain('rate limit');
  });

  it('should store result in context store', async () => {
    const provider = createMockProvider([{
      content: [{ type: 'text', text: 'Task result' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
    }]);

    const runtime = new AgentRuntime({
      store, registry, provider,
    });

    const agent = runtime.create({
      id: 'store-result', prompt: 'Do work',
      model: 'claude-sonnet-4-5-20250929', functions: [],
    });

    await runtime.run(agent);
    const stored = await store.get('agent-result-store-result');
    expect(stored).toBe('Task result');
  });

  it('should use custom termination fn', async () => {
    const provider = createMockProvider([{
      content: [{ type: 'text', text: 'Still working on it...' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
    }]);

    const runtime = new AgentRuntime({
      store, registry, provider,
    });

    const agent = runtime.create({
      id: 'term-agent', prompt: 'Work until done',
      model: 'claude-sonnet-4-5-20250929',
      terminationFn: (result: unknown) => typeof result === 'string' && result.includes('working'),
      functions: [],
    });

    const result = await runtime.run(agent);
    expect(agent.status).toBe('completed');
  });
});
