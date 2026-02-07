# Memory Manager Specification

## Purpose

The Memory Manager provides "infinite context" by offloading long-term memory to variables and enabling agents to operate over their own memories. An ongoing conversation's history is stored as a variable that the agent can read, summarize, search, and extend - making the effective context window unlimited.

## Requirements

### Memory Types

1. **Working Memory** - Current iteration's observations, tool results, thoughts
   - Lives in the LLM context window
   - Managed by the agent runtime (compacted when too large)

2. **Episodic Memory** - History of past iterations and conversations
   - Stored as a context store variable
   - Agent can search, summarize, and reference it
   - Appended to after each iteration

3. **Semantic Memory** - Learned facts, patterns, and knowledge
   - Extracted from episodic memory by the agent itself
   - Structured as key-value knowledge entries
   - Persists across sessions

4. **Procedural Memory** - Learned procedures and strategies
   - "When X happens, do Y" rules
   - Stored as executable patterns
   - Agent can add new procedures based on experience

### Memory Operations

```typescript
// Append to episodic memory
await memory.append('episodic', {
  iteration: 42,
  action: 'analyzed dataset',
  result: 'found 3 anomalies',
  timestamp: Date.now()
});

// Search episodic memory
const relevant = await memory.search('episodic', 'anomaly detection');

// Extract knowledge
await memory.learn({
  key: 'dataset-patterns',
  value: 'Anomalies cluster around timestamps ending in :00'
});

// Recall knowledge
const knowledge = await memory.recall('dataset-patterns');

// Compact memory (summarize old entries)
await memory.compact('episodic', { keepLast: 10, summarizeOlder: true });
```

### Context Window Management

The memory manager prevents context rot by:
1. **Rolling window**: Only last N iterations in working memory
2. **Smart compaction**: Summarize older entries, preserve key facts
3. **Lazy loading**: Only load memories relevant to current task
4. **Offloading**: Move large results to context store, keep only refs

### Self-Operation

The agent can operate over its own memories:
```
Agent: "I need to recall what I learned about the dataset format"
  -> memory.search('semantic', 'dataset format')
  -> Returns relevant knowledge entries
  -> Agent incorporates into current thinking

Agent: "Let me review my last 5 actions to see if I'm making progress"
  -> memory.search('episodic', { last: 5 })
  -> Agent self-evaluates and adjusts strategy
```

### Persistence

- Working memory: In-memory only (lost on agent termination)
- Episodic memory: File-backed (persists per session)
- Semantic memory: File-backed (persists across sessions)
- Procedural memory: File-backed (persists across sessions)

## Interface

```typescript
interface MemoryManager {
  append(type: MemoryType, entry: MemoryEntry): Promise<void>;
  search(type: MemoryType, query: string, limit?: number): Promise<MemoryEntry[]>;
  learn(knowledge: KnowledgeEntry): Promise<void>;
  recall(key: string): Promise<KnowledgeEntry | null>;
  compact(type: MemoryType, opts?: CompactOptions): Promise<void>;
  getStats(): MemoryStats;
}

interface MemoryStats {
  workingMemoryTokens: number;
  episodicEntryCount: number;
  semanticEntryCount: number;
  proceduralRuleCount: number;
  totalStorageBytes: number;
}

type MemoryType = 'working' | 'episodic' | 'semantic' | 'procedural';
```

## Performance

- Memory search: < 100ms (uses simple text matching, not vector DB)
- Memory append: < 10ms
- Memory compact: < 5s (involves LLM summarization call)
- Storage: JSON files on disk, no external dependencies
