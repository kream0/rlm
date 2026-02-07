# Recursive Spawner Specification

## Purpose

The Recursive Spawner enables agents to create sub-agents with their own {prompt, context} pairs. Sub-agents run independently, consume their own context windows, and return results to parents. This is what makes the system recursive - an agent can spawn more of itself.

## Requirements

### Spawning

```typescript
// An agent spawns a sub-agent
const result = await spawn({
  prompt: "Analyze this dataset for anomalies",
  context: {
    data: store.ref('dataset-2024'),     // Reference, not value
    schema: store.ref('data-schema'),    // Reference, not value
  },
  model: 'claude-sonnet-4-5-20250929',  // Can use cheaper model
  maxIterations: 10,
  onComplete: 'return'                   // Return result to parent
});
```

### Fan-Out / Fan-In (Map-Reduce)

```typescript
// Fan out: spawn multiple sub-agents in parallel
const results = await spawnMany([
  { prompt: "Analyze section 1", context: { section: store.ref('sec-1') } },
  { prompt: "Analyze section 2", context: { section: store.ref('sec-2') } },
  { prompt: "Analyze section 3", context: { section: store.ref('sec-3') } },
]);

// Fan in: merge results
const merged = await merge(results, {
  strategy: 'concatenate' | 'summarize' | 'custom',
  customMergeFn?: (results) => mergedResult
});
```

### Merge Strategies

1. **Concatenate**: Join all results into a single variable
2. **Summarize**: Use an LLM to summarize all results into a concise output
3. **Structured**: Each sub-agent returns a specific field, merge into one object
4. **Vote**: Multiple sub-agents answer the same question, take consensus
5. **Custom**: User-provided merge function

### Recursion Control

- **Max depth**: Configurable recursion limit (default: 5)
- **Max concurrent**: Configurable parallelism limit (default: 3)
- **Token budget**: Parent can allocate a token budget to sub-agents
- **Timeout**: Per-agent timeout with graceful cancellation
- **Circuit breaker**: If N sub-agents fail, stop spawning more

### Result Propagation

Sub-agent results flow back to the parent via the context store:
```
Parent Agent
  |
  +-- spawn(prompt, {data: ref('x')})
  |     |
  |     +-- Sub-Agent runs in its own context
  |     +-- Sub-Agent calls return_result(analysis)
  |     +-- Result stored as variable: 'sub-result-{id}'
  |     +-- ONLY the result variable ref returned to parent
  |
  +-- Parent receives ref to result (not the full result)
  +-- Parent can resolve(ref) to read, or pass to another sub-agent
```

The KEY insight: the parent's context window barely grows regardless of how much work the sub-agents did.

## Interface

```typescript
interface RecursiveSpawner {
  spawn(config: SpawnConfig): Promise<VariableRef>;  // Returns ref to result
  spawnMany(configs: SpawnConfig[]): Promise<VariableRef[]>;
  merge(refs: VariableRef[], strategy: MergeStrategy): Promise<VariableRef>;
  getTree(): AgentTree;  // Visualize the recursion tree
}

interface SpawnConfig {
  prompt: string;
  context: Record<string, VariableRef>;
  model?: string;
  maxIterations?: number;
  timeout?: number;
  onComplete?: 'return' | 'merge' | 'store';
}

interface AgentTree {
  id: string;
  status: string;
  children: AgentTree[];
  tokenUsage: TokenUsage;
  depth: number;
}
```

## Performance

- Sub-agent startup: < 500ms
- Variable ref passing: O(1) regardless of variable size
- Concurrent sub-agents: limited by LLM API rate limits
- Memory: each sub-agent's context is independent (no shared context window pollution)
