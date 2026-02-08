# Architecture Specification

## Overview

RLM is a **spawn-and-wait orchestration framework**, not a REPL loop. The key architectural insight is that Claude Code CLI (`claude -p`) already provides a complete agent with its own internal tool loop (bash, file I/O, code editing, etc.). RLM's job is to **orchestrate multiple Claude Code processes** with shared state, recursive decomposition, and result merging.

## Process Model

```
Process Boundary
=================================================================================

  Interactive Claude Code session (user's terminal)
  |
  | imports RLM as a TypeScript library
  |
  +-- RLM Orchestrator (in-process)
  |     |
  |     |-- ContextStore -----> .rlm-data/variables/*.json  (disk)
  |     |-- MemoryManager ----> .rlm-data/memory/*.json     (disk)
  |     |-- FunctionRegistry -> (in-memory callbacks)
  |     |
  |     +-- RecursiveSpawner
  |           |
  |           +-- AgentRuntime
  |                 |
  |                 +-- ClaudeCodeProvider.execute()
  |                       |
  =========================|=====================================================
  |                       |
  |   spawns child processes (one per sub-agent):
  |                       |
  |   claude -p "prompt" --output-format json --model opus --no-session-persistence
  |   claude -p "prompt" --output-format json --model opus --no-session-persistence
  |   claude -p "prompt" --output-format json --model opus --no-session-persistence
  |        |                    |                    |
  |    (internal tool loop) (internal tool loop) (internal tool loop)
  |        |                    |                    |
  |    JSON result           JSON result          JSON result
  |        |                    |                    |
  =========================|=====================================================
  |                       |
  |   Results flow back into ContextStore as VariableRefs
  |   Merge strategies combine results
  |   Final result returned to caller
```

## Data Flow

### 1. Task Submission

The user (or the interactive Claude Code session) calls RLM either via CLI or programmatic API:

```typescript
// Programmatic API (library import)
import { run } from 'rlm';
const result = await run("Analyze this codebase", { contextFiles: ['./src'] });

// CLI
// rlm run "Analyze this codebase" --context ./src
```

### 2. Context Preparation

Context files are loaded into the `ContextStore` and assigned `VariableRef` handles:

```
File (500KB) --> store.set("context-file-src", content)
                      |
                      v
                 VariableRef {
                   id: "uuid",
                   key: "context-file-src",
                   scope: "global",
                   type: "text",
                   sizeBytes: 512000,    <-- ~150 bytes total
                   createdAt: 1706...
                 }
```

The VariableRef is what gets passed to sub-agents -- never the full 500KB value.

### 3. Agent Execution (Spawn-and-Wait)

The `AgentRuntime.run()` method does NOT drive a REPL loop. It makes a single call:

```
AgentRuntime.run(agent)
  |
  +-- buildPrompt(agent)
  |     |-- agent.config.prompt (the task)
  |     +-- context summary (truncated preview from ContextStore.summarize())
  |
  +-- provider.execute({ prompt, model })
  |     |
  |     +-- spawn("claude", ["-p", prompt, "--output-format", "json", ...])
  |     |     |
  |     |     +-- Claude Code runs internally (may take many internal turns)
  |     |     +-- Claude Code handles its own tool calls (bash, files, etc.)
  |     |     +-- Process exits with JSON output
  |     |
  |     +-- Parse JSON response -> ExecutionResult { result, costUsd, durationMs, ... }
  |
  +-- store.set("agent-result-{id}", result) --> VariableRef
  |
  +-- return AgentResult { agentId, result, tokenUsage, children, ... }
```

**One `execute()` call = one sub-agent lifetime.** No iteration, no multi-turn management by RLM. Claude Code handles all that internally.

### 4. Recursive Spawning (Fan-Out)

The `RecursiveSpawner` can create multiple sub-agents:

```
RecursiveSpawner.spawnMany([config1, config2, config3])
  |
  |-- Check depth < maxDepth (default 5)
  |-- Check activeConcurrent < maxConcurrent (default 3)
  |
  +-- Promise.all([
        spawn(config1, parentId, depth)  --> claude -p "task 1" ...
        spawn(config2, parentId, depth)  --> claude -p "task 2" ...
        spawn(config3, parentId, depth)  --> claude -p "task 3" ...
      ])
  |
  +-- Returns [VariableRef1, VariableRef2, VariableRef3]
```

### 5. Result Merging (Fan-In)

Five merge strategies combine sub-agent results:

```
RecursiveSpawner.merge([ref1, ref2, ref3], { type: 'structured' })
  |
  +-- Resolve all refs from ContextStore
  |     ref1 -> store.resolve() -> value1
  |     ref2 -> store.resolve() -> value2
  |     ref3 -> store.resolve() -> value3
  |
  +-- Apply merge strategy:
  |     concatenate  -> "value1\n---\nvalue2\n---\nvalue3"
  |     structured   -> { "sub-result-id1": value1, "sub-result-id2": value2, ... }
  |     vote         -> { winner: mostCommon, votes: { ... } }
  |     summarize    -> "[Result 1]:\nvalue1\n\n[Result 2]:\nvalue2\n..."
  |     custom       -> customMergeFn([value1, value2, value3])
  |
  +-- store.set("merged-{uuid}", mergedResult) --> VariableRef
  |
  +-- Return merged VariableRef
```

## Module Dependency Graph

```
cli.ts
  |-- creates --> ClaudeCodeProvider
  |-- creates --> ContextStore
  |-- creates --> MemoryManager       (instantiated but not wired into agent lifecycle)
  |-- creates --> AgentRuntime
  |      |-- uses --> ClaudeCodeProvider (LLMProvider interface)
  |      +-- uses --> ContextStore      (stores results)
  |-- creates --> RecursiveSpawner
  |      |-- uses --> AgentRuntime      (to run sub-agents)
  |      +-- uses --> ContextStore      (to store/merge results)
  |
  +-- FunctionRegistry                 (standalone, not wired into agent lifecycle)
```

## Cross-Process Communication

Sub-agents are **independent OS processes** (`claude -p`). They share state ONLY through the filesystem:

| Mechanism | Direction | How |
|---|---|---|
| Task prompt | Parent -> Child | Prompt string passed via `-p` flag |
| Context variables | Parent -> Child | File paths embedded in prompt, variables persisted as JSON to disk |
| Results | Child -> Parent | JSON output captured from stdout, stored in ContextStore |
| Shared state | Bidirectional | ContextStore JSON files on disk (`.rlm-data/variables/`) |

Sub-agents do NOT share:
- Memory address space
- In-memory ContextStore state
- Session state (each uses `--no-session-persistence`)
- Claude Code conversation history

## Configuration

All configuration flows through `RLMConfig`:

```typescript
interface RLMConfig {
  model: string;              // Default model (default: 'claude-opus-4-6')
  maxDepth: number;           // Max recursion depth (default: 5)
  maxConcurrent: number;      // Max concurrent sub-agents (default: 3)
  tokenBudget: number;        // Total token budget (default: 1,000,000)
  storageDir: string;         // Data directory (default: '.rlm-data')
  verbose: boolean;           // Logging verbosity (default: false)
  claudeBinary?: string;      // Path to claude binary (default: 'claude')
  claudeMaxBudgetUsd?: number;  // Cost cap per sub-agent invocation
  claudeModel?: string;      // Model override for provider
  claudePermissionMode?: string; // Permission mode (default: 'acceptEdits')
}
```

## Storage Layout

```
.rlm-data/
  variables/                  # ContextStore persistence
    context-file-src.json     # { ref: VariableRef, value: ..., persist: true }
    agent-result-{uuid}.json
    sub-result-{uuid}.json
    merged-{uuid}.json
  memory/                     # MemoryManager persistence
    episodic.json             # Array of MemoryEntry
    semantic.json             # Array of [key, KnowledgeEntry] tuples
    procedural.json           # Array of ProceduralRule
```

## Comparison with Paper Architecture

### Paper's RLM Architecture

```
LLM <---> REPL Environment
             |-- context variable (string)
             |-- rlm_agent(query, context) function
             |-- Python libraries (json, re, numpy)
             |-- print() for output
             |
             LLM writes Python code
             REPL executes it
             LLM reads print output
             LOOP until done
```

### Our Architecture

```
Orchestrator (TypeScript)
  |-- ContextStore (multiple typed variables, disk-backed)
  |-- RecursiveSpawner (fan-out/fan-in with merge strategies)
  |
  spawns --> claude -p (headless sub-agent)
               |-- Claude Code's internal REPL
               |-- bash, file I/O, code editing
               |-- Runs autonomously until complete
               |-- Returns JSON result
```

**Key differences:**

1. **No orchestrator-level REPL.** The paper has the LLM writing code in a REPL that it controls. Our orchestrator is a simple spawn-and-wait. The "REPL" aspect is delegated to Claude Code's internal tool loop.

2. **Richer context model.** The paper uses a single `context` string variable. We use a typed `ContextStore` with multiple variables, scoping, disk persistence, and memory management.

3. **Process isolation.** The paper runs everything in one Python process. We spawn separate OS processes per sub-agent, sharing state only through the filesystem.

4. **Merge strategies.** The paper aggregates results by having the parent LLM read sub-results. We provide 5 programmatic merge strategies that operate without additional LLM calls (except `summarize`, which currently concatenates without an LLM call but could use one).

## Roadmap

### Near-term Improvements

1. **Memory Manager integration** -- Wire MemoryManager into AgentRuntime so agents automatically build episodic memory of their execution
2. **FunctionRegistry integration** -- Allow registered functions to be invoked by sub-agents via tool definitions in the prompt
3. **LLM-powered summarization** -- Use a sub-agent call for `ContextStore.summarize()` and the `summarize` merge strategy
4. **Streaming output** -- Pipe sub-agent stderr to parent for real-time progress

### Inspired by the Paper

5. **OOLONG-Pairs benchmark** -- Implement the quadratic reasoning benchmark from the paper to measure our system against the paper's results
6. **Context decomposition primitives** -- Higher-level API for splitting a large context into chunks and delegating to sub-agents (the paper's primary use case)
7. **Token budget propagation** -- Parent allocates token budgets to children, tracked across the recursion tree

### Inspired by Google ADK

8. **Lazy file loading** -- Load files on-demand rather than eagerly, supporting local filesystem and cloud storage
9. **Real-time UI** -- Web-based visualization of the agent tree with live event streaming
10. **Evaluation framework** -- Structured benchmarking with automated scoring
