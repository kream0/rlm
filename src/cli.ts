#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ContextStore } from './context-store.js';
import { FunctionRegistry, createCoreFunctions, createExecutionFunctions, createUserFunctions, createAgentFunctions } from './function-registry.js';
import { MemoryManager } from './memory-manager.js';
import { AgentRuntime } from './agent-runtime.js';
import { RecursiveSpawner } from './recursive-spawner.js';
import type { RLMConfig, AgentResult, RunOptions, AgentTree } from './types.js';

const VERSION = '1.0.0';

function getDefaultConfig(): RLMConfig {
  return {
    model: 'claude-sonnet-4-5-20250929',
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    maxDepth: 5,
    maxConcurrent: 3,
    maxIterations: 50,
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
  const store = new ContextStore(resolve(config.storageDir, 'variables'));
  await store.init();

  const memory = new MemoryManager(resolve(config.storageDir, 'memory'));
  await memory.init();

  const registry = new FunctionRegistry();

  const coreFns = createCoreFunctions({ store });
  for (const fn of coreFns) {
    registry.register(fn);
  }

  const execFns = createExecutionFunctions();
  for (const fn of execFns) {
    registry.register(fn);
  }

  const runtime = new AgentRuntime({
    apiKey: config.apiKey,
    store,
    registry,
    onLog: (agentId, msg) => log(`[${agentId.slice(0, 8)}] ${msg}`, config.verbose),
  });

  const spawner = new RecursiveSpawner({
    runtime,
    store,
    registry,
    defaultModel: config.model,
    maxDepth: config.maxDepth,
    maxConcurrent: config.maxConcurrent,
    onLog: (msg) => log(msg, config.verbose),
  });

  return { store, memory, registry, runtime, spawner };
}

export async function run(task: string, options?: RunOptions): Promise<AgentResult> {
  const config = getDefaultConfig();
  if (options?.model) config.model = options.model;
  if (options?.maxIterations) config.maxIterations = options.maxIterations;
  if (options?.maxDepth) config.maxDepth = options.maxDepth;
  if (options?.verbose !== undefined) config.verbose = options.verbose;

  const { store, registry, runtime } = await createSystem(config);

  let contextContent = '';
  if (options?.contextFiles) {
    for (const file of options.contextFiles) {
      const content = await readFile(resolve(file), 'utf-8');
      const key = `context-file-${file.replace(/[^a-zA-Z0-9]/g, '-')}`;
      await store.set(key, content, { type: 'text', persist: false });
      contextContent += `\n\nLoaded file "${file}" into variable "${key}" (${content.length} bytes)`;
    }
  }

  const userFns = createUserFunctions({
    onAskUser: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return new Promise<string>((res) => {
        rl.question(`\n[Agent asks]: ${question}\n> `, (answer) => {
          rl.close();
          res(answer);
        });
      });
    },
    onNotifyUser: (message) => {
      console.log(`\n[Agent]: ${message}`);
    },
    onFinalAnswer: (result) => {
      console.log(`\n${'='.repeat(60)}`);
      console.log('Final Result:');
      console.log('='.repeat(60));
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      console.log('='.repeat(60));
    },
  });
  for (const fn of userFns) {
    registry.register(fn);
  }

  const agentFns = createAgentFunctions({
    onSpawn: async () => {
      console.log(`[Spawning sub-agent...]`);
      return { spawned: true };
    },
    onReturnResult: () => {},
  });
  for (const fn of agentFns) {
    if (!registry.has(fn.name)) {
      registry.register(fn);
    }
  }

  const fullPrompt = task + contextContent;
  const agent = runtime.create({
    id: `main-${Date.now()}`,
    prompt: fullPrompt,
    model: config.model,
    maxIterations: config.maxIterations,
    functions: registry.list(),
  });

  console.log(`[Agent spawned: ${agent.id}]`);
  const result = await runtime.run(agent);
  console.log(`[Agent completed: ${result.agentId} | iterations: ${result.iterations} | tokens: ${result.tokenUsage.totalTokens}]`);

  return result;
}

async function startREPL(config: RLMConfig): Promise<void> {
  console.log(`RLM v${VERSION} - Recursive Language Model`);
  console.log('Type a task or command. You are a part of this system.');
  console.log('Commands: .status, .vars, .clear, .quit\n');

  const { store, memory, registry, runtime, spawner } = await createSystem(config);

  const userFns = createUserFunctions({
    onAskUser: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return new Promise<string>((res) => {
        rl.question(`\n[Agent asks]: ${question}\n> `, (answer) => {
          rl.close();
          res(answer);
        });
      });
    },
    onNotifyUser: (message) => {
      console.log(`[Agent]: ${message}`);
    },
    onFinalAnswer: (result) => {
      console.log(`\nResult: ${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}`);
    },
  });
  for (const fn of userFns) {
    registry.register(fn);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'rlm> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === '.quit' || input === '.exit') {
      console.log('Goodbye.');
      rl.close();
      process.exit(0);
    }

    if (input === '.status') {
      const tree = spawner.getTree();
      console.log('\nAgent Tree:');
      printTree(tree, '  ');
      const vars = await store.list();
      console.log(`\nVariables: ${vars.length}`);
      for (const v of vars) {
        console.log(`  ${v.key.padEnd(30)} ${v.type.padEnd(8)} ${formatBytes(v.sizeBytes).padEnd(10)} ${v.scope}`);
      }
      const memStats = memory.getStats();
      console.log(`\nMemory: ${memStats.episodicEntryCount} episodic, ${memStats.semanticEntryCount} semantic, ${memStats.proceduralRuleCount} procedural`);
      console.log(`Token budget: ${spawner.getTotalTokenUsage().totalTokens} / ${config.tokenBudget}`);
      rl.prompt();
      return;
    }

    if (input === '.vars') {
      const vars = await store.list();
      if (vars.length === 0) {
        console.log('No variables stored.');
      } else {
        for (const v of vars) {
          console.log(`  ${v.key.padEnd(30)} ${v.type.padEnd(8)} ${formatBytes(v.sizeBytes).padEnd(10)} ${v.scope}`);
        }
      }
      rl.prompt();
      return;
    }

    if (input === '.clear') {
      await store.clear();
      await memory.clear();
      spawner.reset();
      console.log('Cleared all variables and memory.');
      rl.prompt();
      return;
    }

    if (input.startsWith('.store ')) {
      const parts = input.slice(7).split(' ');
      const key = parts[0];
      const value = parts.slice(1).join(' ');
      if (key && value) {
        const ref = await store.set(key, value);
        console.log(`[Stored: ${key} (${formatBytes(ref.sizeBytes)})]`);
      }
      rl.prompt();
      return;
    }

    try {
      const agent = runtime.create({
        id: `repl-${Date.now()}`,
        prompt: input,
        model: config.model,
        maxIterations: config.maxIterations,
        functions: registry.list(),
      });

      console.log(`[Agent spawned: ${agent.id}]`);
      const result = await runtime.run(agent);

      if (result.result) {
        await store.set('last-result', result.result, { type: 'result' });
      }

      console.log(`[Agent completed: ${result.agentId} | iterations: ${result.iterations} | tokens: ${result.tokenUsage.totalTokens}]`);

      await memory.append('episodic', {
        id: result.agentId,
        timestamp: Date.now(),
        content: `Task: ${input.slice(0, 200)} | Result: ${JSON.stringify(result.result).slice(0, 500)}`,
        metadata: { task: input, iterations: result.iterations, tokens: result.tokenUsage.totalTokens },
      });
    } catch (err: unknown) {
      const error = err as Error;
      console.error(`[Error]: ${error.message}`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

function printTree(tree: AgentTree, indent: string): void {
  const tokenStr = `${(tree.tokenUsage.totalTokens / 1000).toFixed(1)}k`;
  console.log(`${indent}${tree.id.slice(0, 8)} [${tree.status}] (tokens: ${tokenStr})`);
  for (const child of tree.children) {
    printTree(child, indent + '  |- ');
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function main(args: string[]): Promise<number> {
  const config = getDefaultConfig();
  const command = args[0];

  if (command === '--help' || command === '-h') {
    console.log(`
RLM v${VERSION} - Recursive Language Model

Usage:
  rlm                               Start interactive REPL
  rlm run "<task>"                   Run a task directly
  rlm run "<task>" --context <file>  Run with context file(s)

Options:
  --model <model>          LLM model (default: ${config.model})
  --max-iterations <n>     Max iterations per agent (default: ${config.maxIterations})
  --max-depth <n>          Max recursion depth (default: ${config.maxDepth})
  --max-concurrent <n>     Max concurrent agents (default: ${config.maxConcurrent})
  --verbose                Enable verbose logging
  --context <file>         Load a context file (can be repeated)
`);
    return 0;
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--model':
        config.model = args[++i];
        break;
      case '--max-iterations':
        config.maxIterations = parseInt(args[++i], 10);
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
    }
  }

  if (!config.apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required.');
    console.error('Set it with: export ANTHROPIC_API_KEY=your-key-here');
    return 1;
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
        maxIterations: config.maxIterations,
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

  try {
    await startREPL(config);
    return 0;
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`Error: ${error.message}`);
    return 1;
  }
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

export { main, startREPL, getDefaultConfig };
