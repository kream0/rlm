# CLI Specification

## Purpose

The CLI is the entry point to the RLM system. It provides both an interactive REPL mode and a programmatic mode for launching agents with specific tasks. It demonstrates the paradigm shift: the user is not chatting with an AI, they are invoking a recursive computational system.

## Requirements

### Commands

```bash
# Start interactive REPL
rlm

# Run a task directly
rlm run "Analyze this codebase and generate a report"

# Run with a context file
rlm run "Summarize this document" --context ./large-doc.txt

# Run with multiple context files
rlm run "Compare these" --context ./doc1.txt --context ./doc2.txt

# Watch the agent tree in real-time
rlm status

# Configure
rlm config set model claude-sonnet-4-5-20250929
rlm config set max-depth 5
rlm config set max-concurrent 3
```

### Interactive REPL Mode

When started without arguments, RLM enters an interactive mode:
```
$ rlm
RLM v1.0.0 - Recursive Language Model
Type a task or command. You are a function in this system.

rlm> Analyze the files in ./data and find patterns
[Agent spawned: agent-001]
[Sub-agent spawned: agent-002 (analyzing file1.csv)]
[Sub-agent spawned: agent-003 (analyzing file2.csv)]
[Sub-agent completed: agent-002 -> found 3 patterns]
[Sub-agent completed: agent-003 -> found 5 patterns]
[Merging results...]
[Agent completed: agent-001]

Result: Found 8 unique patterns across 2 files...

rlm> Store that as "analysis-results"
[Stored: analysis-results (2.3KB)]

rlm> Now use those results to generate a report
[Agent spawned: agent-004]
[Context: analysis-results (ref, not loaded)]
...
```

### Status Display

Real-time view of the agent tree:
```
Agent Tree:
  agent-001 [running] (iter: 5, tokens: 12k/200k)
    |- agent-002 [completed] (iter: 3, tokens: 8k, result: ref:r-002)
    |- agent-003 [running] (iter: 2, tokens: 5k/200k)
    |- agent-004 [pending]

Variables:
  dataset-2024    text   500KB  global
  analysis-001    json   2.3KB  agent:001
  sub-result-002  json   1.1KB  agent:002

Token Budget: 45k / 1M total
```

### Configuration

```typescript
interface RLMConfig {
  model: string;           // Default LLM model
  apiKey: string;          // Anthropic API key (from env)
  maxDepth: number;        // Max recursion depth
  maxConcurrent: number;   // Max concurrent sub-agents
  maxIterations: number;   // Max iterations per agent
  tokenBudget: number;     // Total token budget
  storageDir: string;      // Where to persist variables/memories
  verbose: boolean;        // Detailed logging
}
```

### Exit Codes

- `0` - Task completed successfully
- `1` - Task failed
- `2` - Token budget exceeded
- `3` - Max iterations exceeded
- `130` - User interrupted (Ctrl+C)

## Interface

```typescript
// CLI entry point
async function main(args: string[]): Promise<number>;

// REPL mode
async function startREPL(config: RLMConfig): Promise<void>;

// Programmatic API (for importing as library)
async function run(task: string, options?: RunOptions): Promise<AgentResult>;
```
