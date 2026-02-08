import { spawn } from 'node:child_process';
import type { LLMProvider, ExecutionResult, TokenUsage } from './types.js';

export interface ClaudeCodeProviderOptions {
  binary?: string;
  model?: string;
  maxBudgetUsd?: number;
  timeout?: number;
  permissionMode?: string;
  /** @internal For testing only -- override the child process spawn */
  spawnFn?: typeof import('node:child_process').spawn;
}

export interface ClaudeCodeMetadata {
  costUsd?: number;
  sessionId?: string;
  numTurns?: number;
  durationMs?: number;
}

export class ClaudeCodeProvider implements LLMProvider {
  private binary: string;
  private defaultModel: string;
  private maxBudgetUsd?: number;
  private timeout: number;
  private permissionMode: string;
  private spawnFn: typeof import('node:child_process').spawn;

  /** Metadata from the last execute() call */
  public lastMetadata: ClaudeCodeMetadata = {};

  constructor(opts: ClaudeCodeProviderOptions = {}) {
    this.binary = opts.binary ?? 'claude';
    this.defaultModel = opts.model ?? 'opus';
    this.maxBudgetUsd = opts.maxBudgetUsd;
    this.timeout = opts.timeout ?? 300_000; // 5 minutes
    this.permissionMode = opts.permissionMode ?? 'acceptEdits';
    this.spawnFn = opts.spawnFn ?? spawn;
  }

  async execute(params: {
    prompt: string;
    model?: string;
    maxBudgetUsd?: number;
    permissionMode?: string;
  }): Promise<ExecutionResult> {
    const args = this.buildArgs(
      params.model ?? this.defaultModel,
      params.prompt,
      params.maxBudgetUsd ?? this.maxBudgetUsd,
      params.permissionMode ?? this.permissionMode,
    );
    return this.execClaude(args);
  }

  private buildArgs(
    model: string,
    prompt: string,
    maxBudgetUsd?: number,
    permissionMode?: string,
  ): string[] {
    const args: string[] = [
      '-p', prompt,
      '--output-format', 'json',
      '--model', model,
      '--permission-mode', permissionMode ?? this.permissionMode,
      '--no-session-persistence',
    ];

    if (maxBudgetUsd !== undefined) {
      args.push('--max-budget-usd', String(maxBudgetUsd));
    }

    return args;
  }

  private execClaude(args: string[]): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const proc = this.spawnFn(this.binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        // Give it a moment to die gracefully, then force
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
        }, 3000);
      }, this.timeout);

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);

        if (killed) {
          reject(new Error(`Claude Code process timed out after ${this.timeout}ms`));
          return;
        }

        if (code !== 0) {
          reject(new Error(`Claude Code exited with code ${code}: ${stderr || stdout}`));
          return;
        }

        try {
          const parsed = JSON.parse(stdout);
          const response = this.parseResponse(parsed);
          resolve(response);
        } catch (err) {
          reject(new Error(`Failed to parse Claude Code output: ${(err as Error).message}\nOutput: ${stdout.slice(0, 500)}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn Claude Code: ${err.message}`));
      });

      // Close stdin immediately since we pass prompt via -p
      proc.stdin.end();
    });
  }

  private parseResponse(parsed: Record<string, unknown>): ExecutionResult {
    // Store metadata for the caller
    this.lastMetadata = {
      costUsd: parsed.total_cost_usd as number | undefined,
      sessionId: parsed.session_id as string | undefined,
      numTurns: parsed.num_turns as number | undefined,
      durationMs: parsed.duration_ms as number | undefined,
    };

    // Parse token usage from Claude CLI output
    let tokenUsage: TokenUsage | undefined;

    // Try modelUsage first (per-model breakdown, more reliable)
    const modelUsage = parsed.modelUsage as Record<string, Record<string, number>> | undefined;
    if (modelUsage) {
      let inputTokens = 0;
      let outputTokens = 0;
      for (const modelData of Object.values(modelUsage)) {
        inputTokens += (modelData.inputTokens ?? 0)
          + (modelData.cacheReadInputTokens ?? 0)
          + (modelData.cacheCreationInputTokens ?? 0);
        outputTokens += (modelData.outputTokens ?? 0);
      }
      tokenUsage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    }

    // Fall back to top-level usage if modelUsage not present
    if (!tokenUsage) {
      const usage = parsed.usage as Record<string, number> | undefined;
      if (usage && (usage.input_tokens || usage.output_tokens)) {
        const inputTokens = (usage.input_tokens ?? 0)
          + (usage.cache_read_input_tokens ?? 0)
          + (usage.cache_creation_input_tokens ?? 0);
        const outputTokens = usage.output_tokens ?? 0;
        tokenUsage = {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        };
      }
    }

    const resultText = typeof parsed.result === 'string'
      ? parsed.result
      : JSON.stringify(parsed.result);

    return {
      result: resultText,
      costUsd: this.lastMetadata.costUsd,
      durationMs: this.lastMetadata.durationMs,
      sessionId: this.lastMetadata.sessionId,
      numTurns: this.lastMetadata.numTurns,
      tokenUsage,
    };
  }
}
