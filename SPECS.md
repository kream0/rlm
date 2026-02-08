# Recursive Language Model (RLM) - Specification Overview

## Vision

A TypeScript framework that implements the Recursive Language Model paradigm: an orchestration system where Claude Code sub-agents run as headless `claude -p` processes, context is managed as pass-by-reference variables, and sub-agents can be spawned recursively with fan-out/fan-in merge-back. Designed to be used as a library imported inside an interactive Claude Code session.

This is NOT a chatbot. This is NOT a REPL loop. This is a **spawn-and-wait orchestrator** -- a system that decomposes tasks, spawns sub-agents as independent CLI processes, and merges results back through a shared context store, all while keeping each agent's context window clean.

## Relationship to the RLM Paper

This project is inspired by the RLM paper (arXiv 2512.24601v2) by Alex Zhang et al. at MIT. The paper describes an inference paradigm where prompts are stored in an external REPL environment and the LLM gets only constant-size metadata about the prompt. Our implementation adapts these ideas to a practical framework using Claude Code CLI as the execution substrate.

### Where We Align with the Paper

| Paper Concept | Our Implementation |
|---|---|
| Variables as symbolic handles, not inline data | `VariableRef` (~150 bytes) passed instead of full values |
| Output through environment, not autoregression | Results stored in `ContextStore` on disk, referenced by key |
| Sub-RLM calls for recursive decomposition | `RecursiveSpawner.spawn()` / `spawnMany()` creating `claude -p` sub-processes |
| Context decomposition (split + delegate) | `spawnMany()` with fan-out, `merge()` with fan-in |
| Task decomposition (delegate subtasks) | Each `SpawnConfig` can have a different prompt/task |

### Where We Differ from the Paper

| Paper Concept | Our Approach | Rationale |
|---|---|---|
| Persistent REPL with code execution | Spawn-and-wait (one `execute()` call per agent) | Claude Code handles its own tool loops internally |
| `llm_query()` function inside REPL | `claude -p` subprocess via `ClaudeCodeProvider` | Leverages Claude Code's built-in tool execution |
| Pre-loaded Python libraries (json, re, numpy) | Claude Code's native tools (bash, file I/O, etc.) | Claude Code sub-agents have full tool access |
| Single `context` string variable | Multiple typed `VariableRef` entries in `ContextStore` | Richer context model with scoping and persistence |
| Sequential sub-agent execution | Configurable parallelism (`maxConcurrent`) | Practical performance requirement |

### Concepts from Google ADK Re-implementation

The Google ADK team (Liam Connell) re-implemented RLM using ADK's `BaseAgent`. Their extensions that inform our roadmap:

| ADK Extension | Our Status |
|---|---|
| Lazy file loading (local + GCS) | **Partial** -- context files loaded on CLI invocation, disk spill for large vars |
| Parallelism with configurable concurrency | **Implemented** -- `maxConcurrent` in `RecursiveSpawner` |
| Real-time UI visualization | **Not implemented** -- agent tree available via `getTree()` but no UI |
| OOLONG-Pairs benchmark | **Not implemented** -- we have a basic benchmark suite |

## Architecture

```
Human terminal -> claude (interactive session)
  |
Claude Code imports RLM as library
  |-- ContextStore (persists variables to disk as JSON)
  |-- MemoryManager (four-layer memory, file-backed)
  |-- FunctionRegistry (custom callback registration)
  +-- RecursiveSpawner (fan-out/fan-in orchestrator)
       | uses AgentRuntime
       | which calls ClaudeCodeProvider
       | spawns
       claude -p "task..." --output-format json --no-session-persistence
       | results stored in ContextStore
       | result VariableRefs returned to caller
```

Key design: **AgentRuntime does not drive a REPL loop.** Claude Code sub-processes handle their own tool loops internally. AgentRuntime is spawn-and-wait: one `provider.execute()` call per sub-agent. The sub-agent runs, does its work (including any tool use it needs), and returns a single result.

## Specification Domains

| Spec File | Domain | Status | Description |
|-----------|--------|--------|-------------|
| [ARCHITECTURE.md](specs/ARCHITECTURE.md) | Architecture | Implemented | System architecture, data flow, process model |
| [context-store.md](specs/context-store.md) | Context Store | Implemented | Variable storage, pass-by-reference, disk persistence |
| [agent-runtime.md](specs/agent-runtime.md) | Agent Runtime | Implemented | Spawn-and-wait agent execution via Claude Code CLI |
| [recursive-spawner.md](specs/recursive-spawner.md) | Recursive Spawner | Implemented | Sub-agent fan-out/fan-in with 5 merge strategies |
| [function-registry.md](specs/function-registry.md) | Function Registry | Implemented (standalone) | Custom callback registration (not integrated into agent lifecycle) |
| [memory-manager.md](specs/memory-manager.md) | Memory Manager | Implemented (standalone) | Four-layer memory with file persistence (not integrated into agent lifecycle) |
| [cli.md](specs/cli.md) | CLI Interface | Implemented | `rlm run` command and programmatic `run()` API |
| [rlm-adk-google.md](specs/rlm-adk-google.md) | Reference | N/A | Notes on Google ADK's RLM re-implementation |

## Implementation Status Legend

- **Implemented** -- Feature is fully coded, tested, and usable
- **Implemented (standalone)** -- Module exists and works but is not wired into the main agent execution pipeline
- **Partial** -- Some aspects are implemented, others remain TODO
- **Planned** -- Specified but not yet implemented
- **Omitted** -- Intentionally not implemented (with rationale)

## Success Criteria

1. **[Achieved]** Sub-agents pass variables by reference (`VariableRef` ~150 bytes) to avoid context pollution
2. **[Achieved]** Recursive spawning with automatic merge-back of results (5 merge strategies)
3. **[Achieved]** Fan-out/fan-in orchestration with configurable concurrency and depth limits
4. **[Achieved]** Context store with disk persistence for cross-process variable sharing
5. **[Achieved]** Zero external dependencies -- Claude Code CLI is the only LLM backend
6. **[Partial]** Long-term memory persisted and operable by the agent (module exists, not integrated)
7. **[Partial]** Full test coverage with benchmarks proving context efficiency
8. **[Omitted]** Human user callable as a function -- Claude Code handles user interaction natively
9. **[Omitted]** Interactive REPL mode -- primary usage is as library import or `rlm run` command

## Technology Stack

- **Runtime**: Node.js / Bun
- **Language**: TypeScript (strict mode)
- **LLM Backend**: Claude Code CLI (`claude -p` subprocess with `--output-format json`)
- **Testing**: Vitest
- **Build**: tsup
- **Package Manager**: bun
- **External Dependencies**: None (zero `dependencies` in package.json)
