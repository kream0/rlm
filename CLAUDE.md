# RLM - Recursive Language Model

## Project Overview
TypeScript framework where Claude Code sub-agents run as headless `claude -p` processes with recursive spawning, pass-by-reference context variables, and fan-out/fan-in orchestration. Designed to be used inside an interactive Claude Code session.

## Architecture
```
Human terminal -> claude (interactive session)
  |
Claude Code imports RLM as library
  |-- ContextStore (persists variables to disk as JSON)
  |-- MemoryManager (cross-session knowledge)
  +-- RecursiveSpawner (fan-out/fan-in orchestrator)
       | spawns
       claude -p "task..." --output-format json --no-session-persistence
       | results merge back via VariableRefs
```

Key design: AgentRuntime does not drive a REPL loop. Claude Code sub-processes handle their own tool loops internally. AgentRuntime is spawn-and-wait: one `provider.execute()` call per sub-agent.

### Modules
- **Context Store** (`src/context-store.ts`) - Variable storage with pass-by-reference
- **Agent Runtime** (`src/agent-runtime.ts`) - Spawn-and-wait agent execution
- **Recursive Spawner** (`src/recursive-spawner.ts`) - Sub-agent fan-out/fan-in with merge strategies
- **Function Registry** (`src/function-registry.ts`) - Custom callback registration
- **Memory Manager** (`src/memory-manager.ts`) - Four-layer memory (working, episodic, semantic, procedural)
- **CLI** (`src/cli.ts`) - CLI `run` command and programmatic API
- **Provider** (`src/claude-code-provider.ts`) - Claude Code CLI provider (`claude -p` subprocess)

## Tech Stack
- TypeScript (strict mode), Node.js
- Claude Code CLI (`claude -p`) as LLM provider
- Vitest for testing, tsup for building
- Zero external dependencies

## Commands
- `bun run build` - Build the project
- `bun run test` - Run all tests (uses vitest)
- Do NOT use `bun test` directly -- it uses Bun's native runner which lacks vi.mock support
- `bun run lint` - Type check
- `bun run dev -- run "<task>"` - Run a task via CLI
- `bun run demo` - Run feature demonstration
- `bun run benchmark` - Run performance benchmarks

## Code Rules
- DO NOT use placeholder implementations. Every function must be fully implemented
- Write tests for every module in tests/ directory
- Use strict TypeScript - no `any` types except where truly necessary
- Keep modules focused: one file per domain
- All async operations must handle errors properly
- No external dependencies - Claude Code CLI is the only LLM backend
- Variables pass by REFERENCE (VariableRef), never by copying full values to sub-agents
- The context store is the source of truth for all shared state
- Sub-agents are headless `claude -p` processes - no user interaction from sub-agents
- LLMProvider interface uses `execute()` returning `ExecutionResult` (not multi-turn chat)
- Use dependency injection over module-level mocking (e.g., `spawnFn` option instead of `vi.mock`)
- Never swallow errors silently - log via `onLog` callback or `process.stderr.write`

## Session Workflow
- Use Opus agents for research/analysis/implementation to protect main context window
- Launch independent agents in parallel for maximum throughput
- Track progress in TODO.md (priorities), LAST_SESSION.md (history), BACKLOG.md (roadmap)
- Run `bun run test` and `bun run lint` after every implementation phase
- Update tracking files at end of session

## Key Files
- `PLAN.md` - Detailed implementation plan (completed phases 1-4)
- `TODO.md` - Current priorities with Quick Resume section
- `LAST_SESSION.md` - Session history log
- `BACKLOG.md` - Long-term roadmap by theme
- `specs/ARCHITECTURE.md` - Architecture documentation with paper comparison
- `specs/rlm-adk-google.md` - Google ADK RLM discussion (reference)
- `specs/2512.24601v2.pdf` - Original RLM paper by Zhang et al. (MIT)
