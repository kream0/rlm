import { describe, it, expect, vi, afterEach } from 'vitest';
import { getDefaultConfig, createSystem, main } from '../src/cli.js';

describe('CLI', () => {
  describe('getDefaultConfig', () => {
    it('should return default configuration', () => {
      const config = getDefaultConfig();
      expect(config.model).toBe('claude-opus-4-6');
      expect(config.maxDepth).toBe(5);
      expect(config.maxConcurrent).toBe(3);
      expect(config.tokenBudget).toBe(1_000_000);
      expect(config.verbose).toBe(false);
    });

    it('should have a storageDir', () => {
      const config = getDefaultConfig();
      expect(config.storageDir).toBeDefined();
      expect(config.storageDir).toContain('.rlm-data');
    });
  });

  describe('main', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should show help with --help', async () => {
      const spy = vi.spyOn(console, 'log')
        .mockImplementation(() => {});
      const code = await main(['--help']);
      expect(code).toBe(0);
      expect(spy).toHaveBeenCalled();
      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('RLM');
      expect(output).toContain('run');
    });

    it('should show help with -h', async () => {
      const spy = vi.spyOn(console, 'log')
        .mockImplementation(() => {});
      const code = await main(['-h']);
      expect(code).toBe(0);
      expect(spy).toHaveBeenCalled();
      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('RLM');
    });

    it('should error on run without task', async () => {
      const spy = vi.spyOn(console, 'error')
        .mockImplementation(() => {});
      const code = await main(['run']);
      expect(code).toBe(1);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('Task description required')
      );
    });

    it('should show usage with no arguments', async () => {
      const spy = vi.spyOn(console, 'log')
        .mockImplementation(() => {});
      const code = await main([]);
      expect(code).toBe(0);
      expect(spy).toHaveBeenCalled();
      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('RLM');
      expect(output).toContain('Usage');
    });
  });

  describe('createSystem', () => {
    it('should create all system components', async () => {
      const config = getDefaultConfig();
      config.storageDir = '/tmp/.rlm-test-cli-' + Date.now();
      const system = await createSystem(config);

      expect(system.store).toBeDefined();
      expect(system.memory).toBeDefined();
      expect(system.runtime).toBeDefined();
      expect(system.spawner).toBeDefined();
      expect(system.provider).toBeDefined();
      expect(system.registry).toBeDefined();

      // Cleanup
      await system.store.clear();
    });
  });
});
