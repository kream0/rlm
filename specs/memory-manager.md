# Memory Manager Specification

**Status: Implemented (standalone)** | Source: `src/memory-manager.ts` | Tests: `tests/memory-manager.test.ts`

## Purpose

The Memory Manager provides a four-layer memory system (working, episodic, semantic, procedural) with file-backed persistence. It enables agents to accumulate knowledge across executions, search through past experiences, and maintain learned facts and procedures.

## Implementation Reality

The Memory Manager is fully implemented as a standalone module with all four memory layers, search, compaction, and file persistence. However, it is **not integrated into the agent execution lifecycle**. It is instantiated in `cli.ts` but never wired into `AgentRuntime` or `RecursiveSpawner`. Agents do not automatically record their actions or consult past memories.

To use the Memory Manager, a library consumer must interact with it directly:

```typescript
const { memory } = await createSystem(config);

// Manually record agent activity
await memory.append('episodic', {
  id: 'entry-1',
  timestamp: Date.now(),
  content: 'Agent analyzed security vulnerabilities in src/',
  metadata: { agentId: 'agent-001', task: 'security-scan' },
});

// Later, search for relevant past experience
const relevant = await memory.search('episodic', 'security vulnerabilities');
```

## Paper Alignment

| Paper Concept | Our Implementation | Notes |
|---|---|---|
| Context stored in REPL environment | Variables in ContextStore, memories in MemoryManager | Two separate systems |
| Agent manipulates its own context | Agent cannot access MemoryManager | Not integrated |
| Persistent state across sessions | File-backed episodic, semantic, procedural memory | Works, but manual |

The paper does not specifically address multi-layer memory. This module is our extension beyond the paper's design, inspired by cognitive architectures.

## Implemented Features

### Memory Types

| Layer | Storage | Persistence | Auto-Management |
|---|---|---|---|
| **Working** | In-memory array | Lost on process exit | Auto-trimmed at `maxWorkingEntries` (default 50) |
| **Episodic** | In-memory + disk | File-backed, survives restart | Manual compaction via `compact()` |
| **Semantic** | In-memory Map + disk | File-backed, survives restart | Key-value, no compaction needed |
| **Procedural** | In-memory array + disk | File-backed, survives restart | Manual compaction via `compact()` |

### Append

```typescript
await memory.append(type: MemoryType, entry: MemoryEntry): Promise<void>
```

Appends an entry to the specified memory layer. Auto-assigns `id` (UUID) and `timestamp` if not provided.

- **Working memory**: Appends to array, auto-trims to last `maxWorkingEntries` entries
- **Episodic memory**: Appends to array, saves to disk immediately
- **Semantic memory**: Extracts key from `metadata.key` or uses entry ID, stores as key-value pair
- **Procedural memory**: Extracts condition from `metadata.condition`, stores as `ProceduralRule`

### Search

```typescript
const results = await memory.search(type: MemoryType, query: string, limit?: number): Promise<MemoryEntry[]>
```

Searches memory using a relevance scoring algorithm:

1. Splits query into terms (whitespace-separated, case-insensitive)
2. For each entry, scores based on:
   - Exact substring matches in content + metadata (2 points per occurrence)
   - Partial matches where term appears within text (1 point)
   - Recency bonus: entries from the last 24 hours get up to 0.5 bonus points
3. Filters out zero-score entries
4. Sorts by score descending, returns top `limit` (default 10)

**Note:** This is simple text matching, not vector search. It works well for keyword-based queries but does not understand semantic similarity.

### Learn

```typescript
await memory.learn(knowledge: KnowledgeEntry): Promise<void>
```

Stores a key-value knowledge entry in semantic memory. If the key already exists, it is overwritten.

```typescript
interface KnowledgeEntry {
  key: string;       // e.g., 'dataset-format'
  value: string;     // e.g., 'CSV with headers, semicolon-delimited'
  timestamp?: number;
}
```

### Recall

```typescript
const entry = await memory.recall(key: string): Promise<KnowledgeEntry | null>
```

Retrieves a specific knowledge entry by key from semantic memory. Returns `null` if not found.

### Compact

```typescript
await memory.compact(type: MemoryType, opts?: CompactOptions): Promise<void>
```

Reduces memory size by summarizing older entries:

- **Working**: Keeps last `keepLast` entries, optionally summarizes older entries into one summary entry
- **Episodic**: Same as working, saves to disk after compaction
- **Semantic**: No-op (key-value store, already concise)
- **Procedural**: Keeps last `keepLast` rules only (no summarization)

**Note:** Summarization is done locally by concatenating truncated content, not by calling an LLM. The `createSummary()` method produces entries like:

```
[Summary of 15 entries]
- Agent analyzed file1.csv [task=analysis]
- Found 3 anomalies in section A [severity=high]
- ...
```

### Statistics

```typescript
const stats = memory.getStats(): MemoryStats
```

Returns:
```typescript
interface MemoryStats {
  workingMemoryTokens: number;   // Approximate (content length / 4)
  episodicEntryCount: number;
  semanticEntryCount: number;
  proceduralRuleCount: number;
  totalStorageBytes: number;     // Sum of all JSON-serialized layers
}
```

### Clear

```typescript
await memory.clear(type?: MemoryType): Promise<void>
```

Clears one or all memory layers. Clears disk files for persistent layers.

### Direct Access

```typescript
memory.getWorkingMemory(): MemoryEntry[]   // Copy of working memory entries
memory.getEpisodicMemory(): MemoryEntry[]  // Copy of episodic memory entries
```

## Initialization and Persistence

```typescript
const memory = new MemoryManager('/path/to/.rlm-data/memory', 50);
await memory.init();
```

On `init()`:
1. Creates the storage directory if it does not exist
2. Loads `episodic.json`, `semantic.json`, `procedural.json` from disk
3. Working memory starts empty (in-memory only)

Storage format:
```
.rlm-data/memory/
  episodic.json    -> MemoryEntry[]
  semantic.json    -> [string, KnowledgeEntry][]   (Map.entries() format)
  procedural.json  -> ProceduralRule[]
```

## Interface (Actual Implementation)

```typescript
interface IMemoryManager {
  append(type: MemoryType, entry: MemoryEntry): Promise<void>;
  search(type: MemoryType, query: string, limit?: number): Promise<MemoryEntry[]>;
  learn(knowledge: KnowledgeEntry): Promise<void>;
  recall(key: string): Promise<KnowledgeEntry | null>;
  compact(type: MemoryType, opts?: CompactOptions): Promise<void>;
  getStats(): MemoryStats;
  clear(type?: MemoryType): Promise<void>;
}

type MemoryType = 'working' | 'episodic' | 'semantic' | 'procedural';

interface MemoryEntry {
  id: string;
  timestamp: number;
  content: string;
  metadata?: Record<string, unknown>;
}

interface KnowledgeEntry {
  key: string;
  value: string;
  timestamp?: number;
}

interface ProceduralRule {
  condition: string;
  action: string;
  timestamp?: number;
}

interface CompactOptions {
  keepLast?: number;          // Default: 10
  summarizeOlder?: boolean;   // Default: true
}
```

## What Changed from the Original Spec

| Original Spec Feature | Current Status | Reason |
|---|---|---|
| LLM-powered compaction | **Uses local summarization** | No LLM call; concatenates truncated content |
| Agent self-operation over memories | **Not integrated** | MemoryManager not wired into agent lifecycle |
| Context window management (rolling window, offloading) | **Not integrated** | Claude Code manages its own context |
| Lazy loading of memories | **Not implemented** | All memories loaded eagerly on `init()` |

## Limitations and Future Work

### Current Limitations

1. **Not integrated into agent lifecycle.** Agents do not automatically record their work or consult past memories. The orchestrator must manually interact with MemoryManager.

2. **Local summarization only.** `compact()` produces concatenated summaries, not intelligent LLM-generated summaries.

3. **Simple text search.** No vector embeddings or semantic similarity. Search works by keyword matching only.

4. **Eager loading.** All memories loaded on `init()`. For large memory stores, this could be slow and memory-intensive.

5. **No cross-agent memory sharing.** Each RLM instance has its own MemoryManager. There is no mechanism for sub-agents to read or write the parent's memory.

### Planned Improvements

1. **AgentRuntime integration** -- Automatically append episodic entries when agents start, complete, or fail. Include the agent's prompt and result summary.
2. **Memory-augmented prompts** -- Before spawning a sub-agent, search relevant memories and include them in the prompt as context.
3. **LLM-powered compaction** -- Use a sub-agent to summarize older memories intelligently.
4. **Cross-session learning** -- Automatically extract semantic knowledge from episodic memory after task completion ("What did we learn?").
5. **Procedural rule application** -- Check procedural rules before agent execution and include relevant rules in the prompt.
