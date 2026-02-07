# Recursive Language Model (RLM) - Specification Overview

## Vision

Build a TypeScript framework that implements the Recursive Language Model paradigm: an intelligent system where LLMs are hooked directly to a REPL environment, context is managed as passable variables, sub-LLMs can be spawned recursively, and the human user becomes just another callable function within the system.

This is NOT a chatbot. This is a programming language come alive - a system that writes programs, spawns more of itself, and merges back knowing the answers, all while keeping context windows clean.

## Architecture

```
                    +-----------------------+
                    |     RLM Runtime       |
                    |  (Orchestrator/REPL)  |
                    +-----------+-----------+
                                |
              +-----------------+-----------------+
              |                 |                 |
     +--------v------+  +------v--------+  +-----v-------+
     | Context Store |  | Agent Spawner |  | Function    |
     | (Variables)   |  | (Recursive)   |  | Registry    |
     +--------+------+  +------+--------+  +-----+-------+
              |                 |                 |
              |         +-------v-------+         |
              |         | Sub-Agent     |         |
              |         | {prompt, ctx} |         |
              |         +-------+-------+         |
              |                 |                 |
              +--------+--------+---------+-------+
                       |                  |
              +--------v------+   +-------v-------+
              | LLM Provider  |   | User Function |
              | (Anthropic)   |   | (I/O Bridge)  |
              +--------------+   +---------------+
```

## Specification Domains

| Spec File | Domain | Description |
|-----------|--------|-------------|
| [context-store.md](specs/context-store.md) | Context Store | Variable storage, passing by reference, memory management |
| [agent-runtime.md](specs/agent-runtime.md) | Agent Runtime | REPL loop, LLM integration, tool execution |
| [recursive-spawner.md](specs/recursive-spawner.md) | Recursive Spawner | Sub-agent creation, fan-out/fan-in, merge strategies |
| [function-registry.md](specs/function-registry.md) | Function Registry | User-as-function, tool functions, sub-LLM functions |
| [memory-manager.md](specs/memory-manager.md) | Memory Manager | Long-term memory, context offloading, infinite context |
| [cli.md](specs/cli.md) | CLI Interface | Command-line interface, interactive REPL, config |

## Success Criteria

1. Process 1M+ tokens across recursive sub-agents without context degradation
2. Sub-agents pass variables by reference (not by value) to avoid context pollution
3. Human user callable as a function with structured I/O
4. Recursive spawning with automatic merge-back of results
5. Long-term memory persisted and operable by the agent
6. Full test coverage with benchmarks proving context efficiency
7. Clean CLI that demonstrates the paradigm shift from chat to system

## Technology Stack

- **Runtime**: Node.js / Bun
- **Language**: TypeScript (strict mode)
- **LLM**: Anthropic Claude API (claude-sonnet-4-5-20250929)
- **Testing**: Vitest
- **Build**: tsup or esbuild
- **Package Manager**: bun
