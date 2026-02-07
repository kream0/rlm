import { describe, it, expect, beforeEach } from 'vitest';
import { FunctionRegistry } from '../src/function-registry.js';
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
      registry.register({ name: 'fn1', description: 'One', parameters: {}, handler: async () => null });
      registry.register({ name: 'fn2', description: 'Two', parameters: {}, handler: async () => null });
      expect(registry.list().length).toBe(2);
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
});
