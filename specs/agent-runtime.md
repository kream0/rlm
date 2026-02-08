# Agent Runtime Specification

**Status: Implemented** | Source: `src/agent-runtime.ts` | Tests: `tests/agent-runtime.test.ts`

## Purpose

The Agent Runtime is the execution engine that creates and runs agents. Unlike the original RLM paper's REPL-loop design, our AgentRuntime uses a **spawn-and-wait** model: it makes a single call to the LLM provider and waits for the result. The "REPL loop" (tool execution, multi-turn reasoning) happens inside the Claude Code subprocess, not in our runtime.

## Design Philosophy: Spawn-and-Wait (Not REPL)

The original spec described a REPL loop:

```
LOOP:                          <-- We do NOT do this
  1. Build prompt
  2. Send to LLM
  3. Receive response
  4. Execute tool calls
  5. Store results
  6. Check termination
  7. GOTO 1
```

Our actual design:

```
1. Build prompt (with context summary)
2. Call provider.execute() once
3. Claude Code runs internally (handles its own multi-turn tool loop)
4. Receive final result
5. Store in ContextStore
6. Return AgentResult
```

**Rationale:** Claude Code CLI (`claude -p`) is a complete agent. It handles tool calls (bash, file I/O, etc.), manages its own conversation history, and decides when to terminate. Our runtime's job is to *orchestrate multiple such agents*, not to re-implement what Claude Code already does.

## Paper Alignment

| Paper Concept | Our Approach | Notes |
|---|---|---|
| LLM writes code in REPL | Claude Code uses tools internally | Tool loop is inside the subprocess |
| Agent observes execution results | Claude Code sees tool outputs | Happens within the `claude -p` process |
| Termination via `return_result()` | Process exits with JSON | Natural subprocess lifecycle |
| Context window management | Not managed by runtime | Claude Code handles its own context |
| Multi-iteration reasoning | Not managed by runtime | Claude Code may take many internal turns |

## Implemented Features

### Agent Creation

```typescript
const runtime = new AgentRuntime({ provider, store, onLog });
const agent = runtime.create({
  id: 'agent-001',
  prompt: 'Analyze the codebase and find security issues',
  model: 'claude-opus-4-6',
  parentId: 'parent-agent-id',    // optional: marks as sub-agent
  onComplete: 'return',           // 'return' | 'merge' | 'store'
});
```

The `create()` method initializes an `Agent` object with status `'idle'` and registers it in the internal map.

### Agent Execution

```typescript
const result: AgentResult = await runtime.run(agent);
```

The `run()` method:

1. Sets agent status to `'running'`
2. Checks if the agent was cancelled before starting
3. Calls `buildPrompt()` to assemble the full prompt:
   - Starts with `agent.config.prompt`
   - If `contextRef` is set, appends a truncated summary from `store.summarize()`
   - If `parentId` is set, appends "You are a sub-agent. Complete your task and return the result."
4. Calls `provider.execute({ prompt, model })` -- a single, blocking call
5. Stores the result in `ContextStore` under key `agent-result-{id}`
6. Returns an `AgentResult` with the response text, cost, and metadata

### Agent Cancellation

```typescript
await runtime.cancel('agent-001');
```

Sets the agent's `cancelled` flag and status to `'cancelled'`. If `run()` is called on a cancelled agent, it returns immediately with an empty result.

**Limitation:** Cancellation is cooperative. If `provider.execute()` is already in progress (the `claude -p` process is running), the cancellation flag will not interrupt it. The process will run to completion.

### Status Tracking

```typescript
const status = runtime.getStatus('agent-001'); // 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
const agent = runtime.getAgent('agent-001');     // Full Agent object
```

## Interface (Actual Implementation)

```typescript
interface AgentRuntimeOptions {
  provider: LLMProvider;
  store: IContextStore;
  onLog?: (agentId: string, message: string) => void;
}

interface AgentConfig {
  id: string;
  prompt: string;
  contextRef?: VariableRef;     // Reference to context variable
  model: string;                // LLM model identifier
  parentId?: string;            // If this is a sub-agent
  onComplete?: 'return' | 'merge' | 'store';
}

interface Agent {
  id: string;
  config: AgentConfig;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  iterations: number;           // Always 1 (single execute() call)
  tokenUsage: TokenUsage;       // Currently always {0, 0, 0} (not tracked)
  result?: unknown;
  cancelled: boolean;
}

interface AgentResult {
  agentId: string;
  result: unknown;              // The text response from Claude Code
  tokenUsage: TokenUsage;
  iterations: number;           // Always 1
  children: AgentResult[];      // Always [] (children tracked by RecursiveSpawner)
  costUsd?: number;             // Cost reported by Claude Code
  sessionId?: string;           // Session ID from Claude Code
  numTurns?: number;            // Internal turns taken by Claude Code
}
```

## What Changed from the Original Spec

| Original Spec Feature | Current Status | Reason |
|---|---|---|
| REPL loop (iterate until termination) | **Removed** | Claude Code handles its own tool loop |
| `maxIterations` config | **Removed** | No iterations to limit |
| `functions: FunctionSpec[]` in config | **Removed** | Claude Code has its own tools; FunctionRegistry is standalone |
| `terminationFn` callback | **Removed** | Subprocess exits naturally |
| Token tracking / context utilization | **Not implemented** | Token usage not reported by runtime (cost comes from Claude Code) |
| Context compaction at 70% utilization | **Removed** | Claude Code manages its own context |
| Tool execution (shell, files, store) | **Removed** | Claude Code executes tools internally |
| `children: AgentResult[]` populated | **Not used** | Always empty; RecursiveSpawner tracks children separately |

## LLM Provider Interface

The runtime interacts with the LLM through the `LLMProvider` interface:

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
  result: string;           // The text result from Claude Code
  costUsd?: number;
  durationMs?: number;
  sessionId?: string;
  numTurns?: number;        // How many internal turns Claude Code took
}
```

The only implementation is `ClaudeCodeProvider` (see `src/claude-code-provider.ts`).

## Limitations and Future Work

### Current Limitations

1. **No token tracking.** `agent.tokenUsage` is always `{0, 0, 0}`. Cost information comes from `ExecutionResult.costUsd` but is not aggregated into token counts.

2. **No cancellation of running agents.** Once `provider.execute()` is called, the subprocess runs to completion. The `cancel()` method only prevents future `run()` calls.

3. **No retries.** If the subprocess fails, the error is stored as the result. No automatic retry with backoff.

4. **Children array unused.** `AgentResult.children` is always empty. The `RecursiveSpawner` tracks parent-child relationships separately.

5. **`iterations` is always 1.** The field exists for compatibility but has no meaning in spawn-and-wait mode.

### Planned Improvements

1. **Token tracking integration** -- Parse Claude Code's JSON output for token counts and aggregate them
2. **Process cancellation** -- Send SIGTERM to the subprocess on cancel()
3. **Retry with backoff** -- Configurable retry policy for transient failures
4. **Memory Manager integration** -- Automatically append agent execution results to episodic memory
5. **FunctionRegistry integration** -- Include registered function descriptions in the prompt so Claude Code can call them via tool use
