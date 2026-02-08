# Context Store Specification

**Status: Implemented** | Source: `src/context-store.ts` | Tests: `tests/context-store.test.ts`

## Purpose

The Context Store is the core data layer of RLM. It stores variables that agents can reference, pass, and operate over WITHOUT reading their full contents into the LLM context window. This is the key innovation from the RLM paper: variables are handles/references, not inline data.

In our implementation, the Context Store also serves as the **cross-process communication channel** between the orchestrator and sub-agents. Variables are persisted to disk as JSON files, allowing `claude -p` sub-processes to read context that was set by the parent.

## Paper Alignment

| Paper Concept | Our Implementation |
|---|---|
| `context` variable as symbolic handle | `VariableRef` object (~150 bytes) with key, scope, type, size |
| Agent gets metadata, not full content | `ref()` returns metadata only; `get()` / `resolve()` for full value |
| Output stored in environment | Results stored via `set()`, returned as `VariableRef` |

## Implemented Features

### Variable Operations

| Operation | Signature | Description | Status |
|---|---|---|---|
| `set` | `set(key, value, opts?) -> VariableRef` | Store any JSON-serializable value | Implemented |
| `get` | `get(key) -> unknown` | Retrieve full value (falls back to disk) | Implemented |
| `ref` | `ref(key) -> VariableRef` | O(1) metadata-only reference | Implemented |
| `resolve` | `resolve(ref) -> unknown` | Dereference a VariableRef to its value | Implemented |
| `delete` | `delete(key) -> void` | Remove from memory and disk | Implemented |
| `list` | `list(filter?) -> VariableMeta[]` | List variables with optional scope/type filter | Implemented |
| `summarize` | `summarize(key, maxTokens?) -> string` | Truncation-based summary with caching | Implemented |
| `has` | `has(key) -> boolean` | Check if variable exists in memory | Implemented |
| `clear` | `clear() -> void` | Remove all variables and disk files | Implemented |
| `persistForSubAgent` | `persistForSubAgent(key) -> filePath` | Persist to disk and return absolute path | Implemented |

### Variable Types

```typescript
type VariableType = 'text' | 'json' | 'memory' | 'result' | 'stream';
```

Types are inferred automatically from values:
- `string` -> `text`
- Array / plain object -> `json`
- Object with `entries` or `memories` -> `memory`
- Object with `result` or `output` -> `result`
- `stream` type exists but is not auto-inferred

### Reference Passing (The Core Innovation)

When a sub-agent is spawned, it receives variable REFERENCES, not copies:

```typescript
// Parent orchestrator
const dataRef = store.ref('large-dataset'); // VariableRef: ~150 bytes

// RecursiveSpawner persists the variable to disk:
const filePath = await store.persistForSubAgent('large-dataset');
// filePath -> "/abs/path/.rlm-data/variables/large-dataset.json"

// Sub-agent's prompt includes:
// 'Context variable "data" (512000 bytes, type: text):'
// 'Read /abs/path/.rlm-data/variables/large-dataset.json'
// 'The JSON file has a "value" field with the data.'
```

The parent's context window grows by ~200 characters regardless of whether the dataset is 1KB or 500KB.

### Scoping

Variables have scope strings: `global`, `agent:{id}`, `session:{id}`.

- Scope is stored as metadata on the `VariableRef`
- Filtering by scope is supported via `list({ scope: '...' })`
- Sub-agent results are scoped to `agent:{parentId}` when they have a parent

**Note:** Scope is advisory metadata. There is no access control -- any code with a reference to the store can read any variable regardless of scope.

### Persistence

| Layer | Behavior | When Used |
|---|---|---|
| In-memory Map | Fast access, lost on process exit | Default for all variables |
| File-backed (opt-in) | JSON files on disk, survives restart | When `persist: true` in SetOptions |
| File-backed (auto) | Automatic spill when memory ceiling exceeded | When `currentMemoryBytes > maxMemoryBytes` |
| File-backed (sub-agent) | Explicit persist for cross-process sharing | Via `persistForSubAgent()` |

Disk format: `{storageDir}/{sanitizedKey}.json`
```json
{
  "ref": { "id": "uuid", "key": "name", "scope": "global", "type": "text", "sizeBytes": 1234, "createdAt": 1706... },
  "value": "...the actual data...",
  "persist": true
}
```

### Initialization

```typescript
const store = new ContextStore('/path/to/.rlm-data/variables', 256 * 1024 * 1024);
await store.init(); // Creates directory if needed, loads persisted variables from disk
```

On `init()`, all `.json` files in the storage directory are loaded back into memory with their original `VariableRef` metadata.

## Interface (Actual Implementation)

```typescript
interface IContextStore {
  set(key: string, value: unknown, opts?: SetOptions): Promise<VariableRef>;
  get(key: string): Promise<unknown>;
  ref(key: string): VariableRef;
  resolve(ref: VariableRef): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(filter?: ListFilter): Promise<VariableMeta[]>;
  summarize(key: string, maxTokens?: number): Promise<string>;
  has(key: string): boolean;
  clear(): Promise<void>;
}

interface VariableRef {
  id: string;          // UUID
  key: string;         // Human-readable key
  scope: string;       // 'global' | 'agent:{id}' | 'session:{id}'
  type: VariableType;  // 'text' | 'json' | 'memory' | 'result' | 'stream'
  sizeBytes: number;   // Size of JSON-serialized value
  createdAt: number;   // Timestamp
  // NO value field -- that is the point
}

interface SetOptions {
  scope?: string;
  type?: VariableType;
  persist?: boolean;
}

interface ListFilter {
  scope?: string;
  type?: VariableType;
}
```

## Performance Characteristics

| Operation | Complexity | Notes |
|---|---|---|
| `ref()` | O(1) | Returns clone of pre-computed metadata |
| `set()` | O(n) | n = size of JSON serialization |
| `get()` (in memory) | O(1) | Map lookup |
| `get()` (from disk) | O(n) | File read + JSON parse |
| `summarize()` (cached) | O(1) | Returns cached string |
| `summarize()` (uncached) | O(n) | Truncation, then cached |
| `list()` | O(k) | k = number of stored variables |
| Memory ceiling | Configurable | Default 256MB for in-memory store |

## Limitations and Future Work

### Current Limitations

1. **Summarization is truncation-based.** No LLM call for intelligent summarization -- just string slicing at `maxTokens * 4` characters. This is functional but not as smart as the paper's approach.

2. **No concurrent write safety.** Multiple sub-agents writing to the same key could race. In practice, each sub-agent writes to its own `sub-result-{id}` key, avoiding conflicts.

3. **No lazy loading.** Unlike the Google ADK extension, variables are eagerly loaded into memory on `init()`. Large datasets could be expensive.

4. **Stream type unused.** The `stream` variable type is defined but never used in the current implementation.

### Planned Improvements

1. **LLM-powered summarization** -- Use a quick sub-agent call for `summarize()` to produce intelligent summaries instead of truncation
2. **Lazy file loading** -- Load variable values on first `get()` instead of at `init()` time (inspired by Google ADK)
3. **Write coordination** -- Advisory locking or CAS (compare-and-swap) for variables that multiple agents might update
