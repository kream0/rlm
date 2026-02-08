import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTodoMd, buildDevPrompt, DevSession } from '../src/dev-session.js';
import type {
  ParsedTask,
  LLMProvider,
  ExecutionResult,
  ClaudeCodeProviderFactoryOpts,
} from '../src/types.js';

// --- parseTodoMd ---

describe('parseTodoMd', () => {
  it('should parse bold tasks with descriptions', () => {
    const content = `## Features\n- [ ] **Add login** - Implement OAuth login flow`;
    const tasks = parseTodoMd(content);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Add login');
    expect(tasks[0].description).toBe('Implement OAuth login flow');
    expect(tasks[0].section).toBe('Features');
    expect(tasks[0].lineNumber).toBe(2);
  });

  it('should parse bold tasks with colon separator', () => {
    const content = `- [ ] **Setup CI**: Configure GitHub Actions`;
    const tasks = parseTodoMd(content);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Setup CI');
    expect(tasks[0].description).toBe('Configure GitHub Actions');
  });

  it('should parse plain tasks without bold', () => {
    const content = `- [ ] Fix the broken test`;
    const tasks = parseTodoMd(content);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Fix the broken test');
    expect(tasks[0].description).toBe('');
  });

  it('should skip completed tasks', () => {
    const content = [
      '- [x] Already done',
      '- [ ] Still pending',
      '- [X] Also done',
    ].join('\n');
    const tasks = parseTodoMd(content);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Still pending');
  });

  it('should track sections', () => {
    const content = [
      '## Phase 1',
      '- [ ] Task A',
      '## Phase 2',
      '- [ ] Task B',
    ].join('\n');
    const tasks = parseTodoMd(content);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].section).toBe('Phase 1');
    expect(tasks[1].section).toBe('Phase 2');
  });

  it('should return empty array for empty input', () => {
    expect(parseTodoMd('')).toEqual([]);
  });

  it('should return empty array for input with no tasks', () => {
    const content = `# My Project\n\nSome description text.\n\n- [x] Done task`;
    expect(parseTodoMd(content)).toEqual([]);
  });

  it('should handle malformed lines gracefully', () => {
    const content = [
      '- [ ] Valid task',
      '- [] Missing space',
      '  - [ ] Indented task should not match',
      '* [ ] Asterisk task',
      '- [  ] Extra space',
      'random text',
    ].join('\n');
    const tasks = parseTodoMd(content);
    // Only "- [ ] Valid task" and "* [ ] Asterisk task" should match
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe('Valid task');
    expect(tasks[1].title).toBe('Asterisk task');
  });

  it('should handle multiple tasks in same section', () => {
    const content = [
      '## Bugs',
      '- [ ] **Fix crash** - App crashes on startup',
      '- [ ] **Fix leak** - Memory leak in worker',
      '- [ ] Simple fix',
    ].join('\n');
    const tasks = parseTodoMd(content);
    expect(tasks).toHaveLength(3);
    expect(tasks.every(t => t.section === 'Bugs')).toBe(true);
  });

  it('should default to General section when no header', () => {
    const content = `- [ ] Standalone task`;
    const tasks = parseTodoMd(content);
    expect(tasks[0].section).toBe('General');
  });

  it('should preserve rawLine', () => {
    const line = '- [ ] **Bold** - desc';
    const tasks = parseTodoMd(line);
    expect(tasks[0].rawLine).toBe(line);
  });
});

// --- buildDevPrompt ---

describe('buildDevPrompt', () => {
  const baseTask: ParsedTask = {
    title: 'Add tests',
    description: 'Write unit tests for auth module',
    section: 'Testing',
    lineNumber: 5,
    rawLine: '- [ ] **Add tests** - Write unit tests for auth module',
  };

  it('should include CLAUDE.md content', () => {
    const prompt = buildDevPrompt({
      claudeMd: '# Project Rules\nUse strict mode.',
      task: baseTask,
    });
    expect(prompt).toContain('## Project Rules');
    expect(prompt).toContain('Use strict mode.');
  });

  it('should include task title and description', () => {
    const prompt = buildDevPrompt({
      claudeMd: '',
      task: baseTask,
    });
    expect(prompt).toContain('## Your Task');
    expect(prompt).toContain('Add tests: Write unit tests for auth module');
  });

  it('should include default instructions', () => {
    const prompt = buildDevPrompt({
      claudeMd: '',
      task: baseTask,
    });
    expect(prompt).toContain('## Instructions');
    expect(prompt).toContain('no stubs or placeholders');
    expect(prompt).toContain('Run tests');
    expect(prompt).toContain('TODO.md');
    expect(prompt).toContain('DO NOT push');
  });

  it('should include previous results when provided', () => {
    const prompt = buildDevPrompt({
      claudeMd: '',
      task: baseTask,
      previousResults: [
        { task: 'Setup DB', summary: 'Created migration files.' },
        { task: 'Add models', summary: 'Defined User and Post models.' },
      ],
    });
    expect(prompt).toContain('## Previous Agents');
    expect(prompt).toContain('Setup DB');
    expect(prompt).toContain('Created migration files.');
    expect(prompt).toContain('Add models');
  });

  it('should not include previous results section when empty', () => {
    const prompt = buildDevPrompt({
      claudeMd: '',
      task: baseTask,
    });
    expect(prompt).not.toContain('## Previous Agents');
  });

  it('should include retry error when provided', () => {
    const prompt = buildDevPrompt({
      claudeMd: '',
      task: baseTask,
      retryError: 'TypeError: Cannot read property "x" of undefined',
    });
    expect(prompt).toContain('## Retry Context');
    expect(prompt).toContain('TypeError: Cannot read property "x" of undefined');
  });

  it('should handle task with no description', () => {
    const prompt = buildDevPrompt({
      claudeMd: '',
      task: { ...baseTask, description: '' },
    });
    expect(prompt).toContain('Add tests');
    expect(prompt).not.toContain('Add tests:');
  });
});

// --- DevSession ---

describe('DevSession', () => {
  // Mock provider factory
  function createMockProviderFactory(results: ExecutionResult[]) {
    let callIndex = 0;
    const factoryCalls: ClaudeCodeProviderFactoryOpts[] = [];
    const executeCalls: Array<Record<string, unknown>> = [];

    const factory = (opts: ClaudeCodeProviderFactoryOpts): LLMProvider => {
      factoryCalls.push(opts);
      return {
        execute: async (params: Record<string, unknown>) => {
          executeCalls.push(params);
          const result = results[callIndex++];
          if (!result) throw new Error('No more mock results');
          return result;
        },
      } as unknown as LLMProvider;
    };

    return { factory, factoryCalls, executeCalls };
  }

  function createMockResult(overrides?: Partial<ExecutionResult>): ExecutionResult {
    return {
      result: 'Task completed successfully.',
      costUsd: 0.05,
      durationMs: 5000,
      sessionId: 'sess-mock',
      numTurns: 3,
      ...overrides,
    };
  }

  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'rlm-test-'));
  });

  it('should execute two tasks sequentially with context passing', async () => {
    await writeFile(join(tmpDir, 'CLAUDE.md'), '# Rules\nBe careful.', 'utf-8');
    await writeFile(join(tmpDir, 'TODO.md'), [
      '## Work',
      '- [ ] **Task A** - First task',
      '- [ ] **Task B** - Second task',
    ].join('\n'), 'utf-8');
    await writeFile(join(tmpDir, 'LAST_SESSION.md'), '', 'utf-8');

    const { factory, executeCalls } = createMockProviderFactory([
      createMockResult({ result: 'Did task A.' }),
      createMockResult({ result: 'Did task B.' }),
    ]);

    const session = new DevSession({
      projectDir: tmpDir,
      providerFactory: factory,
    });

    const report = await session.run();

    expect(report.tasksAttempted).toBe(2);
    expect(report.taskReports).toHaveLength(2);
    expect(report.taskReports[0].status).toBe('completed');
    expect(report.taskReports[1].status).toBe('completed');

    // Second agent's prompt should contain info about first task
    const secondPrompt = executeCalls[1].prompt as string;
    expect(secondPrompt).toContain('Previous Agents');
    expect(secondPrompt).toContain('Task A');
    expect(secondPrompt).toContain('Did task A.');
  });

  it('should use explicit tasks when provided', async () => {
    await writeFile(join(tmpDir, 'CLAUDE.md'), '', 'utf-8');
    await writeFile(join(tmpDir, 'TODO.md'), '', 'utf-8');
    await writeFile(join(tmpDir, 'LAST_SESSION.md'), '', 'utf-8');

    const { factory } = createMockProviderFactory([
      createMockResult(),
    ]);

    const session = new DevSession({
      projectDir: tmpDir,
      tasks: ['Do something specific'],
      providerFactory: factory,
    });

    const report = await session.run();
    expect(report.tasksAttempted).toBe(1);
    expect(report.taskReports[0].task.title).toBe('Do something specific');
  });

  it('should return empty report when no tasks found', async () => {
    await writeFile(join(tmpDir, 'CLAUDE.md'), '', 'utf-8');
    await writeFile(join(tmpDir, 'TODO.md'), '# Nothing here\n- [x] Done', 'utf-8');

    const { factory } = createMockProviderFactory([]);

    const session = new DevSession({
      projectDir: tmpDir,
      providerFactory: factory,
    });

    const report = await session.run();
    expect(report.tasksAttempted).toBe(0);
    expect(report.summary).toContain('No pending tasks');
  });

  describe('failure modes', () => {
    it('should continue on failure by default', async () => {
      await writeFile(join(tmpDir, 'CLAUDE.md'), '', 'utf-8');
      await writeFile(join(tmpDir, 'TODO.md'), [
        '- [ ] Task 1',
        '- [ ] Task 2',
      ].join('\n'), 'utf-8');
      await writeFile(join(tmpDir, 'LAST_SESSION.md'), '', 'utf-8');

      let callCount = 0;
      const factory = (): LLMProvider => ({
        execute: async () => {
          callCount++;
          if (callCount === 1) throw new Error('Boom');
          return createMockResult();
        },
      } as unknown as LLMProvider);

      const session = new DevSession({
        projectDir: tmpDir,
        onFailure: 'continue',
        providerFactory: factory,
      });

      const report = await session.run();
      expect(report.taskReports).toHaveLength(2);
      expect(report.taskReports[0].status).toBe('failed');
      expect(report.taskReports[1].status).toBe('completed');
    });

    it('should stop on failure when configured', async () => {
      await writeFile(join(tmpDir, 'CLAUDE.md'), '', 'utf-8');
      await writeFile(join(tmpDir, 'TODO.md'), [
        '- [ ] Task 1',
        '- [ ] Task 2',
      ].join('\n'), 'utf-8');
      await writeFile(join(tmpDir, 'LAST_SESSION.md'), '', 'utf-8');

      const factory = (): LLMProvider => ({
        execute: async () => { throw new Error('Boom'); },
      } as unknown as LLMProvider);

      const session = new DevSession({
        projectDir: tmpDir,
        onFailure: 'stop',
        providerFactory: factory,
      });

      const report = await session.run();
      expect(report.taskReports).toHaveLength(1);
      expect(report.taskReports[0].status).toBe('failed');
    });

    it('should retry on failure when configured', async () => {
      await writeFile(join(tmpDir, 'CLAUDE.md'), '', 'utf-8');
      await writeFile(join(tmpDir, 'TODO.md'), '- [ ] Flaky task', 'utf-8');
      await writeFile(join(tmpDir, 'LAST_SESSION.md'), '', 'utf-8');

      let callCount = 0;
      const factory = (): LLMProvider => ({
        execute: async () => {
          callCount++;
          if (callCount === 1) throw new Error('Transient error');
          return createMockResult({ result: 'Worked on retry.' });
        },
      } as unknown as LLMProvider);

      const session = new DevSession({
        projectDir: tmpDir,
        onFailure: 'retry',
        providerFactory: factory,
      });

      const report = await session.run();
      expect(report.taskReports).toHaveLength(1);
      expect(report.taskReports[0].status).toBe('completed');
      expect(callCount).toBe(2);
    });

    it('should include retry error in retry prompt', async () => {
      await writeFile(join(tmpDir, 'CLAUDE.md'), '', 'utf-8');
      await writeFile(join(tmpDir, 'TODO.md'), '- [ ] Retry task', 'utf-8');
      await writeFile(join(tmpDir, 'LAST_SESSION.md'), '', 'utf-8');

      let callCount = 0;
      const prompts: string[] = [];
      const factory = (): LLMProvider => ({
        execute: async (params: Record<string, unknown>) => {
          prompts.push(params.prompt as string);
          callCount++;
          if (callCount === 1) throw new Error('Specific failure reason');
          return createMockResult();
        },
      } as unknown as LLMProvider);

      const session = new DevSession({
        projectDir: tmpDir,
        onFailure: 'retry',
        providerFactory: factory,
      });

      await session.run();
      // The retry prompt (second call) should contain the error
      expect(prompts[1]).toContain('Retry Context');
      expect(prompts[1]).toContain('Specific failure reason');
    });
  });

  describe('provider configuration', () => {
    it('should pass correct config to provider factory', async () => {
      await writeFile(join(tmpDir, 'CLAUDE.md'), '', 'utf-8');
      await writeFile(join(tmpDir, 'TODO.md'), '- [ ] Test task', 'utf-8');
      await writeFile(join(tmpDir, 'LAST_SESSION.md'), '', 'utf-8');

      const { factory, factoryCalls } = createMockProviderFactory([createMockResult()]);

      const session = new DevSession({
        projectDir: tmpDir,
        model: 'sonnet',
        maxBudgetUsd: 2.5,
        providerFactory: factory,
      });

      await session.run();

      expect(factoryCalls).toHaveLength(1);
      expect(factoryCalls[0].permissionMode).toBe('bypassPermissions');
      expect(factoryCalls[0].cwd).toBe(tmpDir);
      expect(factoryCalls[0].addDirs).toEqual([tmpDir]);
      expect(factoryCalls[0].timeout).toBe(600_000);
      expect(factoryCalls[0].model).toBe('sonnet');
      expect(factoryCalls[0].maxBudgetUsd).toBe(2.5);
    });

    it('should pass cwd and addDirs in execute params', async () => {
      await writeFile(join(tmpDir, 'CLAUDE.md'), '', 'utf-8');
      await writeFile(join(tmpDir, 'TODO.md'), '- [ ] Test task', 'utf-8');
      await writeFile(join(tmpDir, 'LAST_SESSION.md'), '', 'utf-8');

      const { factory, executeCalls } = createMockProviderFactory([createMockResult()]);

      const session = new DevSession({
        projectDir: tmpDir,
        providerFactory: factory,
      });

      await session.run();

      expect(executeCalls).toHaveLength(1);
      expect(executeCalls[0].cwd).toBe(tmpDir);
      expect(executeCalls[0].addDirs).toEqual([tmpDir]);
      expect(executeCalls[0].permissionMode).toBe('bypassPermissions');
    });
  });

  describe('report', () => {
    it('should aggregate cost correctly', async () => {
      await writeFile(join(tmpDir, 'CLAUDE.md'), '', 'utf-8');
      await writeFile(join(tmpDir, 'TODO.md'), [
        '- [ ] Task A',
        '- [ ] Task B',
      ].join('\n'), 'utf-8');
      await writeFile(join(tmpDir, 'LAST_SESSION.md'), '', 'utf-8');

      const { factory } = createMockProviderFactory([
        createMockResult({ costUsd: 0.10 }),
        createMockResult({ costUsd: 0.25 }),
      ]);

      const session = new DevSession({
        projectDir: tmpDir,
        providerFactory: factory,
      });

      const report = await session.run();
      expect(report.totalCostUsd).toBeCloseTo(0.35);
    });

    it('should include status counts in summary', async () => {
      await writeFile(join(tmpDir, 'CLAUDE.md'), '', 'utf-8');
      await writeFile(join(tmpDir, 'TODO.md'), [
        '- [ ] Pass task',
        '- [ ] Fail task',
      ].join('\n'), 'utf-8');
      await writeFile(join(tmpDir, 'LAST_SESSION.md'), '', 'utf-8');

      let callCount = 0;
      const factory = (): LLMProvider => ({
        execute: async () => {
          callCount++;
          if (callCount === 2) throw new Error('Nope');
          return createMockResult();
        },
      } as unknown as LLMProvider);

      const session = new DevSession({
        projectDir: tmpDir,
        providerFactory: factory,
      });

      const report = await session.run();
      expect(report.summary).toContain('1 completed');
      expect(report.summary).toContain('1 failed');
    });

    it('should update LAST_SESSION.md', async () => {
      await writeFile(join(tmpDir, 'CLAUDE.md'), '', 'utf-8');
      await writeFile(join(tmpDir, 'TODO.md'), '- [ ] Task X', 'utf-8');
      await writeFile(join(tmpDir, 'LAST_SESSION.md'), 'old content', 'utf-8');

      const { factory } = createMockProviderFactory([createMockResult()]);

      const session = new DevSession({
        projectDir: tmpDir,
        providerFactory: factory,
      });

      await session.run();

      const content = await readFile(join(tmpDir, 'LAST_SESSION.md'), 'utf-8');
      expect(content).toContain('RLM Dev Session');
      expect(content).toContain('Task X');
      expect(content).toContain('old content');
    });
  });
});
