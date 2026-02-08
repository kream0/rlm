# RLM Implementation Plan

Detailed, phase-by-phase implementation plan. Each change specifies files, functions, rationale, risk, and dependencies. Designed to be executed sequentially by an implementation agent.

---

## Phase 1: Fix What's Broken (P0)

### 1.1 Fix the context-store delete test

**Problem:** The test at `tests/context-store.test.ts` line 106-108 fails when run under `bun test` (Bun's native test runner). The assertion `await expect(store.delete('nonexistent')).resolves.not.toThrow()` triggers Bun's `.toThrow()` matcher incorrectly -- Bun interprets the resolved `undefined` value as a "thrown value: undefined". The test passes under `vitest run` (the configured test runner), so this is a Bun compatibility issue with the test assertion style.

**Root cause:** Bun's test runner does not support `vi.mock` (used in `claude-code-provider.test.ts`) and has subtly different semantics for `.resolves.not.toThrow()`. The project is configured to use `vitest run` (see `package.json` scripts and `vitest.config.ts`), but running `bun test` bypasses vitest and uses Bun's built-in runner.

**File(s) to modify:**
- `tests/context-store.test.ts` (line 106-108)

**What to change:** Rewrite the assertion to be compatible with both runners. Replace:
```typescript
it('should not throw when deleting non-existent key', async () => {
  await expect(store.delete('nonexistent')).resolves.not.toThrow();
});
```
With:
```typescript
it('should not throw when deleting non-existent key', async () => {
  // Verify delete resolves without error (compatible with both vitest and bun test)
  const result = await store.delete('nonexistent');
  expect(result).toBeUndefined();
});
```

**Why:** The original assertion style is problematic under Bun's runner. Awaiting the promise directly and checking it resolved to `undefined` tests the same behavior without relying on matcher chaining that varies between runners.

**Risk level:** Low -- pure test change, no production code affected.

**Dependencies:** None.

---

### 1.2 Fix `claude-code-provider.test.ts` under Bun

**Problem:** `tests/claude-code-provider.test.ts` uses `vi.mock('node:child_process', ...)` at the module level (line 7-9). Bun's test runner does not support `vi.mock` (it is a vitest-only API). This causes an "Unhandled error between tests" that counts as a separate failure in the test run.

**Root cause:** The project was switched from `npm` to `bun` (commit `9ac17ed`) but the test runner should still be `vitest run` (as configured in `package.json` `"test": "vitest run"`). Running `bun test` instead of `bun run test` uses Bun's built-in runner which lacks vitest's module mocking.

**Two-part fix:**

**Part A -- Document the correct test command:**

**File(s) to modify:** `CLAUDE.md` (project root)

**What to change:** In the Commands section, clarify:
```
- `bun run test` - Run all tests (uses vitest)
- Do NOT use `bun test` directly -- it uses Bun's native runner which lacks vi.mock support
```

**Part B -- Refactor the test to not require `vi.mock` (optional, higher effort):**

**File(s) to modify:**
- `src/claude-code-provider.ts`
- `tests/claude-code-provider.test.ts`

**What to change:** Replace the `vi.mock('node:child_process')` approach with dependency injection. The `ClaudeCodeProvider` constructor already takes a `binary` option. Instead of mocking `spawn`, extract the spawn call to be injectable.

The approach for the provider:

1. Add an optional `spawnFn` parameter to `ClaudeCodeProviderOptions`:
```typescript
// In src/claude-code-provider.ts
export interface ClaudeCodeProviderOptions {
  binary?: string;
  model?: string;
  maxBudgetUsd?: number;
  timeout?: number;
  permissionMode?: string;
  /** @internal For testing only -- override the child process spawn */
  spawnFn?: typeof import('node:child_process').spawn;
}
```

2. In the constructor, store it: `this.spawnFn = opts.spawnFn ?? spawn;`

3. In `execClaude`, use `this.spawnFn` instead of the imported `spawn`.

4. In `tests/claude-code-provider.test.ts`, remove the `vi.mock` block entirely. Instead, create mock processes using the EventEmitter approach that already exists in the test, but inject them via the `spawnFn` option:
```typescript
const mockSpawn = vi.fn();
const provider = new ClaudeCodeProvider({ spawnFn: mockSpawn as any });
```

This makes the tests work identically under both `bun test` and `vitest run`.

**Why:** Removes the only module-level mock in the test suite, making all tests runner-agnostic.

**Risk level:** Medium -- changes production code (adds optional parameter), but the parameter is internal/test-only.

**Dependencies:** None.

---

### 1.3 Wire up token tracking from Claude CLI output

**Problem:** `Agent.tokenUsage` is always `{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }`. The Claude CLI JSON output includes token usage data, but `ClaudeCodeProvider.parseResponse()` does not extract it, and `AgentRuntime.run()` never updates the agent's `tokenUsage` from the execution result.

**Evidence from live Claude CLI output:**
```json
{
  "usage": {
    "input_tokens": 0,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "output_tokens": 0
  },
  "modelUsage": {
    "claude-opus-4-6": {
      "inputTokens": 2,
      "outputTokens": 4,
      "cacheReadInputTokens": 14043,
      "cacheCreationInputTokens": 10607,
      "costUSD": 0.07342525,
      "contextWindow": 200000,
      "maxOutputTokens": 32000
    }
  }
}
```

**File(s) to modify:**
1. `src/types.ts` -- Add token fields to `ExecutionResult`
2. `src/claude-code-provider.ts` -- Parse token usage in `parseResponse()`
3. `src/agent-runtime.ts` -- Propagate token usage from `ExecutionResult` to `Agent.tokenUsage`

**Step-by-step changes:**

**Step 1: Extend `ExecutionResult` in `src/types.ts` (line 86-92)**

Add a `tokenUsage` field:
```typescript
export interface ExecutionResult {
  result: string;
  costUsd?: number;
  durationMs?: number;
  sessionId?: string;
  numTurns?: number;
  tokenUsage?: TokenUsage;
}
```

**Step 2: Parse tokens in `src/claude-code-provider.ts`, method `parseResponse()` (line 133-153)**

After the existing metadata extraction, add token parsing. The Claude CLI provides two sources: `usage` (top-level, sometimes zeros) and `modelUsage` (per-model, more reliable). Use `modelUsage` when available, fall back to `usage`:

```typescript
private parseResponse(parsed: Record<string, unknown>): ExecutionResult {
  // ... existing metadata extraction (keep as-is) ...

  // Parse token usage from Claude CLI output
  let tokenUsage: TokenUsage | undefined;

  // Try modelUsage first (per-model breakdown, more reliable)
  const modelUsage = parsed.modelUsage as Record<string, Record<string, number>> | undefined;
  if (modelUsage) {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const modelData of Object.values(modelUsage)) {
      inputTokens += (modelData.inputTokens ?? 0)
        + (modelData.cacheReadInputTokens ?? 0)
        + (modelData.cacheCreationInputTokens ?? 0);
      outputTokens += (modelData.outputTokens ?? 0);
    }
    tokenUsage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  // Fall back to top-level usage if modelUsage not present
  if (!tokenUsage) {
    const usage = parsed.usage as Record<string, number> | undefined;
    if (usage && (usage.input_tokens || usage.output_tokens)) {
      const inputTokens = (usage.input_tokens ?? 0)
        + (usage.cache_read_input_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0);
      const outputTokens = usage.output_tokens ?? 0;
      tokenUsage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    }
  }

  const resultText = typeof parsed.result === 'string'
    ? parsed.result
    : JSON.stringify(parsed.result);

  return {
    result: resultText,
    costUsd: this.lastMetadata.costUsd,
    durationMs: this.lastMetadata.durationMs,
    sessionId: this.lastMetadata.sessionId,
    numTurns: this.lastMetadata.numTurns,
    tokenUsage,
  };
}
```

**Step 3: Propagate in `src/agent-runtime.ts`, method `run()` (after line 70)**

After `const execResult = await this.provider.execute(...)`, add:
```typescript
// Update token usage from execution result
if (execResult.tokenUsage) {
  agent.tokenUsage = { ...execResult.tokenUsage };
}
```

This goes between line 70 (`agent.iterations = 1;`) and line 71 (`agent.result = execResult.result;`).

**Step 4: Add tests in `tests/claude-code-provider.test.ts`**

Add a test that verifies token parsing from the `modelUsage` field:
```typescript
it('should parse token usage from modelUsage', async () => {
  const output = JSON.stringify({
    type: 'result',
    result: 'done',
    modelUsage: {
      'claude-opus-4-6': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 300,
        costUSD: 0.05,
      },
    },
  });

  mockSpawn.mockReturnValueOnce(createMockProcess(output, '', 0));
  const provider = new ClaudeCodeProvider();
  const response = await provider.execute({ prompt: 'test' });

  expect(response.tokenUsage).toEqual({
    inputTokens: 600, // 100 + 200 + 300
    outputTokens: 50,
    totalTokens: 650,
  });
});
```

Add a test in `tests/agent-runtime.test.ts` that verifies token propagation:
```typescript
it('should propagate token usage from provider', async () => {
  const provider: LLMProvider = {
    execute: vi.fn(async () => ({
      result: 'Done',
      tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    } as ExecutionResult)),
  };

  const runtime = new AgentRuntime({ store, provider });
  const agent = runtime.create({ id: 'token-agent', prompt: 'Test', model: 'opus' });
  const result = await runtime.run(agent);

  expect(result.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  expect(agent.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
});
```

**Why:** Token tracking is fundamental to cost monitoring, budget enforcement, and understanding agent efficiency. Currently `getTotalTokenUsage()` always returns zeros.

**Risk level:** Low -- additive changes only, all new fields are optional.

**Dependencies:** None (but benefits from 1.2 being done first so tests run under both runners).

---

## Phase 2: Code Quality & Correctness (P1)

### 2.1 Remove duplicate result storage

**Problem:** Both `AgentRuntime.run()` (line 76-80) and `RecursiveSpawner.spawn()` (line 121-125) store the same agent result in `ContextStore` under different keys:
- `AgentRuntime.run()` stores under `agent-result-{id}`
- `RecursiveSpawner.spawn()` stores under `sub-result-{id}`

This wastes storage and creates confusion about which key to use.

**File(s) to modify:**
- `src/agent-runtime.ts` (lines 75-81 and 98-103) -- remove result storage
- `tests/agent-runtime.test.ts` (lines 166-181) -- update the test that checks result storage

**What to change:**

In `src/agent-runtime.ts`, remove the result storage from `run()`. Delete lines 75-81 (success path) and lines 98-103 (error path):
```typescript
// REMOVE these blocks from both try and catch:
const resultKey = `agent-result-${agent.id}`;
await this.store.set(resultKey, agent.result, {
  type: 'result',
  scope: agent.config.parentId ? `agent:${agent.config.parentId}` : 'global',
});
```

In `tests/agent-runtime.test.ts`, update or remove the test "should store result in context store" (lines 166-181). Either:
- Remove it entirely, or
- Change it to verify that `AgentRuntime.run()` does NOT store the result (confirming the behavior change):
```typescript
it('should not store result in context store (delegated to RecursiveSpawner)', async () => {
  const provider = createMockProvider('Task result');
  const runtime = new AgentRuntime({ store, provider });
  const agent = runtime.create({ id: 'no-store', prompt: 'Do work', model: 'opus' });
  await runtime.run(agent);
  expect(store.has('agent-result-no-store')).toBe(false);
});
```

**Why:** RecursiveSpawner is the orchestrator that needs the ref. AgentRuntime should be a pure execution engine. Removing duplicate storage simplifies the mental model and halves the disk writes per agent.

**Risk level:** Medium -- any code that directly reads `agent-result-{id}` keys will break. Search the codebase for `agent-result-` usage. Currently only the test at line 179 reads this key.

**Dependencies:** None.

---

### 2.2 Replace busy-wait polling with event-based concurrency control

**Problem:** `RecursiveSpawner.waitForSlot()` (lines 293-297) uses a `while` loop with `setTimeout(100ms)` to poll for available concurrency slots. This wastes CPU cycles and adds up to 100ms latency per slot acquisition.

**File(s) to modify:**
- `src/recursive-spawner.ts` (lines 293-297, plus the `finally` block at line 146-148)

**What to change:**

Add a resolve queue that gets drained when a slot frees:

1. Add a private field:
```typescript
private waitQueue: Array<() => void> = [];
```

2. Replace `waitForSlot()`:
```typescript
private waitForSlot(): Promise<void> {
  return new Promise<void>((resolve) => {
    this.waitQueue.push(resolve);
  });
}
```

3. In the `finally` block of `spawn()` (line 146-148), after decrementing `activeConcurrent`, drain the queue:
```typescript
} finally {
  this.activeConcurrent--;
  // Wake up the next waiting spawner, if any
  if (this.waitQueue.length > 0) {
    const next = this.waitQueue.shift()!;
    next();
  }
}
```

4. In `reset()` (line 263-268), also clear the wait queue:
```typescript
reset(): void {
  this.spawnedAgents.clear();
  this.rootId = undefined;
  this.activeConcurrent = 0;
  this.currentDepth = 0;
  // Resolve any pending waiters (they will find slots available)
  for (const resolve of this.waitQueue) {
    resolve();
  }
  this.waitQueue = [];
}
```

**Why:** Eliminates polling overhead. Resolving queued promises is O(1) and has zero latency. This is the standard semaphore pattern for async JavaScript.

**Risk level:** Low -- the behavior is identical (FIFO slot acquisition), just without polling.

**Dependencies:** None.

---

### 2.3 Wire up SpawnConfig.timeout

**Problem:** `SpawnConfig.timeout` is defined in `types.ts` (line 151) but never read anywhere. A sub-agent spawned with `{ timeout: 10000 }` will still use the provider's default timeout (5 minutes).

**File(s) to modify:**
- `src/recursive-spawner.ts` -- in `spawn()`, wrap the `runtime.run()` call with a timeout

**What to change:**

In `src/recursive-spawner.ts`, inside the `try` block of `spawn()` (around line 117-118), wrap the execution with a `Promise.race` if timeout is specified:

```typescript
try {
  const agent = this.runtime.create(agentConfig);

  let resultPromise: Promise<AgentResult> = this.runtime.run(agent);

  // Apply per-agent timeout if specified
  if (config.timeout && config.timeout > 0) {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(
          `Sub-agent ${agentId} timed out after ${config.timeout}ms`
        ));
      }, config.timeout);
    });
    resultPromise = Promise.race([resultPromise, timeoutPromise]);
  }

  const result = await resultPromise;
  // ... rest of success handling
```

Note: This does NOT kill the underlying `claude -p` process when the timeout fires. It only causes the spawner to stop waiting and treat the agent as failed. The provider's own timeout (5 minutes default) will eventually kill the process. To kill the process immediately, we would need to expose a cancellation handle from `AgentRuntime.run()`, which is a larger change (see Backlog: graceful shutdown).

**Add a test** in `tests/recursive-spawner.test.ts`:
```typescript
it('should timeout if agent takes too long', async () => {
  const slowProvider: LLMProvider = {
    execute: vi.fn(
      () => new Promise((resolve) =>
        setTimeout(() => resolve({ result: 'late' }), 5000)
      )
    ),
  };

  const slowRuntime = new AgentRuntime({ store, provider: slowProvider });
  const spawner = new RecursiveSpawner({
    runtime: slowRuntime,
    store,
    defaultModel: 'opus',
    maxDepth: 5,
    maxConcurrent: 3,
  });

  const ref = await spawner.spawn({
    prompt: 'slow task',
    context: {},
    timeout: 50, // 50ms timeout
  });

  const result = await store.resolve(ref);
  expect((result as Record<string, string>).error).toContain('timed out');
});
```

**Why:** Without this, the `timeout` field in `SpawnConfig` is misleading -- it exists but does nothing.

**Risk level:** Low -- additive behavior, only triggers when `timeout` is explicitly set.

**Dependencies:** None.

---

### 2.4 Fix silent catch blocks with proper error logging

**Problem:** Multiple `catch {}` blocks silently swallow errors, making debugging difficult.

**File(s) to modify:**
- `src/agent-runtime.ts` (line 138)
- `src/context-store.ts` (line 289)
- `src/recursive-spawner.ts` (line 102-104)

**What to change:**

**In `src/agent-runtime.ts` line 134-140 (`buildPrompt`):**

Replace the silent catch with a logged warning:
```typescript
if (agent.config.contextRef) {
  try {
    const contextSummary = await this.store.summarize(
      agent.config.contextRef.key, 500
    );
    prompt += `\n\nContext variable "${agent.config.contextRef.key}" `
      + `(${agent.config.contextRef.sizeBytes} bytes, `
      + `type: ${agent.config.contextRef.type}):\n${contextSummary}`;
  } catch (err: unknown) {
    const error = err as Error;
    this.onLog(
      agent.id,
      `Warning: Could not resolve context ref `
        + `"${agent.config.contextRef.key}": ${error.message}`
    );
  }
}
```

**In `src/context-store.ts` line 286-291 (`loadPersistedVariables` inner catch):**

Add a warning for corrupt files:
```typescript
} catch (err: unknown) {
  // Log corrupt files but continue loading others
  const error = err as Error;
  process.stderr.write(
    `[ContextStore] Warning: Skipping corrupt file `
      + `${filePath}: ${error.message}\n`
  );
}
```

**In `src/recursive-spawner.ts` line 102-104 (context prompt building catch):**

Already has a fallback message, but should log:
```typescript
} catch (err: unknown) {
  const error = err as Error;
  this.onLog(
    `Warning: Could not persist context variable `
      + `"${name}" for sub-agent: ${error.message}`
  );
  contextPrompt += `\n\nContext variable "${name}" `
    + `(ref: ${ref.key}): [not resolvable]`;
}
```

**Acceptable silent catches (leave as-is with comment):**
- `context-store.ts` line 120-124 (`delete` disk unlink) -- already has comment, file may not exist
- `context-store.ts` line 263-267 (`loadFromDisk`) -- expected for missing files
- `claude-code-provider.ts` line 89 (SIGKILL fallback) -- process may already be dead

**Why:** Silent error swallowing is the top debugging pain point. These changes make failures visible without changing behavior.

**Risk level:** Low -- only adds logging, no behavior changes.

**Dependencies:** None.

---

## Phase 3: Module Integration (P2)

### 3.1 Integrate MemoryManager into agent lifecycle

**Problem:** `MemoryManager` is created in `cli.ts` `createSystem()` (line 41-42) but the returned `memory` object is never passed to `AgentRuntime` or `RecursiveSpawner`. Agent execution results are never recorded in episodic memory, and agents cannot query semantic memory.

**File(s) to modify:**
1. `src/agent-runtime.ts` -- accept and use MemoryManager
2. `src/cli.ts` -- pass memory to runtime
3. `tests/integration.test.ts` -- add test for memory integration

**What to change:**

**Step 1: Add optional memory to `AgentRuntimeOptions`:**

In `src/agent-runtime.ts`:
```typescript
import type { IMemoryManager, MemoryEntry } from './types.js';

export interface AgentRuntimeOptions {
  provider: LLMProvider;
  store: IContextStore;
  memory?: IMemoryManager;
  onLog?: (agentId: string, message: string) => void;
}
```

Store it in the constructor: `this.memory = opts.memory;`

**Step 2: Log agent execution to episodic memory:**

At the end of `run()`, in the success path (after line 73), add:
```typescript
// Record execution in episodic memory
if (this.memory) {
  await this.memory.append('episodic', {
    id: agent.id,
    timestamp: Date.now(),
    content: `Agent ${agent.id} completed: `
      + (typeof agent.result === 'string'
        ? agent.result.slice(0, 500)
        : JSON.stringify(agent.result).slice(0, 500)),
    metadata: {
      agentId: agent.id,
      model: agent.config.model,
      iterations: agent.iterations,
      costUsd: execResult.costUsd,
      status: 'completed',
    },
  });
}
```

In the error path (after line 96), add similarly:
```typescript
if (this.memory) {
  await this.memory.append('episodic', {
    id: agent.id,
    timestamp: Date.now(),
    content: `Agent ${agent.id} failed: ${error.message}`,
    metadata: {
      agentId: agent.id,
      model: agent.config.model,
      status: 'failed',
      error: error.message,
    },
  });
}
```

**Step 3: Inject relevant memory into prompts:**

In `buildPrompt()`, after the context ref handling, add:
```typescript
// Inject relevant episodic memory if available
if (this.memory) {
  try {
    const relevantMemories = await this.memory.search(
      'episodic', agent.config.prompt, 3
    );
    if (relevantMemories.length > 0) {
      prompt += '\n\nRelevant past agent executions:';
      for (const mem of relevantMemories) {
        prompt += `\n- ${mem.content.slice(0, 200)}`;
      }
    }
  } catch {
    // Memory search failure is non-fatal
  }
}
```

**Step 4: Wire it up in `cli.ts`:**

In `createSystem()` (line 44), pass memory to runtime:
```typescript
const runtime = new AgentRuntime({
  provider,
  store,
  memory,
  onLog: (agentId, msg) => log(
    `[${agentId.slice(0, 8)}] ${msg}`, config.verbose
  ),
});
```

**Step 5: Add integration test:**

In `tests/integration.test.ts`, add a test in the "Store -> Agent -> Result" describe block:
```typescript
it('should log agent execution to episodic memory', async () => {
  const provider: LLMProvider = {
    execute: vi.fn(async () => ({
      result: 'Analysis done',
    } as ExecutionResult)),
  };

  runtime = new AgentRuntime({ store, provider, memory });
  const agent = runtime.create({
    id: 'mem-agent', prompt: 'Analyze data', model: 'opus',
  });
  await runtime.run(agent);

  const episodic = memory.getEpisodicMemory();
  expect(episodic.length).toBeGreaterThan(0);
  expect(
    episodic.some(e => e.metadata?.agentId === 'mem-agent')
  ).toBe(true);
});
```

**Why:** Memory integration enables agents to learn from past executions. Without it, every agent invocation starts from scratch with no institutional knowledge.

**Risk level:** Medium -- changes to `AgentRuntime` constructor signature (but the new field is optional, so existing code is unaffected). Memory append failures should be caught and logged, not thrown.

**Dependencies:** None.

---

### 3.2 Integrate FunctionRegistry into agent lifecycle

**Problem:** `FunctionRegistry` is fully implemented but never used by `AgentRuntime` or `RecursiveSpawner`. Sub-agents have no way to invoke registered functions.

**Approach:** Inject function descriptions into agent prompts so sub-agents know about available functions. Since our architecture is spawn-and-wait (not REPL), we cannot do mid-execution function calls. Instead, we take the simpler approach: include function descriptions in the prompt as reference information.

**File(s) to modify:**
1. `src/agent-runtime.ts` -- accept FunctionRegistry, inject descriptions into prompt
2. `src/cli.ts` -- pass registry to runtime
3. `tests/agent-runtime.test.ts` -- add test

**What to change:**

**Step 1: Add optional registry to `AgentRuntimeOptions`:**

```typescript
import type { IFunctionRegistry } from './types.js';

export interface AgentRuntimeOptions {
  provider: LLMProvider;
  store: IContextStore;
  memory?: IMemoryManager;
  functions?: IFunctionRegistry;
  onLog?: (agentId: string, message: string) => void;
}
```

**Step 2: In `buildPrompt()`, append function descriptions:**

```typescript
// Include registered function descriptions in prompt
if (this.functions) {
  const funcs = this.functions.list();
  if (funcs.length > 0) {
    prompt += '\n\nAvailable functions (for reference):';
    for (const fn of funcs) {
      const params = Object.entries(fn.parameters)
        .map(([name, spec]) =>
          `${name}: ${spec.type}`
          + `${spec.required === false ? '?' : ''}`
          + ` - ${spec.description}`
        )
        .join(', ');
      prompt += `\n- ${fn.name}(${params}): ${fn.description}`;
    }
  }
}
```

**Note:** This is a "soft" integration -- it gives sub-agents awareness of functions but does not enable them to call functions during execution. True function calling would require a REPL loop or post-processing step, which is a larger architectural change.

**Step 3: Wire it up in `cli.ts`:**

```typescript
const registry = new FunctionRegistry();

const runtime = new AgentRuntime({
  provider,
  store,
  memory,
  functions: registry,
  onLog: (agentId, msg) => log(
    `[${agentId.slice(0, 8)}] ${msg}`, config.verbose
  ),
});

return { store, memory, runtime, spawner, provider, registry };
```

**Why:** Even as reference-only, function descriptions help sub-agents understand the system's capabilities. This is a stepping stone toward full function calling.

**Risk level:** Low -- additive, optional parameter, no behavior change for existing users.

**Dependencies:** 3.1 (MemoryManager integration changes `AgentRuntimeOptions` -- do both in one pass).

---

### 3.3 Add CLI tests

**Problem:** `src/cli.ts` has no corresponding test file. The CLI is a critical entry point.

**File(s) to create:**
- `tests/cli.test.ts`

**What to test:**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { getDefaultConfig, createSystem, main } from '../src/cli.js';

describe('CLI', () => {
  describe('getDefaultConfig', () => {
    it('should return default configuration', () => {
      const config = getDefaultConfig();
      expect(config.model).toBe('claude-opus-4-6');
      expect(config.maxDepth).toBe(5);
      expect(config.maxConcurrent).toBe(3);
      expect(config.tokenBudget).toBe(1_000_000);
      expect(config.verbose).toBe(false);
    });
  });

  describe('main', () => {
    it('should show help with --help', async () => {
      const spy = vi.spyOn(console, 'log')
        .mockImplementation(() => {});
      const code = await main(['--help']);
      expect(code).toBe(0);
      expect(spy).toHaveBeenCalled();
      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('RLM');
      expect(output).toContain('run');
      spy.mockRestore();
    });

    it('should show help with -h', async () => {
      const spy = vi.spyOn(console, 'log')
        .mockImplementation(() => {});
      const code = await main(['-h']);
      expect(code).toBe(0);
      spy.mockRestore();
    });

    it('should error on run without task', async () => {
      const spy = vi.spyOn(console, 'error')
        .mockImplementation(() => {});
      const code = await main(['run']);
      expect(code).toBe(1);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('Task description required')
      );
      spy.mockRestore();
    });

    it('should show usage with no arguments', async () => {
      const spy = vi.spyOn(console, 'log')
        .mockImplementation(() => {});
      const code = await main([]);
      expect(code).toBe(0);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('createSystem', () => {
    it('should create all system components', async () => {
      const config = getDefaultConfig();
      config.storageDir = '/tmp/.rlm-test-cli-' + Date.now();
      const system = await createSystem(config);

      expect(system.store).toBeDefined();
      expect(system.memory).toBeDefined();
      expect(system.runtime).toBeDefined();
      expect(system.spawner).toBeDefined();
      expect(system.provider).toBeDefined();

      // Cleanup
      await system.store.clear();
    });
  });
});
```

**Why:** CLI is the primary user-facing entry point. Testing it catches argument parsing regressions and ensures the system bootstraps correctly.

**Risk level:** Low -- new test file only, no production changes.

**Dependencies:** None (but if 3.1 and 3.2 change `createSystem`'s return type, update accordingly).

---

## Phase 4: Paper-Inspired Improvements

### 4.1 Constant-size metadata passing

**Problem:** The current approach embeds context file paths and metadata directly in the prompt string. While the `VariableRef` itself is constant-size (~150 bytes), the prompt string grows linearly with the number of context variables because each one adds several lines of instructions. The paper's ideal is that the LLM receives only constant-size metadata about the prompt, regardless of context size.

**File(s) to modify:**
- `src/recursive-spawner.ts` -- refactor context prompt construction

**What to change:**

Instead of inlining context variable instructions in the prompt, create a single manifest file that lists all context variables, and pass one line in the prompt pointing to the manifest.

**Step 1: Add a manifest generation method to `RecursiveSpawner`:**

```typescript
private async createContextManifest(
  agentId: string,
  context: Record<string, VariableRef>,
): Promise<string | null> {
  if (Object.keys(context).length === 0) return null;

  const manifest: Record<string, {
    filePath: string;
    sizeBytes: number;
    type: string;
  }> = {};

  for (const [name, ref] of Object.entries(context)) {
    try {
      const filePath = await this.store.persistForSubAgent(ref.key);
      manifest[name] = {
        filePath,
        sizeBytes: ref.sizeBytes,
        type: ref.type,
      };
    } catch {
      manifest[name] = {
        filePath: '[not available]',
        sizeBytes: 0,
        type: ref.type,
      };
    }
  }

  const manifestKey = `manifest-${agentId}`;
  await this.store.set(manifestKey, manifest, {
    type: 'json',
    persist: true,
  });
  return this.store.getFilePath(manifestKey);
}
```

**Step 2: Refactor `spawn()` context prompt construction (lines 95-105):**

Replace the per-variable prompt expansion with:
```typescript
// Build context: create a manifest file and pass a single reference
const manifestPath = await this.createContextManifest(
  agentId, config.context
);
let contextPrompt = config.prompt;
if (manifestPath) {
  contextPrompt += `\n\nContext manifest: Read ${manifestPath}`;
  contextPrompt += '\nThe JSON file maps variable names to '
    + '{filePath, sizeBytes, type}. Read each filePath to access '
    + 'the data (look in the "value" field of each JSON file).';
}
```

This keeps the prompt growth at O(1) regardless of how many context variables are passed. The manifest itself is a small JSON file (~100 bytes per variable).

**Why:** Aligns with the paper's core insight that the LLM should receive constant-size metadata. Reduces prompt pollution when many variables are passed. The sub-agent still has access to all data via the manifest file.

**Risk level:** Medium -- changes how sub-agents receive context. Sub-agents now need to read a manifest file first, then read individual variable files. This adds one extra file read per sub-agent invocation.

**Dependencies:** None, but test carefully with integration tests.

---

### 4.2 Better prompt construction for sub-agents

**Problem:** The current prompt construction is ad-hoc. `buildPrompt()` in `AgentRuntime` appends context summaries and "You are a sub-agent" instructions as raw string concatenation. This does not scale well and does not follow a principled structure.

**File(s) to modify:**
- `src/agent-runtime.ts` -- refactor `buildPrompt()`

**What to change:**

Replace the ad-hoc string concatenation with a structured prompt template:

```typescript
private async buildPrompt(agent: Agent): Promise<string> {
  const sections: string[] = [];

  // Section 1: Task description (always present)
  sections.push(`## Task\n${agent.config.prompt}`);

  // Section 2: Role context (if sub-agent)
  if (agent.config.parentId) {
    sections.push(
      '## Role\nYou are a sub-agent in a recursive language model '
      + 'system. Complete your assigned task and return your result. '
      + 'Focus only on what is asked.'
    );
  }

  // Section 3: Context variable summary (if present)
  if (agent.config.contextRef) {
    try {
      const summary = await this.store.summarize(
        agent.config.contextRef.key, 500
      );
      sections.push(
        `## Context\nVariable `
        + `"${agent.config.contextRef.key}" `
        + `(${agent.config.contextRef.sizeBytes} bytes, `
        + `type: ${agent.config.contextRef.type}):\n${summary}`
      );
    } catch (err: unknown) {
      this.onLog(
        agent.id,
        `Warning: Could not resolve context ref: `
        + `${(err as Error).message}`
      );
    }
  }

  // Section 4: Relevant memory (if available)
  if (this.memory) {
    try {
      const memories = await this.memory.search(
        'episodic', agent.config.prompt, 3
      );
      if (memories.length > 0) {
        const memLines = memories.map(
          m => `- ${m.content.slice(0, 200)}`
        );
        sections.push(
          `## Relevant History\n${memLines.join('\n')}`
        );
      }
    } catch {
      // Non-fatal
    }
  }

  // Section 5: Available functions (if any registered)
  if (this.functions) {
    const funcs = this.functions.list();
    if (funcs.length > 0) {
      const funcLines = funcs.map(fn => {
        const params = Object.entries(fn.parameters)
          .map(([name, spec]) => `${name}: ${spec.type}`)
          .join(', ');
        return `- ${fn.name}(${params}): ${fn.description}`;
      });
      sections.push(
        `## Available Functions\n${funcLines.join('\n')}`
      );
    }
  }

  return sections.join('\n\n');
}
```

**Why:** Structured prompts are easier to debug, extend, and reason about. The markdown-header format (##) gives sub-agents clear section boundaries. This is a prerequisite for more sophisticated prompt engineering (e.g., including examples, constraints, or output format instructions).

**Risk level:** Medium -- changes the exact prompt text that sub-agents receive. Existing tests that check for specific prompt substrings (like `tests/agent-runtime.test.ts` line 143: `expect(executeCall.prompt).toContain('my-context')`) will still pass because the context key is still included. But the overall prompt structure changes.

**Dependencies:** 3.1 (MemoryManager integration) and 3.2 (FunctionRegistry integration) -- this refactors `buildPrompt()` to include both.

---

### 4.3 Context decomposition helpers

**Problem:** The paper's primary use case is context decomposition -- splitting a large context into chunks and delegating each to a sub-agent. Currently, callers must manually split data, create `SpawnConfig` objects, and manage the fan-out. There are no built-in helpers for this pattern.

**File(s) to modify:**
- `src/recursive-spawner.ts` -- add a `decompose()` convenience method
- `src/types.ts` -- add `decompose` to `IRecursiveSpawner` interface

**What to change:**

Add a new method to `RecursiveSpawner`:

```typescript
/**
 * Context decomposition: split a large variable into chunks,
 * spawn a sub-agent per chunk with the same task, and merge.
 *
 * This is the primary pattern from the RLM paper.
 */
async decompose(opts: {
  /** The task/query for each sub-agent */
  prompt: string;
  /** The variable to decompose */
  sourceRef: VariableRef;
  /** Number of chunks to split into */
  chunks: number;
  /** Merge strategy for combining results */
  mergeStrategy: MergeStrategy;
  /** Optional model override */
  model?: string;
  /** Optional timeout per sub-agent */
  timeout?: number;
  /** Parent agent ID for tracking */
  parentId?: string;
  /** Current recursion depth */
  depth?: number;
}): Promise<VariableRef> {
  const sourceValue = await this.store.resolve(opts.sourceRef);
  const sourceStr = typeof sourceValue === 'string'
    ? sourceValue
    : JSON.stringify(sourceValue);

  // Split into roughly equal chunks
  const chunkSize = Math.ceil(sourceStr.length / opts.chunks);
  const configs: SpawnConfig[] = [];

  for (let i = 0; i < opts.chunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, sourceStr.length);
    const chunk = sourceStr.slice(start, end);

    const chunkKey = `chunk-${opts.sourceRef.key}-${i}`;
    const chunkRef = await this.store.set(chunkKey, chunk, {
      type: 'text',
    });

    configs.push({
      prompt: opts.prompt,
      context: { chunk: chunkRef },
      model: opts.model,
      timeout: opts.timeout,
    });
  }

  const resultRefs = await this.spawnMany(
    configs, opts.parentId, opts.depth
  );
  return this.merge(resultRefs, opts.mergeStrategy);
}
```

Also update the `IRecursiveSpawner` interface in `src/types.ts` (line 170-175):
```typescript
export interface IRecursiveSpawner {
  spawn(config: SpawnConfig): Promise<VariableRef>;
  spawnMany(configs: SpawnConfig[]): Promise<VariableRef[]>;
  merge(refs: VariableRef[], strategy: MergeStrategy): Promise<VariableRef>;
  decompose(opts: {
    prompt: string;
    sourceRef: VariableRef;
    chunks: number;
    mergeStrategy: MergeStrategy;
    model?: string;
    timeout?: number;
    parentId?: string;
    depth?: number;
  }): Promise<VariableRef>;
  getTree(): AgentTree;
}
```

**Why:** Context decomposition is the core pattern of the RLM paper. A built-in helper makes it a one-liner instead of 20+ lines of boilerplate. The chunking is naive (character-based splitting) but can be extended with smarter strategies (sentence boundaries, semantic chunking) later.

**Risk level:** Low -- new method, purely additive.

**Dependencies:** 2.3 (timeout support) for the `timeout` parameter to work.

---

### 4.4 Token budget propagation

**Problem:** `RLMConfig.tokenBudget` (default 1,000,000) is defined but never enforced. Sub-agents can consume unlimited tokens.

**File(s) to modify:**
- `src/recursive-spawner.ts` -- track cumulative usage, check budget before spawning
- `src/types.ts` -- no changes needed (field already exists on `RLMConfig`)

**What to change:**

**Step 1: Add budget tracking to `RecursiveSpawnerOptions`:**

```typescript
export interface RecursiveSpawnerOptions {
  runtime: AgentRuntime;
  store: ContextStore;
  defaultModel: string;
  maxDepth: number;
  maxConcurrent: number;
  tokenBudget?: number;
  onLog?: (message: string) => void;
}
```

Add private fields:
```typescript
private tokenBudget: number;
private totalTokensUsed = 0;
```

In constructor: `this.tokenBudget = opts.tokenBudget ?? Infinity;`

**Step 2: Check budget before spawning:**

At the top of `spawn()`, after the depth check:
```typescript
if (this.totalTokensUsed >= this.tokenBudget) {
  throw new Error(
    `Token budget exhausted `
    + `(${this.totalTokensUsed} / ${this.tokenBudget} tokens used)`
  );
}
```

**Step 3: Track usage after completion:**

In the success path of `spawn()`, after `spawnedAgent.tokenUsage = result.tokenUsage;`:
```typescript
this.totalTokensUsed += result.tokenUsage.totalTokens;
```

**Step 4: Expose getter and include in reset:**

```typescript
getTotalTokensUsed(): number {
  return this.totalTokensUsed;
}
```

In `reset()`, add: `this.totalTokensUsed = 0;`

**Step 5: Wire budget from `cli.ts`:**

In `createSystem()`:
```typescript
const spawner = new RecursiveSpawner({
  runtime,
  store,
  defaultModel: config.model,
  maxDepth: config.maxDepth,
  maxConcurrent: config.maxConcurrent,
  tokenBudget: config.tokenBudget,
  onLog: (msg) => log(msg, config.verbose),
});
```

**Why:** Without budget enforcement, a recursive fan-out could consume unbounded tokens. This is especially important for the `decompose()` method from 4.3, which could generate many sub-agents.

**Risk level:** Medium -- if token tracking (Phase 1.3) is not working correctly, the budget check could be based on zeros and never trigger. Make sure 1.3 is complete and tested first.

**Dependencies:** 1.3 (token tracking) must be complete and working.

---

## Implementation Order Summary

```
Phase 1 (P0 - Fix Broken):
  1.1 Fix delete test assertion         [5 min,  risk: low]
  1.2 Fix vi.mock test compatibility    [30 min, risk: medium]
  1.3 Wire up token tracking            [45 min, risk: low]

Phase 2 (P1 - Quality):
  2.1 Remove duplicate result storage   [15 min, risk: medium]
  2.2 Event-based concurrency control   [20 min, risk: low]
  2.3 Wire up SpawnConfig.timeout       [20 min, risk: low]
  2.4 Fix silent catch blocks           [15 min, risk: low]

Phase 3 (P2 - Integration):
  3.1 Integrate MemoryManager           [45 min, risk: medium]
  3.2 Integrate FunctionRegistry        [30 min, risk: low]
  3.3 Add CLI tests                     [20 min, risk: low]

Phase 4 (Paper-Inspired):
  4.1 Constant-size metadata passing    [30 min, risk: medium]
  4.2 Better prompt construction        [30 min, risk: medium]
  4.3 Context decomposition helpers     [30 min, risk: low]
  4.4 Token budget propagation          [30 min, risk: medium]
```

**Critical path:**
1.1 and 1.2 are independent, do them first.
1.3 can proceed in parallel.
Phase 2 items (2.1-2.4) are all independent of each other.
3.1 and 3.2 both modify `AgentRuntimeOptions` -- do them together.
4.2 depends on 3.1 + 3.2 (it refactors `buildPrompt()` to include memory and functions).
4.4 depends on 1.3 (token tracking must work for budget enforcement to be meaningful).

**After each phase, run:** `bun run test` (which invokes `vitest run`) and `bun run lint` to verify no regressions.
