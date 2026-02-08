# Function Registry Specification

**Status: Implemented (standalone)** | Source: `src/function-registry.ts` | Tests: `tests/function-registry.test.ts`

## Purpose

The Function Registry manages custom callable functions that can be registered by the user. It provides a simple name-based registry with parameter validation and execution. Functions are stored as `FunctionSpec` objects with handlers that can be invoked programmatically.

## Implementation Reality vs. Original Spec

The original spec envisioned the Function Registry as the central nervous system of the RLM, providing built-in functions for shell execution, file I/O, store operations, and user interaction. The actual implementation is much simpler -- a **standalone registry for custom callbacks** with no built-in functions and no integration into the agent lifecycle.

### What Was Removed and Why

| Original Spec Feature | Status | Rationale |
|---|---|---|
| **Built-in context functions** (store_set, store_get, store_ref, etc.) | **Omitted** | Sub-agents are `claude -p` processes. They cannot call functions in the parent process. Context is shared via disk files. |
| **Built-in execution functions** (shell, read_file, write_file, edit_file) | **Omitted** | Claude Code has its own built-in tools for bash, file I/O, and editing. No need to re-implement. |
| **Built-in agent functions** (spawn_agent, return_result, call_llm) | **Omitted** | Spawning is orchestrated by RecursiveSpawner in the parent process, not by sub-agents calling functions. |
| **User-as-function** (ask_user, notify_user, final_answer) | **Omitted** | Sub-agents are headless (`--no-session-persistence`). User interaction happens in the interactive Claude Code session, not through function calls. |
| **Function scoping** (core, agent, user, custom) | **Omitted** | With no built-in functions, scoping is unnecessary. |
| **Function-to-tool translation** (toToolDefinitions) | **Omitted** | We do not construct Anthropic API tool definitions. Claude Code handles its own tools. |

### Why It Still Exists

The Function Registry is useful for **programmatic callbacks** when using RLM as a library. Examples:

```typescript
const registry = new FunctionRegistry();

// Register a data transformation
registry.register({
  name: 'normalize_scores',
  description: 'Normalize an array of scores to 0-1 range',
  parameters: {
    scores: { type: 'array', description: 'Array of numeric scores', required: true }
  },
  handler: async (params) => {
    const scores = params.scores as number[];
    const max = Math.max(...scores);
    return scores.map(s => s / max);
  },
});

// Execute it
const normalized = await registry.execute('normalize_scores', { scores: [10, 20, 30] });
// Result: [0.333, 0.666, 1.0]
```

This is useful for merge strategies, post-processing results, or any custom logic that the orchestrator needs.

## Implemented Features

### Registration

```typescript
registry.register(spec: FunctionSpec): void
```

Registers a function. Throws if a function with the same name already exists.

### Unregistration

```typescript
registry.unregister(name: string): void
```

Removes a function. Throws if the function is not found.

### Lookup

```typescript
registry.get(name: string): FunctionSpec    // Throws if not found
registry.has(name: string): boolean         // Safe check
registry.list(): FunctionSpec[]             // All registered functions
```

### Execution

```typescript
const result = await registry.execute(name: string, params: Record<string, unknown>): Promise<unknown>
```

Executes a registered function with parameter validation:
1. Looks up the function by name (throws if not found)
2. Checks for missing required parameters (throws if missing and no default)
3. Fills in default values for optional parameters
4. Calls the handler with the validated params

### Clear

```typescript
registry.clear(): void
```

Removes all registered functions.

## Interface (Actual Implementation)

```typescript
interface FunctionSpec {
  name: string;
  description: string;
  parameters: Record<string, ParameterSpec>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

interface ParameterSpec {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;   // Default: true (if not specified, parameter is required)
  default?: unknown;    // Default value when parameter is not provided
}

interface IFunctionRegistry {
  register(spec: FunctionSpec): void;
  unregister(name: string): void;
  get(name: string): FunctionSpec;
  list(): FunctionSpec[];
  execute(name: string, params: Record<string, unknown>): Promise<unknown>;
}
```

## Integration Status

| Integration Point | Status | Description |
|---|---|---|
| AgentRuntime | **Not integrated** | Functions are not passed to agents as tools |
| RecursiveSpawner | **Not integrated** | Could be used for custom merge functions |
| ContextStore | **Not integrated** | Could register store operations as functions |
| CLI | **Not integrated** | Not exposed via CLI commands |

The FunctionRegistry is exported from `index.ts` but is **not wired into any module** during normal operation. It exists as an independent utility available to library consumers.

## Paper Alignment

| Paper Concept | Our Approach |
|---|---|
| Pre-loaded functions in REPL | Claude Code's built-in tools serve this role |
| `rlm_agent()` callable | Handled by RecursiveSpawner, not FunctionRegistry |
| Custom Python functions | FunctionRegistry for TypeScript callbacks |

## Planned Improvements

1. **Integration with agent prompts** -- Serialize registered functions into the sub-agent prompt so Claude Code can call them (via a convention like writing JSON to a specific file that the orchestrator monitors)
2. **Custom merge functions** -- Wire FunctionRegistry into RecursiveSpawner so the `custom` merge strategy can reference registered functions by name
3. **Post-processing hooks** -- Register functions that automatically run on agent results (e.g., validation, transformation)
