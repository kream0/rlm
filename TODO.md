# RLM - TODO

## Quick Resume

**Last session**: Session 4 - DevSession: Autonomous Dev Tool (see LAST_SESSION.md)
**Current state**: DevSession implemented. 10 test files, 254 tests passing, TypeScript clean. `rlm dev` command available globally.
**Next step**: Manual test against a real project, then Backlog items.

---

## P0 - Fix What's Broken

- [x] **Fix failing context-store delete test** - Rewrote assertion to use `await` + `expect(result).toBeUndefined()` for vitest/Bun compatibility. (Session 2, Phase 1.1)
- [x] **Fix failing integration test** - Resolved via claude-code-provider test refactor (dependency injection replaced `vi.mock`). (Session 2, Phase 1.2)
- [x] **Wire up token tracking** - `modelUsage` and `usage` fields now parsed from Claude CLI JSON output. Token usage propagated from `ExecutionResult` through `AgentRuntime.run()` to `Agent.tokenUsage`. `getTotalTokenUsage()` returns real values. (Session 2, Phase 1.3)

## P1 - Correctness and Robustness

- [x] **Remove duplicate result storage** - AgentRuntime no longer stores results; only RecursiveSpawner stores under `sub-result-{id}`. (Session 2, Phase 2.1)
- [x] **Replace busy-wait polling in waitForSlot()** - Promise queue replaces `while` loop + `setTimeout(100ms)`. Slot release in `finally` block resolves next queued promise. (Session 2, Phase 2.2)
- [x] **Apply SpawnConfig.timeout** - `Promise.race` wraps `runtime.run()` when `timeout` is set. Timed-out agents treated as failed with descriptive error. (Session 2, Phase 2.3)
- [x] **Fix silent catch blocks** - Added logging to `buildPrompt()` context ref failures, `loadPersistedVariables()` corrupt files, and RecursiveSpawner context persistence errors. Acceptable silent catches documented. (Session 2, Phase 2.4)

## P2 - Connect Disconnected Modules

- [x] **Integrate FunctionRegistry into agent lifecycle** - Function descriptions injected into agent prompts via `buildPrompt()`. Wired up in `cli.ts`. (Session 2, Phase 3.2)
- [x] **Integrate MemoryManager into agent lifecycle** - Episodic logging on agent completion/failure. Relevant memories injected into prompts. Wired up in `cli.ts`. (Session 2, Phase 3.1)
- [x] **Add CLI tests** - Created `tests/cli.test.ts` covering `getDefaultConfig()`, `--help`, `-h`, `run` without task, no args, and `createSystem()`. (Session 2, Phase 3.3)

## Completed (Session 2)

- [x] Constant-size metadata passing via manifest files (Phase 4.1)
- [x] Context decomposition helper - `decompose()` method (Phase 4.3)
- [x] Token budget propagation and enforcement (Phase 4.4)
- [x] MemoryManager + FunctionRegistry integration (Phase 3.1, 3.2)
- [x] CLI tests (Phase 3.3)
- [x] All P0 and P1 items (Phases 1-2)

## Completed (Session 3) - Testing

- [x] **Test decompose() method** - 20 tests: chunking, merge strategies, edge cases, error handling, result integrity. (Session 3)
- [x] **Test token budget enforcement** - 7 tests: rejection, cumulative tracking, reset, boundary, spawnMany. (Session 3)
- [x] **Test manifest-based context passing** - 7 tests: valid JSON, paths/sizes/types, prompt ref, empty store, multi-var. (Session 3)
- [x] **Test memory integration** - 10 tests: episodic logging, prompt injection, failure resilience, truncation. (Session 3)
- [x] **Test function registry integration** - 4 tests: prompt injection, multiple fns, empty registry, no registry. (Session 3)
- [x] **Integration test with mock Claude CLI** - 30 tests + `mock-claude.sh` stub: full pipeline, fan-out, decompose, budget, concurrency. (Session 3)

## Completed (Session 4) - DevSession

- [x] **ClaudeCodeProvider cwd/addDirs** - Added `cwd` and `addDirs` to provider options and execute params. (Session 4, Phase 1)
- [x] **DevSession types** - `ParsedTask`, `TaskReport`, `DevSessionReport`, `DevSessionOptions`, `OnFailureMode`. (Session 4, Phase 2)
- [x] **DevSession module** - `parseTodoMd()`, `buildDevPrompt()`, `DevSession` class with sequential execution, failure modes, LAST_SESSION.md update. (Session 4, Phase 3)
- [x] **CLI dev subcommand** - `rlm dev --project-dir <dir>` with `--task`, `--on-failure` flags. (Session 4, Phase 4)
- [x] **Claude Code skill** - `~/.claude/skills/rlm/SKILL.md` for `/rlm` invocation. (Session 4, Phase 5)
- [x] **DevSession exports** - Exported from `src/index.ts`. (Session 4, Phase 6)
- [x] **DevSession tests** - 30 new tests + 6 provider tests. (Session 4, Phase 7)

## Future - Improvements

- [ ] **Structured prompt template (PLAN.md 4.2)** - Refactor `buildPrompt()` to use `##`-headed sections (Task, Role, Context, Relevant History, Available Functions) instead of ad-hoc string concatenation.
- [ ] **Smarter chunking for decompose()** - Implement sentence-boundary, paragraph-break, or semantic-unit splitting strategies.
- [ ] **Improve error messages** - Include full stderr in `ClaudeCodeProvider.execClaude()` failure errors.
- [ ] **Add scope enforcement** - Enforce `VariableRef.scope` in `ContextStore.get()` and `ContextStore.set()`.
- [ ] **Add graceful shutdown** - Signal handling (SIGINT/SIGTERM) that propagates to active child processes.
