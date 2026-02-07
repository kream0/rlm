# RLM - Recursive Language Model

A TypeScript framework where LLMs are hooked directly to a REPL with recursive sub-agent spawning, pass-by-reference context variables, and user-as-function. This is not a chatbot -- it's a programming language come alive.

## Why RLM?

Traditional LLM architectures hit a wall: **context window limits**. When an agent needs to coordinate work across multiple sub-tasks, each sub-agent's input and output bloats the parent's context until it overflows.

RLM solves this with three key ideas:

1. **Pass-by-Reference** -- Variables are stored centrally and passed as tiny reference handles (~150 bytes), not full values. A 10MB document is passed to sub-agents as a 150-byte ref. 50 agents working on 1MB each? The parent sees 7KB of refs instead of 50MB of data.

2. **Recursive Sub-Agent Spawning** -- Agents spawn child agents that run in their own context windows. Work fans out, results merge back. The parent's context stays clean.

3. **Memory Offloading** -- Four-layer memory system (working, episodic, semantic, procedural) lets agents persist knowledge beyond any single context window.

The result: a 200K-token context window can coordinate **2,700+ tasks** instead of 7.

## Architecture

```
                    +-----------------------+
                    |     RLM Runtime       |
                    |  (Orchestrator/REPL)  |
                    +-----------+-----------+
                                |
              +-----------------+-----------------+
              |                 |                 |
     +--------v------+  +------v--------+  +-----v-------+
     | Context Store |  | Agent Spawner |  | Function    |
     | (Variables)   |  | (Recursive)   |  | Registry    |
     +--------+------+  +------+--------+  +-----+-------+
              |                 |                 |
              |         +-------v-------+         |
              |         | Sub-Agent     |         |
              |         | {prompt, ctx} |         |
              |         +-------+-------+         |
              |                 |                 |
              +--------+--------+---------+-------+
                       |                  |
              +--------v------+   +-------v-------+
              | LLM Provider  |   | User Function |
              | (see below)   |   | (I/O Bridge)  |
              +--+--------+--+   +---------------+
                 |        |
     +-----------v--+ +---v--------------+
     | Anthropic    | | Claude Code CLI  |
     | API (SDK)    | | (claude -p)      |
     +--------------+ +------------------+
```

## Modules

| Module | File | Description |
|--------|------|-------------|
| **Context Store** | `src/context-store.ts` | Variable storage with pass-by-reference. O(1) ref lookups, automatic disk spilling, scoped variables. |
| **Agent Runtime** | `src/agent-runtime.ts` | REPL loop that drives agents through observe-decide-act cycles with tool use. |
| **Recursive Spawner** | `src/recursive-spawner.ts` | Fan-out/fan-in sub-agent orchestration with depth limits, concurrency control, and 5 merge strategies. |
| **Function Registry** | `src/function-registry.ts` | Tool registration system. User, agent, and core tools are all callable entities. |
| **Memory Manager** | `src/memory-manager.ts` | Four-layer memory: working (FIFO), episodic (event log), semantic (key-value knowledge), procedural (if-then rules). |
| **CLI** | `src/cli.ts` | Interactive REPL and programmatic API for running agents. |

## Quick Start

### Prerequisites

- Node.js 18+
- **Either** a [Claude Code subscription](https://claude.ai/) (no API key needed) **or** an [Anthropic API key](https://console.anthropic.com/)

### Install

```bash
npm install
```

### Run with Claude Code (no API key)

```bash
npm run dev
# Provider auto-detected as 'claude-code' when no ANTHROPIC_API_KEY is set
```

### Run with Anthropic API

```bash
export ANTHROPIC_API_KEY=your-key-here
npm run dev
```

### Run a task directly

```bash
npm run dev -- run "Analyze this codebase and summarize its architecture"
npm run dev -- run "Analyze data" --provider claude-code --claude-model opus
```

### REPL Commands

```
.status    Show agent tree and token stats
.vars      List all context variables
.store     Store a variable manually
.clear     Clear all data
.quit      Exit
```

## Usage as a Library

```typescript
import {
  ContextStore,
  AgentRuntime,
  RecursiveSpawner,
  AnthropicProvider,
  ClaudeCodeProvider,
  createCoreFunctions,
} from 'rlm';

// Choose a provider
const provider = process.env.ANTHROPIC_API_KEY
  ? new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY })
  : new ClaudeCodeProvider({ model: 'sonnet', maxBudgetUsd: 1.0 });

// Initialize components
const store = new ContextStore('./data/variables');
await store.init();

const registry = new FunctionRegistry();
for (const fn of createCoreFunctions({ store })) {
  registry.register(fn);
}

const runtime = new AgentRuntime({ provider, store, registry });

const spawner = new RecursiveSpawner({
  runtime, store, registry,
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

## Providers

RLM abstracts LLM access behind the `LLMProvider` interface, with two built-in implementations:

### Claude Code (`--provider claude-code`)

Sub-agents run as headless Claude Code CLI processes (`claude -p`). No API key needed -- just a Claude Code subscription. Claude Code handles its own tool use, file access, and iteration natively. RLM spawns processes, waits for JSON output, and collects results.

Context variables are persisted as JSON files on disk. Sub-agent prompts include absolute file paths so Claude Code can read them with its native `Read` tool.

```bash
npm run dev -- --provider claude-code
npm run dev -- --provider claude-code --claude-binary /path/to/claude --claude-budget 1.0 --claude-model opus
```

### Anthropic API (`--provider api`)

Direct API calls via `@anthropic-ai/sdk`. Requires `ANTHROPIC_API_KEY`. This is the traditional mode where RLM drives the full REPL loop (tool calls, iteration, context management).

```bash
export ANTHROPIC_API_KEY=sk-...
npm run dev -- --provider api
```

### Auto-detection

If `--provider` is not specified, RLM auto-detects:
- `api` if `ANTHROPIC_API_KEY` is set
- `claude-code` otherwise

### Provider CLI Options

```
--provider <type>        'api' or 'claude-code' (default: auto-detect)
--claude-binary <path>   Path to claude binary (default: 'claude')
--claude-budget <usd>    Max budget per claude-code invocation
--claude-model <model>   Model for claude-code provider (default: 'sonnet')
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

### User-as-Function

The human is not a privileged conversation partner -- they're a callable tool:

```typescript
// The agent calls ask_user() like any other tool
const answer = await ask_user("What format should the report be in?");
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
npm run dev          # Start interactive REPL
npm run demo         # Run feature demonstration
npm run benchmark    # Run performance benchmarks
npm test             # Run all tests (121 tests)
npm run build        # Build for distribution
npm run lint         # Type check
```

## Benchmark Results

Run `npm run benchmark` to see full results. Key numbers:

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
    types.ts              Type definitions and LLMProvider interface
    index.ts              Public API exports
    context-store.ts      Variable storage with references
    memory-manager.ts     Multi-layer memory system
    function-registry.ts  Tool management
    agent-runtime.ts      Agent execution loop (uses LLMProvider)
    recursive-spawner.ts  Sub-agent spawning and merging
    cli.ts                REPL and CLI interface
    demo.ts               Feature demonstration
    benchmark.ts          Performance benchmark suite
    providers/
      index.ts            Provider barrel exports
      anthropic-provider.ts   Anthropic SDK provider
      claude-code-provider.ts Claude Code CLI provider
  tests/
    context-store.test.ts
    memory-manager.test.ts
    function-registry.test.ts
    agent-runtime.test.ts
    recursive-spawner.test.ts
    integration.test.ts
    claude-code-provider.test.ts
  specs/                  Detailed specifications per module
  SPECS.md                Architecture overview
  CLAUDE.md               Development instructions
```

## Tech Stack

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js
- **LLM Providers**: Anthropic API (`@anthropic-ai/sdk`) or Claude Code CLI (`claude -p`)
- **Testing**: Vitest
- **Build**: tsup

## License

MIT
