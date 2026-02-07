import { describe, it, expect, beforeEach } from 'vitest';
import { FunctionRegistry, createCoreFunctions, createUserFunctions, createAgentFunctions } from '../src/function-registry.js';
import type { FunctionSpec } from '../src/types.js';

describe('FunctionRegistry', () => {
  let registry: FunctionRegistry;

  beforeEach(() => {
    registry = new FunctionRegistry();
  });

  describe('register/get', () => {
    it('should register and retrieve', () => {
      const spec: FunctionSpec = {
        name: 'test_fn',
        description: 'A test',
        parameters: {
          input: { type: 'string', description: 'Test input', required: true },
        },
        handler: async (params) => params.input,
        scope: 'core',
      };

      registry.register(spec);
      const retrieved = registry.get('test_fn');
      expect(retrieved.name).toBe('test_fn');
    });

    it('should throw on duplicate', () => {
      const spec: FunctionSpec = {
        name: 'dup', description: 'Dup', parameters: {},
        handler: async () => null,
      };
      registry.register(spec);
      expect(() => registry.register(spec)).toThrow('already registered');
    });

    it('should throw on missing', () => {
      expect(() => registry.get('nonexistent')).toThrow('not found');
    });
  });

  describe('unregister', () => {
    it('should remove a registered item', () => {
      registry.register({
        name: 'removeme', description: 'X', parameters: {},
        handler: async () => null,
      });
      expect(registry.has('removeme')).toBe(true);
      registry.unregister('removeme');
      expect(registry.has('removeme')).toBe(false);
    });

    it('should throw on missing', () => {
      expect(() => registry.unregister('nonexistent')).toThrow('not found');
    });
  });

  describe('list', () => {
    it('should list all', () => {
      registry.register({ name: 'fn1', description: 'One', parameters: {}, handler: async () => null, scope: 'core' });
      registry.register({ name: 'fn2', description: 'Two', parameters: {}, handler: async () => null, scope: 'user' });
      expect(registry.list().length).toBe(2);
    });

    it('should filter by scope', () => {
      registry.register({ name: 'c1', description: 'C', parameters: {}, handler: async () => null, scope: 'core' });
      registry.register({ name: 'u1', description: 'U', parameters: {}, handler: async () => null, scope: 'user' });
      registry.register({ name: 'c2', description: 'C', parameters: {}, handler: async () => null, scope: 'core' });
      expect(registry.list('core').length).toBe(2);
      expect(registry.list('user').length).toBe(1);
    });
  });

  describe('toToolDefinitions', () => {
    it('should convert to LLM tool format', () => {
      registry.register({
        name: 'test_tool',
        description: 'A test tool',
        parameters: {
          query: { type: 'string', description: 'Search query', required: true },
          limit: { type: 'number', description: 'Max results', required: false, default: 10 },
        },
        handler: async () => null,
        scope: 'core',
      });

      const tools = registry.toToolDefinitions();
      expect(tools.length).toBe(1);
      const tool = tools[0];
      expect(tool.name).toBe('test_tool');
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.required).toContain('query');
      expect(tool.input_schema.required).not.toContain('limit');
    });

    it('should filter by scope', () => {
      registry.register({ name: 'c', description: 'C', parameters: {}, handler: async () => null, scope: 'core' });
      registry.register({ name: 'u', description: 'U', parameters: {}, handler: async () => null, scope: 'user' });
      expect(registry.toToolDefinitions('core').length).toBe(1);
    });
  });

  describe('execute', () => {
    it('should execute with params', async () => {
      registry.register({
        name: 'add',
        description: 'Add',
        parameters: {
          a: { type: 'number', description: 'First', required: true },
          b: { type: 'number', description: 'Second', required: true },
        },
        handler: async (params) => (params.a as number) + (params.b as number),
      });

      const result = await registry.execute('add', { a: 3, b: 7 });
      expect(result).toBe(10);
    });

    it('should apply defaults', async () => {
      registry.register({
        name: 'greet',
        description: 'Greet',
        parameters: {
          name: { type: 'string', description: 'Name', required: true },
          greeting: { type: 'string', description: 'Greeting', required: false, default: 'Hello' },
        },
        handler: async (params) => `${params.greeting} ${params.name}`,
      });

      const result = await registry.execute('greet', { name: 'World' });
      expect(result).toBe('Hello World');
    });

    it('should throw on missing required param', async () => {
      registry.register({
        name: 'strict',
        description: 'S',
        parameters: {
          required_param: { type: 'string', description: 'R', required: true },
        },
        handler: async () => null,
      });

      await expect(registry.execute('strict', {})).rejects.toThrow('Missing required parameter');
    });
  });

  describe('has/clear', () => {
    it('should check existence', () => {
      registry.register({ name: 'exists', description: 'X', parameters: {}, handler: async () => null });
      expect(registry.has('exists')).toBe(true);
      expect(registry.has('nope')).toBe(false);
    });

    it('should clear all', () => {
      registry.register({ name: 'fn1', description: 'X', parameters: {}, handler: async () => null });
      registry.register({ name: 'fn2', description: 'X', parameters: {}, handler: async () => null });
      registry.clear();
      expect(registry.list().length).toBe(0);
    });
  });

  describe('createCoreFunctions', () => {
    it('should create 5 store tools', () => {
      const mockStore = {
        set: async () => ({ id: '1', key: 'k', scope: 'global', type: 'text' as const, sizeBytes: 0, createdAt: 0 }),
        get: async () => 'value',
        ref: () => ({ id: '1', key: 'k', scope: 'global', type: 'text' as const, sizeBytes: 0, createdAt: 0 }),
        list: async () => [],
        summarize: async () => 'summary',
      };

      const fns = createCoreFunctions({ store: mockStore });
      expect(fns.length).toBe(5);
      const names = fns.map((f) => f.name);
      expect(names).toContain('store_set');
      expect(names).toContain('store_get');
      expect(names).toContain('store_ref');
      expect(names).toContain('store_list');
      expect(names).toContain('store_summarize');
    });

    it('should execute store_set correctly', async () => {
      let storedKey = '';
      const mockStore = {
        set: async (key: string) => { storedKey = key; return { id: '1', key, scope: 'global', type: 'text' as const, sizeBytes: 0, createdAt: 0 }; },
        get: async () => null,
        ref: () => ({ id: '1', key: 'k', scope: 'global', type: 'text' as const, sizeBytes: 0, createdAt: 0 }),
        list: async () => [],
        summarize: async () => 'summary',
      };

      const fns = createCoreFunctions({ store: mockStore });
      const setFn = fns.find((f) => f.name === 'store_set')!;
      await setFn.handler({ key: 'mykey', value: 'myvalue' });
      expect(storedKey).toBe('mykey');
    });
  });

  describe('createUserFunctions', () => {
    it('should create 3 user tools', () => {
      const fns = createUserFunctions({
        onAskUser: async () => 'answer',
        onNotifyUser: () => {},
        onFinalAnswer: () => {},
      });
      expect(fns.length).toBe(3);
      expect(fns.map((f) => f.name)).toContain('ask_user');
      expect(fns.map((f) => f.name)).toContain('notify_user');
      expect(fns.map((f) => f.name)).toContain('final_answer');
      expect(fns.every((f) => f.scope === 'user')).toBe(true);
    });

    it('should execute ask_user', async () => {
      let q = '';
      const fns = createUserFunctions({
        onAskUser: async (question) => { q = question; return 'yes'; },
        onNotifyUser: () => {},
        onFinalAnswer: () => {},
      });
      const askFn = fns.find((f) => f.name === 'ask_user')!;
      const result = await askFn.handler({ question: 'Continue?' });
      expect(q).toBe('Continue?');
      expect(result).toBe('yes');
    });
  });

  describe('createAgentFunctions', () => {
    it('should create 2 agent tools', () => {
      const fns = createAgentFunctions({
        onSpawn: async () => ({}),
        onReturnResult: () => {},
      });
      expect(fns.length).toBe(2);
      expect(fns.map((f) => f.name)).toContain('spawn_agent');
      expect(fns.map((f) => f.name)).toContain('return_result');
      expect(fns.every((f) => f.scope === 'agent')).toBe(true);
    });
  });
});
