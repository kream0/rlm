import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRuntime } from '../src/agent-runtime.js';
import { ContextStore } from '../src/context-store.js';
import { FunctionRegistry } from '../src/function-registry.js';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';

const TEST_DIR = resolve('.rlm-test-data-runtime');

interface MockResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

function createMockClient(responses: MockResponse[]) {
  let callIndex = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        if (callIndex >= responses.length) {
          return {
            content: [{ type: 'text', text: 'Done' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }
        return responses[callIndex++];
      }),
    },
  } as unknown as Anthropic;
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
    const client = createMockClient([]);
    const runtime = new AgentRuntime({
      store, registry, anthropicClient: client,
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
    const client = createMockClient([{
      content: [{ type: 'text', text: 'Hello, task complete!' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    }]);

    const runtime = new AgentRuntime({
      store, registry, anthropicClient: client,
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

    const client = createMockClient([
      {
        content: [{ type: 'tool_use', id: 'call-1', name: 'greet', input: { name: 'World' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 30 },
      },
      {
        content: [{ type: 'text', text: 'Greeted successfully.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 80, output_tokens: 20 },
      },
    ]);

    const runtime = new AgentRuntime({
      store, registry, anthropicClient: client,
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
    const client = createMockClient([{
      content: [{ type: 'tool_use', id: 'call-1', name: 'return_result', input: { value: '{"answer": 42}' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 50, output_tokens: 30 },
    }]);

    const runtime = new AgentRuntime({
      store, registry, anthropicClient: client,
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
    const client = createMockClient([{
      content: [{ type: 'tool_use', id: 'call-1', name: 'final_answer', input: { result: 'The answer is 42' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 50, output_tokens: 30 },
    }]);

    const runtime = new AgentRuntime({
      store, registry, anthropicClient: client,
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
    const loopClient = {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: 'tool_use', id: `call-${Date.now()}`, name: 'store_list', input: {} }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        })),
      },
    } as unknown as Anthropic;

    registry.register({
      name: 'store_list', description: 'List', parameters: {},
      handler: async () => [], scope: 'core',
    });

    const runtime = new AgentRuntime({
      store, registry, anthropicClient: loopClient,
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

    const client = createMockClient([
      {
        content: [{ type: 'tool_use', id: 'call-1', name: 'failing_tool', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 30 },
      },
      {
        content: [{ type: 'text', text: 'Tool failed, wrapping up.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 80, output_tokens: 20 },
      },
    ]);

    const runtime = new AgentRuntime({
      store, registry, anthropicClient: client,
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
    const client = createMockClient([]);
    const runtime = new AgentRuntime({
      store, registry, anthropicClient: client,
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
    const client = createMockClient([]);
    const runtime = new AgentRuntime({
      store, registry, anthropicClient: client,
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

    const client = createMockClient([{
      content: [{ type: 'text', text: 'Done with context' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    }]);

    const runtime = new AgentRuntime({
      store, registry, anthropicClient: client,
      onLog: (_id, msg) => logs.push(msg),
    });

    const contextRef = store.ref('my-context');
    const agent = runtime.create({
      id: 'ctx-agent', prompt: 'Use the context',
      model: 'claude-sonnet-4-5-20250929', contextRef, functions: [],
    });

    await runtime.run(agent);
    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const firstMessage = createCall.messages[0];
    expect(firstMessage.content).toContain('my-context');
  });

  it('should handle LLM API errors', async () => {
    const errorClient = {
      messages: {
        create: vi.fn(async () => { throw new Error('API rate limit exceeded'); }),
      },
    } as unknown as Anthropic;

    const runtime = new AgentRuntime({
      store, registry, anthropicClient: errorClient,
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
    const client = createMockClient([{
      content: [{ type: 'text', text: 'Task result' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 20 },
    }]);

    const runtime = new AgentRuntime({
      store, registry, anthropicClient: client,
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
    const client = createMockClient([{
      content: [{ type: 'text', text: 'Still working on it...' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 20 },
    }]);

    const runtime = new AgentRuntime({
      store, registry, anthropicClient: client,
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
