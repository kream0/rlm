# RLM - Recursive Language Model

## Project Overview
TypeScript implementation of the Recursive Language Model paradigm. LLMs hooked directly to a REPL with recursive sub-agent spawning, pass-by-reference context variables, and user-as-function.

## Architecture
Read SPECS.md for full specifications. Key domains:
- **Context Store** (specs/context-store.md) - Variable storage with pass-by-reference
- **Agent Runtime** (specs/agent-runtime.md) - REPL loop with LLM integration
- **Recursive Spawner** (specs/recursive-spawner.md) - Sub-agent fan-out/fan-in
- **Function Registry** (specs/function-registry.md) - User-as-function, tools
- **Memory Manager** (specs/memory-manager.md) - Infinite context via memory offloading
- **CLI** (specs/cli.md) - Interactive REPL and programmatic API

## Tech Stack
- TypeScript (strict mode), Node.js/Bun
- Anthropic Claude API (@anthropic-ai/sdk)
- Vitest for testing, tsup for building

## Commands
- `npm run build` - Build the project
- `npm test` - Run all tests
- `npm run lint` - Type check
- `npm run dev` - Run CLI in dev mode
- `npm run demo` - Run demo

## Code Rules
- DO NOT use placeholder implementations. Every function must be fully implemented
- Write tests for every module in tests/ directory
- Use strict TypeScript - no `any` types except where truly necessary
- Keep modules focused: one file per spec domain
- All async operations must handle errors properly
- No external dependencies beyond @anthropic-ai/sdk
- Use the Anthropic SDK's built-in streaming and tool use
- Variables pass by REFERENCE (VariableRef), never by copying full values to sub-agents
- The context store is the source of truth for all shared state
