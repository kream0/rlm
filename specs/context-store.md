# Context Store Specification

## Purpose

The Context Store is the core data layer of the RLM. It stores variables that agents can reference, pass, and operate over WITHOUT reading their full contents into the LLM context window. This is the key innovation: variables are handles/references, not inline data.

## Requirements

### Variable Operations

1. **`set(key, value)`** - Store any value (string, object, array, Buffer) under a key
2. **`get(key)`** - Retrieve the full value (used by tools, NOT by LLM directly)
3. **`ref(key)`** - Return a lightweight reference/handle (what gets passed to sub-agents)
4. **`resolve(ref)`** - Dereference a handle back to its value
5. **`delete(key)`** - Remove a variable
6. **`list()`** - List all variable keys with metadata (size, type, created)
7. **`summarize(key, maxTokens?)`** - Get a token-limited summary of a variable's contents (for LLM awareness without full loading)

### Variable Types

- `text` - Plain text, documents, code
- `json` - Structured data
- `memory` - Agent memories (conversation history, learnings)
- `result` - Return values from sub-agents
- `stream` - Streaming data (for large datasets)

### Reference Passing

When a sub-agent is spawned, it receives variable REFERENCES, not copies:
```typescript
// Parent agent
const dataRef = store.ref('large-dataset'); // ~500KB of data
spawner.spawn({
  prompt: "Analyze the dataset",
  context: { data: dataRef } // Only passes the reference handle (~50 bytes)
});

// Sub-agent can resolve when needed
const data = store.resolve(context.data); // Full 500KB loaded only when needed
```

### Scoping

- Variables have **scope**: `global`, `agent:{id}`, `session:{id}`
- Sub-agents inherit parent's global scope
- Sub-agents get their own agent scope
- Variables can be promoted from agent scope to global scope

### Persistence

- In-memory store for session variables (fast)
- File-backed store for persistent variables (survives restart)
- Variables over a size threshold automatically spill to disk

## Interface

```typescript
interface ContextStore {
  set(key: string, value: unknown, opts?: SetOptions): Promise<VariableRef>;
  get(key: string): Promise<unknown>;
  ref(key: string): VariableRef;
  resolve(ref: VariableRef): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(filter?: ListFilter): Promise<VariableMeta[]>;
  summarize(key: string, maxTokens?: number): Promise<string>;
}

interface VariableRef {
  id: string;
  key: string;
  scope: 'global' | `agent:${string}` | `session:${string}`;
  type: VariableType;
  sizeBytes: number;
  // NO value field - that's the point
}

interface SetOptions {
  scope?: string;
  type?: VariableType;
  persist?: boolean;
}
```

## Performance Requirements

- `ref()` must be O(1) - just returns metadata
- `set()`/`get()` for in-memory: < 1ms
- `set()`/`get()` for file-backed: < 50ms
- `summarize()`: Uses a fast model call if needed, cached after first call
- Memory ceiling: configurable, default 256MB for in-memory store
