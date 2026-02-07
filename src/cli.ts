#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ContextStore } from './context-store.js';
import { MemoryManager } from './memory-manager.js';
import { AgentRuntime } from './agent-runtime.js';
import { RecursiveSpawner } from './recursive-spawner.js';
import { ClaudeCodeProvider } from './claude-code-provider.js';
import type { RLMConfig, AgentResult, RunOptions } from './types.js';

const VERSION = '1.0.0';

function getDefaultConfig(): RLMConfig {
  return {
    model: 'claude-sonnet-4-5-20250929',
    maxDepth: 5,
    maxConcurrent: 3,
    tokenBudget: 1_000_000,
    storageDir: resolve('.rlm-data'),
    verbose: false,
  };
}

function log(message: string, verbose = false): void {
  if (verbose) {
    process.stderr.write(`[RLM] ${message}\n`);
  }
}

async function createSystem(config: RLMConfig) {
  const provider = new ClaudeCodeProvider({
    binary: config.claudeBinary,
    model: config.claudeModel,
    maxBudgetUsd: config.claudeMaxBudgetUsd,
    permissionMode: config.claudePermissionMode,
  });

  const store = new ContextStore(resolve(config.storageDir, 'variables'));
  await store.init();

  const memory = new MemoryManager(resolve(config.storageDir, 'memory'));
  await memory.init();

  const runtime = new AgentRuntime({
    provider,
    store,
    onLog: (agentId, msg) => log(`[${agentId.slice(0, 8)}] ${msg}`, config.verbose),
  });

  const spawner = new RecursiveSpawner({
    runtime,
    store,
    defaultModel: config.model,
    maxDepth: config.maxDepth,
    maxConcurrent: config.maxConcurrent,
    onLog: (msg) => log(msg, config.verbose),
  });

  return { store, memory, runtime, spawner, provider };
}

export async function run(task: string, options?: RunOptions): Promise<AgentResult> {
  const config = getDefaultConfig();
  if (options?.model) config.model = options.model;
  if (options?.maxDepth) config.maxDepth = options.maxDepth;
  if (options?.verbose !== undefined) config.verbose = options.verbose;

  const { store, runtime } = await createSystem(config);

  let contextContent = '';
  if (options?.contextFiles) {
    for (const file of options.contextFiles) {
      const content = await readFile(resolve(file), 'utf-8');
      const key = `context-file-${file.replace(/[^a-zA-Z0-9]/g, '-')}`;
      await store.set(key, content, { type: 'text', persist: false });
      contextContent += `\n\nLoaded file "${file}" into variable "${key}" (${content.length} bytes)`;
    }
  }

  const fullPrompt = task + contextContent;
  const agent = runtime.create({
    id: `main-${Date.now()}`,
    prompt: fullPrompt,
    model: config.model,
  });

  console.log(`[Agent spawned: ${agent.id}]`);
  const result = await runtime.run(agent);
  console.log(`[Agent completed: ${result.agentId} | iterations: ${result.iterations}]`);

  return result;
}

async function main(args: string[]): Promise<number> {
  const config = getDefaultConfig();
  const command = args[0];

  if (command === '--help' || command === '-h') {
    console.log(`
RLM v${VERSION} - Recursive Language Model (Claude Code Only)

Usage:
  rlm run "<task>"                   Run a task directly
  rlm run "<task>" --context <file>  Run with context file(s)

Options:
  --model <model>          LLM model (default: ${config.model})
  --max-depth <n>          Max recursion depth (default: ${config.maxDepth})
  --max-concurrent <n>     Max concurrent agents (default: ${config.maxConcurrent})
  --verbose                Enable verbose logging
  --context <file>         Load a context file (can be repeated)
  --claude-binary <path>   Path to claude binary (default: 'claude')
  --claude-budget <usd>    Max budget per claude-code invocation
  --claude-model <model>   Model for claude-code provider (default: 'sonnet')
  --claude-permission-mode Permission mode (default: 'acceptEdits')
`);
    return 0;
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--model':
        config.model = args[++i];
        break;
      case '--max-depth':
        config.maxDepth = parseInt(args[++i], 10);
        break;
      case '--max-concurrent':
        config.maxConcurrent = parseInt(args[++i], 10);
        break;
      case '--verbose':
      case '-v':
        config.verbose = true;
        break;
      case '--claude-binary':
        config.claudeBinary = args[++i];
        break;
      case '--claude-budget':
        config.claudeMaxBudgetUsd = parseFloat(args[++i]);
        break;
      case '--claude-model':
        config.claudeModel = args[++i];
        break;
      case '--claude-permission-mode':
        config.claudePermissionMode = args[++i];
        break;
    }
  }

  if (command === 'run') {
    const task = args[1];
    if (!task) {
      console.error('Error: Task description required. Usage: rlm run "your task"');
      return 1;
    }

    const contextFiles: string[] = [];
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--context' && args[i + 1]) {
        contextFiles.push(args[++i]);
      }
    }

    try {
      const result = await run(task, {
        contextFiles,
        model: config.model,
        maxDepth: config.maxDepth,
        verbose: config.verbose,
      });

      return result.result && !(result.result as Record<string, unknown>).error ? 0 : 1;
    } catch (err: unknown) {
      const error = err as Error;
      console.error(`Error: ${error.message}`);
      return 1;
    }
  }

  // No REPL mode — primary usage is as library import or `rlm run`
  console.log(`RLM v${VERSION} - Recursive Language Model (Claude Code Only)`);
  console.log('Usage: rlm run "<task>" [options]');
  console.log('Run rlm --help for full options.');
  return 0;
}

const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('/cli.ts') ||
  process.argv[1].endsWith('/cli.js')
);

if (isMainModule) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { main, getDefaultConfig, createSystem };
