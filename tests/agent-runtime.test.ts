import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRuntime } from '../src/agent-runtime.js';
import { ContextStore } from '../src/context-store.js';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import type { LLMProvider, ExecutionResult } from '../src/types.js';

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

  it('should store result in context store', async () => {
    const provider = createMockProvider('Task result');

    const runtime = new AgentRuntime({
      store, provider,
    });

    const agent = runtime.create({
      id: 'store-result', prompt: 'Do work',
      model: 'claude-sonnet-4-5-20250929',
    });

    await runtime.run(agent);
    const stored = await store.get('agent-result-store-result');
    expect(stored).toBe('Task result');
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
});
