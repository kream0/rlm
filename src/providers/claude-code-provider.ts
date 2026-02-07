import { spawn } from 'node:child_process';
import type {
  LLMProvider,
  LLMMessage,
  LLMResponse,
  LLMContentBlock,
  ToolDefinition,
} from '../types.js';

export interface ClaudeCodeProviderOptions {
  binary?: string;
  model?: string;
  maxBudgetUsd?: number;
  timeout?: number;
  permissionMode?: string;
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

  /** Metadata from the last chat() call */
  public lastMetadata: ClaudeCodeMetadata = {};

  constructor(opts: ClaudeCodeProviderOptions = {}) {
    this.binary = opts.binary ?? 'claude';
    this.defaultModel = opts.model ?? 'sonnet';
    this.maxBudgetUsd = opts.maxBudgetUsd;
    this.timeout = opts.timeout ?? 300_000; // 5 minutes
    this.permissionMode = opts.permissionMode ?? 'acceptEdits';
  }

  async chat(params: {
    model: string;
    system: string;
    messages: LLMMessage[];
    tools?: ToolDefinition[];
    maxTokens?: number;
  }): Promise<LLMResponse> {
    const prompt = this.flattenToPrompt(params.system, params.messages);
    const args = this.buildArgs(params.model, prompt);
    const result = await this.execClaude(args);

    return result;
  }

  private flattenToPrompt(system: string, messages: LLMMessage[]): string {
    const parts: string[] = [];

    if (system) {
      parts.push(`[System Instructions]\n${system}`);
    }

    for (const msg of messages) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      if (typeof msg.content === 'string') {
        parts.push(`[${role}]\n${msg.content}`);
      } else {
        // Flatten content blocks to text
        const textParts = (msg.content as LLMContentBlock[])
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text);
        if (textParts.length > 0) {
          parts.push(`[${role}]\n${textParts.join('\n')}`);
        }
      }
    }

    return parts.join('\n\n');
  }

  private buildArgs(model: string, prompt: string): string[] {
    const args: string[] = [
      '-p', prompt,
      '--output-format', 'json',
      '--model', model || this.defaultModel,
      '--permission-mode', this.permissionMode,
      '--no-session-persistence',
    ];

    if (this.maxBudgetUsd !== undefined) {
      args.push('--max-budget-usd', String(this.maxBudgetUsd));
    }

    return args;
  }

  private execClaude(args: string[]): Promise<LLMResponse> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const proc = spawn(this.binary, args, {
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

  private parseResponse(parsed: Record<string, unknown>): LLMResponse {
    // Store metadata for the caller
    this.lastMetadata = {
      costUsd: parsed.total_cost_usd as number | undefined,
      sessionId: parsed.session_id as string | undefined,
      numTurns: parsed.num_turns as number | undefined,
      durationMs: parsed.duration_ms as number | undefined,
    };

    const resultText = typeof parsed.result === 'string'
      ? parsed.result
      : JSON.stringify(parsed.result);

    const content: LLMContentBlock[] = [
      { type: 'text', text: resultText },
    ];

    // Extract usage if available
    const usage = parsed.usage as Record<string, number> | undefined;
    const inputTokens = usage?.input_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;

    return {
      content,
      stopReason: 'end_turn',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }
}
