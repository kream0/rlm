# RLM - TODO

## Quick Resume

**Last session**: Session 2 - Full Implementation of Phases 1-4 (see LAST_SESSION.md)
**Current state**: All P0, P1, P2, and paper-inspired items from PLAN.md are complete. 8 test files, 137 tests passing, TypeScript clean.
**Next step**: Testing tasks below (decompose, token budget, mock CLI), then P3 improvements and Backlog items.

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

## Next Session - Testing (Priority)

- [ ] **Test decompose() method** - Add dedicated tests in `tests/recursive-spawner.test.ts`: basic chunking, merge strategy application, edge cases (empty input, single chunk, chunk count > input length).
- [ ] **Test token budget enforcement** - Add tests verifying: spawn rejection when budget exhausted, cumulative tracking across multiple spawns, budget reset behavior, interaction with `getTotalTokensUsed()`.
- [ ] **Test manifest-based context passing** - Verify `createContextManifest()` creates valid JSON, manifest file contains correct paths/sizes/types, prompt contains manifest reference.
- [ ] **Test memory integration** - Verify episodic memory records agent completions/failures, relevant memories appear in prompts, memory search failures are non-fatal.
- [ ] **Test function registry integration** - Verify function descriptions appear in agent prompts, empty registry adds nothing to prompt.
- [ ] **Integration test with mock Claude CLI** - Create a shell script stub that mimics `claude -p` JSON output for end-to-end pipeline testing without API costs.

## Future - Improvements

- [ ] **Structured prompt template (PLAN.md 4.2)** - Refactor `buildPrompt()` to use `##`-headed sections (Task, Role, Context, Relevant History, Available Functions) instead of ad-hoc string concatenation.
- [ ] **Smarter chunking for decompose()** - Implement sentence-boundary, paragraph-break, or semantic-unit splitting strategies.
- [ ] **Improve error messages** - Include full stderr in `ClaudeCodeProvider.execClaude()` failure errors.
- [ ] **Add scope enforcement** - Enforce `VariableRef.scope` in `ContextStore.get()` and `ContextStore.set()`.
- [ ] **Add graceful shutdown** - Signal handling (SIGINT/SIGTERM) that propagates to active child processes.
