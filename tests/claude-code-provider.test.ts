import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeCodeProvider } from '../src/claude-code-provider.js';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// Mock child_process.spawn
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
const mockSpawn = vi.mocked(spawn);

function createMockProcess(
  stdout: string,
  stderr: string,
  exitCode: number,
  delay = 0,
): ChildProcess {
  const proc = new EventEmitter() as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: () => void };
    kill: (signal?: string) => boolean;
  };

  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end: vi.fn() };
  proc.kill = vi.fn(() => true);

  setTimeout(() => {
    if (stdout) {
      proc.stdout.emit('data', Buffer.from(stdout));
    }
    if (stderr) {
      proc.stderr.emit('data', Buffer.from(stderr));
    }
    setTimeout(() => {
      proc.emit('close', exitCode);
    }, delay);
  }, 10);

  return proc as ChildProcess;
}

describe('ClaudeCodeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should use default options', () => {
      const provider = new ClaudeCodeProvider();
      expect(provider).toBeDefined();
    });

    it('should accept custom options', () => {
      const provider = new ClaudeCodeProvider({
        binary: '/usr/local/bin/claude',
        model: 'opus',
        maxBudgetUsd: 1.0,
        timeout: 60000,
        permissionMode: 'plan',
      });
      expect(provider).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should parse successful JSON output', async () => {
      const output = JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Analysis complete: found 3 items',
        session_id: 'sess-123',
        total_cost_usd: 0.05,
        num_turns: 2,
        duration_ms: 1500,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
      });

      mockSpawn.mockReturnValueOnce(createMockProcess(output, '', 0));

      const provider = new ClaudeCodeProvider({ model: 'sonnet' });
      const response = await provider.execute({
        prompt: 'Analyze this data',
      });

      expect(response.result).toBe('Analysis complete: found 3 items');
      expect(response.costUsd).toBe(0.05);
      expect(response.sessionId).toBe('sess-123');
      expect(response.numTurns).toBe(2);
      expect(response.durationMs).toBe(1500);

      // Check metadata
      expect(provider.lastMetadata.costUsd).toBe(0.05);
      expect(provider.lastMetadata.sessionId).toBe('sess-123');
      expect(provider.lastMetadata.numTurns).toBe(2);
      expect(provider.lastMetadata.durationMs).toBe(1500);
    });

    it('should pass correct CLI arguments', async () => {
      const output = JSON.stringify({
        type: 'result',
        result: 'ok',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      mockSpawn.mockReturnValueOnce(createMockProcess(output, '', 0));

      const provider = new ClaudeCodeProvider({
        model: 'opus',
        maxBudgetUsd: 2.5,
        permissionMode: 'plan',
      });

      await provider.execute({
        prompt: 'Hello',
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([
          '-p',
          '--output-format', 'json',
          '--model', 'opus',
          '--permission-mode', 'plan',
          '--no-session-persistence',
          '--max-budget-usd', '2.5',
        ]),
        expect.any(Object),
      );
    });

    it('should pass prompt string directly', async () => {
      const output = JSON.stringify({
        type: 'result',
        result: 'ok',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      mockSpawn.mockReturnValueOnce(createMockProcess(output, '', 0));

      const provider = new ClaudeCodeProvider();
      await provider.execute({
        prompt: 'Analyze the code and report findings',
      });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const promptIndex = args.indexOf('-p');
      const prompt = args[promptIndex + 1];

      expect(prompt).toBe('Analyze the code and report findings');
    });

    it('should allow per-call model override', async () => {
      const output = JSON.stringify({
        type: 'result',
        result: 'ok',
      });

      mockSpawn.mockReturnValueOnce(createMockProcess(output, '', 0));

      const provider = new ClaudeCodeProvider({ model: 'sonnet' });
      await provider.execute({
        prompt: 'test',
        model: 'opus',
      });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const modelIndex = args.indexOf('--model');
      expect(args[modelIndex + 1]).toBe('opus');
    });

    it('should handle non-zero exit code', async () => {
      mockSpawn.mockReturnValueOnce(createMockProcess('', 'Error: auth failed', 1));

      const provider = new ClaudeCodeProvider();

      await expect(provider.execute({
        prompt: 'test',
      })).rejects.toThrow('Claude Code exited with code 1');
    });

    it('should handle invalid JSON output', async () => {
      mockSpawn.mockReturnValueOnce(createMockProcess('not valid json', '', 0));

      const provider = new ClaudeCodeProvider();

      await expect(provider.execute({
        prompt: 'test',
      })).rejects.toThrow('Failed to parse Claude Code output');
    });

    it('should handle spawn error', async () => {
      const proc = new EventEmitter() as ChildProcess & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { end: () => void };
        kill: (signal?: string) => boolean;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { end: vi.fn() };
      proc.kill = vi.fn(() => true);

      setTimeout(() => {
        proc.emit('error', new Error('ENOENT: claude not found'));
      }, 10);

      mockSpawn.mockReturnValueOnce(proc as ChildProcess);

      const provider = new ClaudeCodeProvider();

      await expect(provider.execute({
        prompt: 'test',
      })).rejects.toThrow('Failed to spawn Claude Code');
    });

    it('should handle timeout', async () => {
      const proc = new EventEmitter() as ChildProcess & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { end: () => void };
        kill: (signal?: string) => boolean;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { end: vi.fn() };
      proc.kill = vi.fn((signal?: string) => {
        // When killed, emit close
        setTimeout(() => proc.emit('close', null), 5);
        return true;
      });

      mockSpawn.mockReturnValueOnce(proc as ChildProcess);

      const provider = new ClaudeCodeProvider({ timeout: 50 });

      await expect(provider.execute({
        prompt: 'test',
      })).rejects.toThrow('timed out');
    }, 10000);

    it('should handle missing fields in output', async () => {
      const output = JSON.stringify({
        type: 'result',
        result: 'answer',
      });

      mockSpawn.mockReturnValueOnce(createMockProcess(output, '', 0));

      const provider = new ClaudeCodeProvider();
      const response = await provider.execute({
        prompt: 'test',
      });

      expect(response.result).toBe('answer');
      expect(response.costUsd).toBeUndefined();
      expect(response.durationMs).toBeUndefined();
      expect(response.sessionId).toBeUndefined();
      expect(response.numTurns).toBeUndefined();
    });

    it('should handle object result', async () => {
      const output = JSON.stringify({
        type: 'result',
        result: { key: 'value', nested: [1, 2, 3] },
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      mockSpawn.mockReturnValueOnce(createMockProcess(output, '', 0));

      const provider = new ClaudeCodeProvider();
      const response = await provider.execute({
        prompt: 'test',
      });

      expect(JSON.parse(response.result)).toEqual({ key: 'value', nested: [1, 2, 3] });
    });
  });
});
