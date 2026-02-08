# Recursive Spawner Specification

**Status: Implemented** | Source: `src/recursive-spawner.ts` | Tests: `tests/recursive-spawner.test.ts`

## Purpose

The Recursive Spawner enables fan-out/fan-in orchestration of sub-agents. It creates sub-agents via the AgentRuntime, manages concurrency and depth limits, and provides five merge strategies for combining results. This is the module that makes the system "recursive" -- an agent can spawn more of itself.

## Paper Alignment

| Paper Concept | Our Implementation | Notes |
|---|---|---|
| `rlm_agent(query, context)` function | `spawn(config)` method | Launches a `claude -p` subprocess |
| O(\|P\|) sub-processes for context decomposition | `spawnMany(configs)` with parallel execution | Configurable concurrency |
| O(\|P\|^2) for quadratic tasks | Recursive `spawn()` with depth tracking | Max depth configurable |
| Sequential sub-agent execution (paper) | **Parallel** execution with `Promise.all()` | Improvement over paper |
| Parent reads sub-results | Merge strategies (5 types) | Programmatic merging without LLM |

### Context Decomposition vs Task Decomposition

The paper identifies two key patterns. Our spawner supports both:

1. **Context decomposition**: Split a large context into chunks, send each to a sub-agent with the same task.
   ```typescript
   // Split a 1MB document into 10 chunks, analyze each
   const configs = chunks.map(chunk => ({
     prompt: "Find anomalies in this data section",
     context: { section: store.ref(chunk.key) },
   }));
   const refs = await spawner.spawnMany(configs);
   ```

2. **Task decomposition**: Keep the same context, delegate different subtasks.
   ```typescript
   // Same codebase, different analysis tasks
   const configs = [
     { prompt: "Find security vulnerabilities", context: { code: codeRef } },
     { prompt: "Identify performance bottlenecks", context: { code: codeRef } },
     { prompt: "Check for code style issues", context: { code: codeRef } },
   ];
   const refs = await spawner.spawnMany(configs);
   ```

## Implemented Features

### Single Spawn

```typescript
const resultRef: VariableRef = await spawner.spawn(config, parentId?, depth?);
```

The `spawn()` method:

1. Checks recursion depth against `maxDepth` (throws if exceeded)
2. Checks concurrency against `maxConcurrent` (waits for a slot if full)
3. Generates a UUID for the new agent
4. Builds the context prompt:
   - Starts with `config.prompt`
   - For each context variable, persists it to disk via `store.persistForSubAgent()`
   - Appends file path instructions so the sub-agent can read the data
5. Creates an agent via `runtime.create()` and runs it via `runtime.run()`
6. Stores the result as `sub-result-{agentId}` in the ContextStore
7. Returns the VariableRef to the result (not the result itself)

### Fan-Out (Parallel Spawn)

```typescript
const resultRefs: VariableRef[] = await spawner.spawnMany(configs, parentId?, depth?);
```

Spawns all agents concurrently using `Promise.all()`. Concurrency is limited by `maxConcurrent` -- if all slots are full, individual `spawn()` calls wait in `waitForSlot()` polling loop (100ms intervals).

### Merge Strategies (Fan-In)

```typescript
const mergedRef: VariableRef = await spawner.merge(refs, { type: 'concatenate' });
```

Five merge strategies are implemented:

| Strategy | Behavior | Output Type |
|---|---|---|
| `concatenate` | Join all results with `\n---\n` separator | string |
| `structured` | Create object with `{ref.key: value}` entries | object |
| `vote` | Count identical results, pick the most common | `{ winner, votes }` |
| `summarize` | Label each result with source, concatenate | string |
| `custom` | Call user-provided `customMergeFn(results)` | any |

**Important:** None of the built-in merge strategies make LLM calls. They are all programmatic transformations. The `summarize` strategy, despite its name, simply concatenates labeled results -- it does not use an LLM to generate a summary.

### Agent Tree Visualization

```typescript
const tree: AgentTree = spawner.getTree();
```

Returns a recursive tree structure showing all spawned agents, their statuses, and parent-child relationships:

```typescript
interface AgentTree {
  id: string;
  status: string;        // 'running' | 'completed' | 'failed' | 'unknown'
  children: AgentTree[];
  tokenUsage: TokenUsage;
  depth: number;
}
```

### Tracking and Monitoring

```typescript
spawner.getTotalTokenUsage();  // Aggregated TokenUsage across all agents
spawner.getActiveCount();      // Number of currently running agents
spawner.reset();               // Clear all tracking state
```

## Recursion Control

| Control | Default | Description |
|---|---|---|
| `maxDepth` | 5 | Maximum recursion depth (checked per spawn) |
| `maxConcurrent` | 3 | Maximum concurrent sub-agents (blocks if full) |
| Timeout | Via `ClaudeCodeProvider` (5 min) | Per-agent timeout at the provider level |

**Not yet implemented:**
- Token budget allocation to sub-agents
- Circuit breaker (stop spawning after N failures)
- Per-agent timeout at the spawner level

## Context Passing to Sub-Agents

The spawner bridges the cross-process boundary by persisting variables to disk:

```
Parent Process (RLM orchestrator)                Sub-Agent Process (claude -p)
=================================                ============================

store.ref('dataset')
  |
  +-> store.persistForSubAgent('dataset')
  |     |
  |     +-> Writes .rlm-data/variables/dataset.json
  |
  +-> Builds prompt:
        "Analyze the dataset"
        ""
        "Context variable 'data' (5000 bytes):"
        "Read /abs/path/.rlm-data/variables/dataset.json"
        "The JSON file has a 'value' field."
                                                  |
                                                  +-> Claude Code reads the file
                                                  +-> Extracts the "value" field
                                                  +-> Uses the data for analysis
                                                  +-> Returns JSON result
```

## Interface (Actual Implementation)

```typescript
interface RecursiveSpawnerOptions {
  runtime: AgentRuntime;
  store: ContextStore;
  defaultModel: string;
  maxDepth: number;
  maxConcurrent: number;
  onLog?: (message: string) => void;
}

interface IRecursiveSpawner {
  spawn(config: SpawnConfig): Promise<VariableRef>;
  spawnMany(configs: SpawnConfig[]): Promise<VariableRef[]>;
  merge(refs: VariableRef[], strategy: MergeStrategy): Promise<VariableRef>;
  getTree(): AgentTree;
}

interface SpawnConfig {
  prompt: string;
  context: Record<string, VariableRef>;
  model?: string;
  timeout?: number;
  onComplete?: 'return' | 'merge' | 'store';
}

interface MergeStrategy {
  type: 'concatenate' | 'summarize' | 'structured' | 'vote' | 'custom';
  customMergeFn?: (results: unknown[]) => Promise<unknown>;
}
```

## What Changed from the Original Spec

| Original Spec Feature | Current Status | Reason |
|---|---|---|
| Token budget per sub-agent | **Not implemented** | ClaudeCodeProvider supports `maxBudgetUsd` but not propagated from spawner |
| Circuit breaker | **Not implemented** | Would be useful for large fan-outs |
| Timeout per agent at spawner level | **Not implemented** | Timeout exists at provider level (5 min default) |

## Performance Characteristics

| Metric | Value | Notes |
|---|---|---|
| Sub-agent startup | 1-3 seconds | Claude Code process initialization |
| Variable ref passing | O(1) | Just file path string in prompt |
| Context persistence | O(n) | JSON write to disk per variable |
| Concurrency limit | `maxConcurrent` | Polling wait at 100ms intervals |
| Memory per sub-agent | Independent | Each `claude -p` is a separate OS process |

## Limitations and Future Work

### Current Limitations

1. **Polling-based concurrency wait.** `waitForSlot()` uses `setTimeout(100ms)` polling. An event-based approach would be more efficient.

2. **No circuit breaker.** If many sub-agents fail, the spawner continues trying. A circuit breaker would stop after N failures.

3. **Merge strategies are all programmatic.** The `summarize` strategy does not actually use an LLM. For true summarization, you would need to spawn another agent.

4. **No result streaming.** The parent must wait for all sub-agents to complete before merging. Incremental/streaming results are not supported.

### Planned Improvements

1. **Event-based concurrency** -- Replace polling with a proper semaphore/queue
2. **Circuit breaker** -- Stop spawning after configurable N failures
3. **LLM-powered summarize merge** -- Use a sub-agent to produce a true summary of merged results
4. **Token budget propagation** -- Divide parent's budget across children based on task complexity
5. **Result streaming** -- Process results as sub-agents complete, not only after all finish
6. **OOLONG-Pairs benchmark** -- Implement the paper's quadratic reasoning benchmark to measure our recursive decomposition effectiveness
