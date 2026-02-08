# RLM - Backlog

Long-term roadmap items. These are not urgent but would make RLM more capable and production-ready. Items graduate to TODO.md when they become priorities.

---

## Architecture

- [x] **Event-based concurrency control** - Replaced the busy-wait `waitForSlot()` with a promise queue. When a slot frees in the `finally` block of `spawn()`, the next queued promise resolves. Eliminates 100ms polling overhead. (Done: Session 2, Phase 2.2)
- [ ] **Circuit breaker for sub-agents** - Track failure rates per depth level or task type. After N consecutive failures, stop spawning and surface the error to the parent. Prevents cascading cost when Claude CLI is down or misbehaving.
- [ ] **Streaming results** - `VariableType` includes `'stream'` but nothing implements streaming. Consider supporting streamed output from `claude -p` (if Claude CLI supports it) for long-running sub-agents.
- [ ] **Agent lifecycle hooks** - Add `onBeforeSpawn`, `onAfterComplete`, `onError` hooks to RecursiveSpawner so callers can inject logging, metrics, or side effects without modifying core code.
- [ ] **DAG execution** - Currently fan-out is flat (spawnMany runs N agents in parallel). Support directed acyclic graph execution where agent B depends on agent A's output, while agent C runs in parallel.

## Features

- [x] **Token budget enforcement** - `RLMConfig.tokenBudget` is now checked before each spawn. Cumulative token usage tracked across all sub-agents. Budget exhaustion throws a descriptive error. (Done: Session 2, Phase 4.4)
- [ ] **Built-in functions** - Register common utilities in FunctionRegistry by default: file read/write, directory listing, web fetch, JSON transform, text search. Sub-agents could invoke these via structured output patterns.
- [ ] **User-as-function** - The spec describes the human user as a callable function. Implement a `UserFunction` that pauses execution, prompts the user in the terminal, and returns their response. Only meaningful for the interactive parent session, not headless sub-agents.
- [ ] **CLI subcommands** - Add `rlm status` (show active agents, memory usage, token consumption) and `rlm config` (view/edit RLMConfig defaults). Currently only `run` and `--help` exist.
- [ ] **Context file formats** - Support loading `.csv`, `.yaml`, `.xml` context files in addition to plain text. Parse and store structured data in ContextStore with appropriate types.
- [ ] **Agent templates** - Pre-defined SpawnConfig templates for common patterns: "analyze and summarize", "extract entities", "compare documents", "code review". Reduce boilerplate for common orchestration tasks.
- [ ] **Progress reporting** - Emit progress events during long-running fan-out operations so callers can show status bars or percentage completion.
- [ ] **Smarter chunking for decompose()** - Current `decompose()` uses naive character-based splitting. Implement sentence-boundary, paragraph-break, or semantic-unit splitting strategies for better sub-agent results.

## Quality

- [x] **Add CLI tests** - Created `tests/cli.test.ts` covering `getDefaultConfig()`, `--help`, `-h`, run without task, no args, and `createSystem()`. (Done: Session 2, Phase 3.3)
- [x] **Fix all silent catch blocks** - Added logging to critical catch blocks (`buildPrompt()`, `loadPersistedVariables()`, RecursiveSpawner context persistence). Acceptable silences documented with comments. (Done: Session 2, Phase 2.4)
- [ ] **Increase test coverage for error paths** - Most tests cover happy paths. Add tests for: provider timeout, provider crash, corrupt disk files, concurrent access to ContextStore, memory manager disk I/O failures.
- [ ] **Add integration test with mock Claude CLI** - Create a shell script or binary stub that mimics `claude -p` JSON output. Use it to test the full pipeline (CLI -> AgentRuntime -> ClaudeCodeProvider -> mock) without incurring API costs. Would also enable testing manifest-based context passing end-to-end.
- [ ] **Test decompose() method** - The `decompose()` method needs dedicated test coverage in `tests/recursive-spawner.test.ts`.
- [ ] **Test token budget enforcement** - Budget enforcement needs tests verifying the spawn-rejection behavior when budget is exhausted.
- [ ] **Benchmark regression tests** - Capture baseline benchmark numbers and fail CI if performance regresses beyond a threshold (e.g., ref creation > 10us, merge > 5ms).
- [ ] **Lint and format enforcement** - Add ESLint with strict TypeScript rules and Prettier. Enforce in CI. Currently only `bun run lint` does `tsc --noEmit`.

## Documentation

- [x] **Update SPECS.md to match implementation** - Specs rewritten in Session 1. Six spec files rewritten, new `specs/ARCHITECTURE.md` created documenting the current spawn-and-wait + Claude Code CLI architecture. (Done: Session 1)
- [ ] **Architecture decision records** - Document why the REPL loop was dropped in favor of spawn-and-wait, why Anthropic API was replaced with Claude Code CLI, and why token tracking was deprioritized.
- [ ] **API documentation** - The README covers basics but lacks detailed API docs for programmatic use. Document all public classes, methods, options, and return types.
- [ ] **Usage examples** - Add example scripts in an `examples/` directory showing: basic task execution, fan-out/fan-in, memory persistence across sessions, custom merge functions, context file loading.

## Infrastructure

- [ ] **CI pipeline** - Set up GitHub Actions: build, lint, test on every push. Bun-based CI is straightforward.
- [ ] **npm/JSR publishing** - Package for distribution. Update `package.json` with proper exports, types, and bin entries. The `tsup` build already targets `dist/`.
- [ ] **Docker container** - Provide a Dockerfile that bundles bun + Claude CLI for self-contained deployment.
- [ ] **Configurable logging** - Replace scattered `console.log` / `process.stderr.write` with a minimal logger that supports levels (debug, info, warn, error) and can be silenced or redirected.

## Performance

- [ ] **Context compaction** - When a parent agent accumulates many VariableRefs, automatically summarize older ones to keep context window usage bounded. This is the "infinite context" promise in the specs.
- [ ] **Parallel disk I/O** - `ContextStore.clear()` deletes files sequentially in a loop. Use `Promise.all` for parallel unlink. Same for `loadPersistedVariables`.
- [ ] **Connection pooling for claude processes** - If the same model is used repeatedly, consider reusing session state or pre-warming processes (if Claude CLI supports it) to reduce cold-start latency.
- [ ] **Memory-mapped large variables** - For variables exceeding a size threshold, use memory-mapped file I/O instead of loading full JSON into Node.js heap.
