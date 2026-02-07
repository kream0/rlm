# RLM - Recursive Language Model

A TypeScript framework where Claude Code sub-agents run as headless `claude -p` processes with recursive spawning, pass-by-reference context variables, and fan-out/fan-in orchestration. Designed to be used inside an interactive Claude Code session.

## Why RLM?

Traditional LLM architectures hit a wall: **context window limits**. When an agent needs to coordinate work across multiple sub-tasks, each sub-agent's input and output bloats the parent's context until it overflows.

RLM solves this with three key ideas:

1. **Pass-by-Reference** -- Variables are stored centrally and passed as tiny reference handles (~150 bytes), not full values. A 10MB document is passed to sub-agents as a 150-byte ref. 50 agents working on 1MB each? The parent sees 7KB of refs instead of 50MB of data.

2. **Recursive Sub-Agent Spawning** -- Agents spawn child agents that run in their own context windows. Work fans out, results merge back. The parent's context stays clean.

3. **Memory Offloading** -- Four-layer memory system (working, episodic, semantic, procedural) lets agents persist knowledge beyond any single context window.

The result: a 200K-token context window can coordinate **2,700+ tasks** instead of 7.

## Architecture

```
Human terminal -> claude (interactive session)
  |
Claude Code imports RLM as library
  |-- ContextStore (persists variables to disk as JSON)
  |-- MemoryManager (cross-session knowledge)
  +-- RecursiveSpawner (fan-out/fan-in orchestrator)
       | spawns
       claude -p "task..." --output-format json --no-session-persistence
       claude -p "task..." --output-format json --no-session-persistence
       claude -p "task..." --output-format json --no-session-persistence
       | results merge back via VariableRefs
```

Key design: AgentRuntime does not drive a REPL loop. Claude Code sub-processes handle their own tool loops internally. AgentRuntime is spawn-and-wait: one `provider.execute()` call per sub-agent.

## Modules

| Module | File | Description |
|--------|------|-------------|
| **Context Store** | `src/context-store.ts` | Variable storage with pass-by-reference. O(1) ref lookups, automatic disk spilling, scoped variables. |
| **Agent Runtime** | `src/agent-runtime.ts` | Spawn-and-wait execution: sends prompt to Claude Code, collects result. |
| **Recursive Spawner** | `src/recursive-spawner.ts` | Fan-out/fan-in sub-agent orchestration with depth limits, concurrency control, and 5 merge strategies. |
| **Function Registry** | `src/function-registry.ts` | Custom callback registration for extensibility. |
| **Memory Manager** | `src/memory-manager.ts` | Four-layer memory: working (FIFO), episodic (event log), semantic (key-value knowledge), procedural (if-then rules). |
| **CLI** | `src/cli.ts` | CLI `run` command and programmatic API. |

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/)
- A [Claude Code subscription](https://claude.ai/) (no API key needed)

### Install

```bash
bun install
```

### Run a task

```bash
bun run dev -- run "Analyze this codebase and summarize its architecture"
bun run dev -- run "Analyze data" --claude-model opus
```

## Usage as a Library

```typescript
import {
  ContextStore,
  AgentRuntime,
  RecursiveSpawner,
  ClaudeCodeProvider,
} from 'rlm';

// Create provider (Claude Code CLI)
const provider = new ClaudeCodeProvider({
  model: 'sonnet',
  maxBudgetUsd: 1.0,
});

// Initialize components
const store = new ContextStore('./data/variables');
await store.init();

const runtime = new AgentRuntime({ provider, store });

const spawner = new RecursiveSpawner({
  runtime, store,
  defaultModel: 'claude-sonnet-4-5-20250929',
  maxDepth: 5,
  maxConcurrent: 3,
});

// Store data -- sub-agents receive a 150-byte ref, not the full value
const docRef = await store.set('large-doc', tenMegabyteString);

// Spawn a sub-agent with the reference
const resultRef = await spawner.spawn({
  prompt: 'Analyze the document and extract key findings',
  context: { doc: docRef },
});

// Read the result
const result = await store.resolve(resultRef);
```

## Provider

RLM uses Claude Code CLI exclusively. Sub-agents run as headless `claude -p` processes.

```typescript
interface LLMProvider {
  execute(params: {
    prompt: string;
    model?: string;
    maxBudgetUsd?: number;
    permissionMode?: string;
  }): Promise<ExecutionResult>;
}

interface ExecutionResult {
  result: string;
  costUsd?: number;
  durationMs?: number;
  sessionId?: string;
  numTurns?: number;
}
```

### CLI Options

```
--model <model>              LLM model (default: claude-sonnet-4-5-20250929)
--max-depth <n>              Max recursion depth (default: 5)
--max-concurrent <n>         Max concurrent agents (default: 3)
--verbose                    Enable verbose logging
--context <file>             Load a context file (can be repeated)
--claude-binary <path>       Path to claude binary (default: 'claude')
--claude-budget <usd>        Max budget per invocation
--claude-model <model>       Model for provider (default: 'sonnet')
--claude-permission-mode     Permission mode (default: 'acceptEdits')
```

## Key Concepts

### Pass-by-Reference

Variables are stored once in the Context Store and referenced by lightweight handles:

```typescript
// Store 10MB of data
const ref = await store.set('dataset', hugeDataset);
// ref is ~150 bytes: { id, key, scope, type, sizeBytes, createdAt }

// Pass to 50 sub-agents -- each gets 150 bytes, not 10MB
for (const task of tasks) {
  await spawner.spawn({
    prompt: task,
    context: { data: ref },  // tiny ref, not the value
  });
}
```

### Merge Strategies

When multiple sub-agents return results, merge them back:

| Strategy | Use Case |
|----------|----------|
| `concatenate` | Combine parallel analyses into one document |
| `structured` | Each result becomes a field in a merged object |
| `vote` | Consensus -- return the most common answer |
| `summarize` | Create an overview of all results |
| `custom` | Provide your own merge handler |

```typescript
const refs = await spawner.spawnMany(configs);
const merged = await spawner.merge(refs, { type: 'structured' });
```

### Memory Layers

| Layer | Storage | Use Case |
|-------|---------|----------|
| **Working** | In-memory FIFO | Immediate context, auto-compacts |
| **Episodic** | Persistent JSON | Event log, searchable history |
| **Semantic** | Persistent Map | Facts and knowledge, O(1) recall |
| **Procedural** | Persistent JSON | If-then rules for decision patterns |

## Scripts

```bash
bun run dev -- run "<task>"  # Run a task
bun run demo                 # Run feature demonstration
bun run benchmark            # Run performance benchmarks
bun test                     # Run all tests
bun run build                # Build for distribution
bun run lint                 # Type check
```

## Benchmark Results

Run `bun run benchmark` to see full results. Key numbers:

| Metric | Result |
|--------|--------|
| 10MB data ref size | ~150 bytes (70,000x reduction) |
| 50 agents x 1MB | 7KB refs vs 50MB values (99.99% savings) |
| `ref()` latency | < 1 us, O(1) constant time |
| `set()` at 1KB | ~200,000 ops/sec |
| Memory search (2000 entries) | < 5 ms |
| Semantic `recall()` | < 1 us, O(1) Map lookup |
| Context capacity (200K tokens) | 2,700+ tasks with refs vs 7 without |
| All merge strategies | < 1 ms for 10 results |

## Project Structure

```
rlm/
  src/
    types.ts              Type definitions, LLMProvider, ExecutionResult
    index.ts              Public API exports
    context-store.ts      Variable storage with references
    memory-manager.ts     Multi-layer memory system
    function-registry.ts  Custom callback registration
    agent-runtime.ts      Spawn-and-wait agent execution
    recursive-spawner.ts  Sub-agent spawning and merging
    claude-code-provider.ts  Claude Code CLI provider
    cli.ts                CLI interface
    demo.ts               Feature demonstration
    benchmark.ts          Performance benchmark suite
  tests/
    context-store.test.ts
    memory-manager.test.ts
    function-registry.test.ts
    agent-runtime.test.ts
    recursive-spawner.test.ts
    integration.test.ts
    claude-code-provider.test.ts
```

## Tech Stack

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js
- **LLM Provider**: Claude Code CLI (`claude -p`)
- **Testing**: Vitest
- **Build**: tsup
- **Dependencies**: Zero external dependencies

## License

MIT
