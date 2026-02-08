# CLI Specification

**Status: Implemented** | Source: `src/cli.ts` | Tests: `tests/cli.test.ts`

## Purpose

The CLI provides both a command-line interface (`rlm run`) and a programmatic API (`import { run } from 'rlm'`) for launching agents. It wires together all the modules (ContextStore, MemoryManager, AgentRuntime, RecursiveSpawner, ClaudeCodeProvider) and provides the entry point for task execution.

## Implementation Reality vs. Original Spec

The CLI was originally designed with an interactive REPL mode, a `status` command for real-time agent tree visualization, and a `config` command for persistent configuration. The actual implementation is simpler and more focused.

### What Was Implemented

- `rlm run "<task>"` -- Run a task via Claude Code
- `rlm run "<task>" --context <file>` -- Run with context files
- `rlm --help` -- Show usage
- Programmatic `run()` function for library import
- Full CLI argument parsing for model, depth, concurrency, and Claude Code options

### What Was Omitted

| Original Spec Feature | Status | Rationale |
|---|---|---|
| Interactive REPL mode (`rlm` without args) | **Omitted** | Primary usage is as library import inside an interactive Claude Code session. An RLM-specific REPL would be redundant. |
| `rlm status` command | **Omitted** | Agent tree available via `spawner.getTree()` in programmatic API but no CLI command for it. |
| `rlm config set/get` commands | **Omitted** | Configuration via CLI flags per invocation. No persistent config file. |
| Real-time agent tree display | **Omitted** | No streaming/live output. Results printed after completion. |
| Variable management commands | **Omitted** | Variables managed via ContextStore API, not CLI commands. |

## Implemented Commands

### `rlm run`

```bash
rlm run "<task>"                   # Run a task
rlm run "<task>" --context <file>  # Run with context file(s)
```

Behavior:
1. Creates the full system (provider, store, memory, runtime, spawner)
2. Loads context files into ContextStore as `text` variables
3. Appends file metadata to the task prompt
4. Creates a single agent via `runtime.create()` and runs it
5. Prints the agent ID on start and completion status
6. Returns exit code 0 (success) or 1 (failure)

### `rlm --help`

Prints usage information with all available options.

## CLI Options

| Flag | Default | Description |
|---|---|---|
| `--model <model>` | `claude-opus-4-6` | Default LLM model |
| `--max-depth <n>` | `5` | Max recursion depth |
| `--max-concurrent <n>` | `3` | Max concurrent agents |
| `--verbose` / `-v` | `false` | Enable verbose logging to stderr |
| `--context <file>` | none | Load a context file (can be repeated) |
| `--claude-binary <path>` | `claude` | Path to claude binary |
| `--claude-budget <usd>` | none | Max budget per claude-code invocation |
| `--claude-model <model>` | `opus` | Model for claude-code provider |
| `--claude-permission-mode <mode>` | `acceptEdits` | Permission mode for Claude Code |

## Programmatic API

### `run(task, options?)`

The primary programmatic entry point:

```typescript
import { run } from 'rlm';

const result: AgentResult = await run("Analyze the codebase", {
  contextFiles: ['./src/main.ts', './README.md'],
  model: 'claude-opus-4-6',
  maxDepth: 3,
  verbose: true,
});

console.log(result.result);    // The agent's text response
console.log(result.costUsd);   // Cost of the execution
console.log(result.numTurns);  // Number of internal Claude Code turns
```

### `createSystem(config)`

Lower-level API for full control:

```typescript
import { createSystem, getDefaultConfig } from 'rlm';

const config = getDefaultConfig();
config.verbose = true;
config.maxConcurrent = 5;

const { store, memory, runtime, spawner, provider } = await createSystem(config);

// Use modules directly
const ref = await store.set('data', myLargeDataset, { type: 'text' });
const resultRef = await spawner.spawn({
  prompt: 'Analyze this data',
  context: { data: store.ref('data') },
});
const result = await store.resolve(resultRef);
```

### `getDefaultConfig()`

Returns the default configuration:

```typescript
{
  model: 'claude-opus-4-6',
  maxDepth: 5,
  maxConcurrent: 3,
  tokenBudget: 1_000_000,
  storageDir: '.rlm-data',     // resolved to absolute path
  verbose: false,
}
```

## System Wiring

The `createSystem()` function wires modules together:

```
ClaudeCodeProvider
  ^
  |
AgentRuntime(provider, store)
  ^
  |
RecursiveSpawner(runtime, store, defaultModel, maxDepth, maxConcurrent)

ContextStore(.rlm-data/variables/)
MemoryManager(.rlm-data/memory/)   <-- instantiated but NOT connected to runtime
```

**Note:** `MemoryManager` and `FunctionRegistry` (not instantiated in `createSystem`) are available as standalone modules but not wired into the execution pipeline.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Task completed successfully |
| `1` | Task failed or error occurred |

The original spec defined exit codes 2 (token budget exceeded) and 3 (max iterations exceeded), but these are not implemented because the runtime does not track token budgets or iterations.

## What Changed from the Original Spec

| Original Spec Feature | Current Status | Reason |
|---|---|---|
| Interactive REPL mode | **Omitted** | Redundant with Claude Code's interactive mode |
| `rlm status` command | **Omitted** | No real-time CLI monitoring |
| `rlm config` command | **Omitted** | Config via flags, no persistence |
| `apiKey` in config | **Removed** | No Anthropic API; Claude Code handles auth |
| Detailed exit codes (2, 3, 130) | **Simplified** | Only 0 and 1 |
| Real-time agent tree display | **Omitted** | Would require streaming output |

## Limitations and Future Work

### Current Limitations

1. **No streaming output.** The CLI prints agent start/complete messages but does not stream sub-agent progress.

2. **Single agent only.** The `run` command creates a single top-level agent. To use fan-out/fan-in, you must use the programmatic API.

3. **No persistent configuration.** Every invocation requires full flag specification.

4. **MemoryManager not wired in.** The `createSystem()` function creates a MemoryManager but nothing uses it.

### Planned Improvements

1. **Streaming progress** -- Pipe sub-agent stderr output for real-time progress
2. **Multi-agent CLI** -- Support for `rlm fan-out "<task>" --split <file> --chunks <n>` to demonstrate context decomposition from the CLI
3. **Configuration file** -- Load config from `.rlm.json` or similar
4. **Status command** -- `rlm status` to show running agents and their tree (for long-running tasks)
