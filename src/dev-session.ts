import { readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { ClaudeCodeProvider } from './claude-code-provider.js';
import type {
  ParsedTask,
  TaskReport,
  DevSessionReport,
  DevSessionOptions,
  LLMProvider,
  ExecutionResult,
  ClaudeCodeProviderFactoryOpts,
} from './types.js';

// --- TODO.md Parser ---

export function parseTodoMd(content: string): ParsedTask[] {
  const lines = content.split('\n');
  const tasks: ParsedTask[] = [];
  let currentSection = 'General';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track section headers
    const sectionMatch = line.match(/^##\s+(.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    // Match unchecked task lines: - [ ] **Bold Title** - description  OR  - [ ] plain task
    const taskMatch = line.match(/^[-*]\s+\[ \]\s+(.+)/);
    if (!taskMatch) continue;

    const taskContent = taskMatch[1];

    // Try bold title with description: **Title** - description  OR  **Title**: description
    const boldMatch = taskContent.match(/^\*\*(.+?)\*\*\s*[-:]\s*(.+)/);
    if (boldMatch) {
      tasks.push({
        title: boldMatch[1].trim(),
        description: boldMatch[2].trim(),
        section: currentSection,
        lineNumber: i + 1,
        rawLine: line,
      });
    } else {
      // Plain task: - [ ] Do something
      const plainTitle = taskContent.replace(/^\*\*(.+?)\*\*$/, '$1').trim();
      tasks.push({
        title: plainTitle,
        description: '',
        section: currentSection,
        lineNumber: i + 1,
        rawLine: line,
      });
    }
  }

  return tasks;
}

// --- Prompt Builder ---

export function buildDevPrompt(opts: {
  claudeMd: string;
  task: ParsedTask;
  instructions?: string;
  previousResults?: { task: string; summary: string }[];
  retryError?: string;
}): string {
  const sections: string[] = [];

  sections.push(`## Project Rules\n\n${opts.claudeMd}`);

  const taskDesc = opts.task.description
    ? `${opts.task.title}: ${opts.task.description}`
    : opts.task.title;
  sections.push(`## Your Task\n\n${taskDesc}`);

  const defaultInstructions = [
    'Implement the task fully — no stubs or placeholders.',
    'Run tests after making changes (`bun run test` or the project\'s test command).',
    'If tests fail, fix them before finishing.',
    'Check off completed items in TODO.md: change `- [ ]` to `- [x]`.',
    'DO NOT push to remote, delete branches, or run destructive commands.',
    'DO NOT modify files outside the project directory.',
    'When done, output a brief summary of what you changed.',
  ];
  sections.push(`## Instructions\n\n${(opts.instructions ?? defaultInstructions.join('\n')).split('\n').map(l => `- ${l}`).join('\n')}`);

  if (opts.previousResults && opts.previousResults.length > 0) {
    const prevLines = opts.previousResults.map(
      (r, i) => `${i + 1}. **${r.task}**: ${r.summary}`,
    );
    sections.push(`## Previous Agents\n\nThese tasks were already completed by earlier agents in this session:\n\n${prevLines.join('\n')}`);
  }

  if (opts.retryError) {
    sections.push(`## Retry Context\n\nThis task failed on a previous attempt with the following error:\n\n\`\`\`\n${opts.retryError}\n\`\`\`\n\nPlease address this error in your implementation.`);
  }

  return sections.join('\n\n');
}

// --- DevSession ---

export class DevSession {
  private projectDir: string;
  private explicitTasks?: string[];
  private model: string;
  private maxBudgetUsd?: number;
  private verbose: boolean;
  private onFailure: 'continue' | 'stop' | 'retry';
  private providerFactory: (opts: ClaudeCodeProviderFactoryOpts) => LLMProvider;

  constructor(opts: DevSessionOptions) {
    this.projectDir = resolve(opts.projectDir);
    this.explicitTasks = opts.tasks;
    this.model = opts.model ?? 'opus';
    this.maxBudgetUsd = opts.maxBudgetUsd;
    this.verbose = opts.verbose ?? false;
    this.onFailure = opts.onFailure ?? 'continue';
    this.providerFactory = opts.providerFactory ?? defaultProviderFactory;
  }

  private log(msg: string): void {
    if (this.verbose) {
      process.stderr.write(`[RLM dev] ${msg}\n`);
    }
  }

  private async readProjectFile(filename: string): Promise<string> {
    try {
      return await readFile(resolve(this.projectDir, filename), 'utf-8');
    } catch {
      return '';
    }
  }

  private determineTasks(todoContent: string): ParsedTask[] {
    if (this.explicitTasks && this.explicitTasks.length > 0) {
      return this.explicitTasks.map((title, i) => ({
        title,
        description: '',
        section: 'CLI',
        lineNumber: i + 1,
        rawLine: `- [ ] ${title}`,
      }));
    }
    return parseTodoMd(todoContent);
  }

  async executeTask(
    task: ParsedTask,
    prompt: string,
  ): Promise<TaskReport> {
    const startTime = Date.now();

    const provider = this.providerFactory({
      model: this.model,
      maxBudgetUsd: this.maxBudgetUsd,
      permissionMode: 'bypassPermissions',
      cwd: this.projectDir,
      addDirs: [this.projectDir],
      timeout: 600_000, // 10 minutes
    });

    try {
      this.log(`Starting task: ${task.title}`);
      const result = await provider.execute({
        prompt,
        model: this.model,
        maxBudgetUsd: this.maxBudgetUsd,
        permissionMode: 'bypassPermissions',
        cwd: this.projectDir,
        addDirs: [this.projectDir],
      });

      const durationMs = Date.now() - startTime;
      this.log(`Completed task: ${task.title} (${(durationMs / 1000).toFixed(1)}s, $${result.costUsd?.toFixed(4) ?? '?'})`);

      return {
        task,
        status: 'completed',
        agentResult: result,
        costUsd: result.costUsd,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const error = (err as Error).message;
      this.log(`Failed task: ${task.title} — ${error}`);

      return {
        task,
        status: 'failed',
        durationMs,
        error,
      };
    }
  }

  async run(): Promise<DevSessionReport> {
    const startedAt = new Date().toISOString();

    const claudeMd = await this.readProjectFile('CLAUDE.md');
    const todoContent = await this.readProjectFile('TODO.md');
    const tasks = this.determineTasks(todoContent);

    if (tasks.length === 0) {
      this.log('No pending tasks found.');
      return {
        projectDir: this.projectDir,
        startedAt,
        completedAt: new Date().toISOString(),
        tasksAttempted: 0,
        taskReports: [],
        totalCostUsd: 0,
        summary: 'No pending tasks found in TODO.md.',
      };
    }

    this.log(`Found ${tasks.length} task(s) to execute.`);

    const taskReports: TaskReport[] = [];
    const previousResults: { task: string; summary: string }[] = [];

    for (const task of tasks) {
      const prompt = buildDevPrompt({
        claudeMd,
        task,
        previousResults: previousResults.length > 0 ? previousResults : undefined,
      });

      let report = await this.executeTask(task, prompt);

      // Handle retry on failure
      if (report.status === 'failed' && this.onFailure === 'retry') {
        this.log(`Retrying task: ${task.title}`);
        const retryPrompt = buildDevPrompt({
          claudeMd,
          task,
          previousResults: previousResults.length > 0 ? previousResults : undefined,
          retryError: report.error,
        });
        report = await this.executeTask(task, retryPrompt);
      }

      taskReports.push(report);

      // Track completed results for sequential context
      if (report.status === 'completed' && report.agentResult) {
        previousResults.push({
          task: task.title,
          summary: report.agentResult.result.slice(0, 500),
        });
      }

      // Stop on failure if configured
      if (report.status === 'failed' && this.onFailure === 'stop') {
        this.log(`Stopping due to failed task: ${task.title}`);
        break;
      }
    }

    const totalCostUsd = taskReports.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    const completed = taskReports.filter(r => r.status === 'completed').length;
    const failed = taskReports.filter(r => r.status === 'failed').length;
    const completedAt = new Date().toISOString();

    const summary = `Attempted ${taskReports.length}/${tasks.length} tasks: ${completed} completed, ${failed} failed. Total cost: $${totalCostUsd.toFixed(4)}.`;

    // Update LAST_SESSION.md
    await this.updateLastSession(taskReports, summary, startedAt, completedAt);

    const report: DevSessionReport = {
      projectDir: this.projectDir,
      startedAt,
      completedAt,
      tasksAttempted: taskReports.length,
      taskReports,
      totalCostUsd,
      summary,
    };

    this.log(summary);
    return report;
  }

  private async updateLastSession(
    taskReports: TaskReport[],
    summary: string,
    startedAt: string,
    completedAt: string,
  ): Promise<void> {
    const lines: string[] = [
      `## RLM Dev Session — ${startedAt}`,
      '',
      `**Project:** ${basename(this.projectDir)}`,
      `**Completed:** ${completedAt}`,
      `**Summary:** ${summary}`,
      '',
      '### Tasks',
      '',
    ];

    for (const r of taskReports) {
      const icon = r.status === 'completed' ? '[x]' : '[ ]';
      const cost = r.costUsd != null ? ` ($${r.costUsd.toFixed(4)})` : '';
      const duration = r.durationMs != null ? ` (${(r.durationMs / 1000).toFixed(1)}s)` : '';
      lines.push(`- ${icon} **${r.task.title}**${cost}${duration}`);
      if (r.error) {
        lines.push(`  - Error: ${r.error.slice(0, 200)}`);
      }
    }

    lines.push('');

    try {
      const existing = await this.readProjectFile('LAST_SESSION.md');
      const updated = lines.join('\n') + '\n---\n\n' + existing;
      await writeFile(resolve(this.projectDir, 'LAST_SESSION.md'), updated, 'utf-8');
    } catch {
      // Best effort — don't fail the session over this
    }
  }
}

// --- Default provider factory ---

function defaultProviderFactory(opts: ClaudeCodeProviderFactoryOpts): LLMProvider {
  return new ClaudeCodeProvider({
    model: opts.model,
    maxBudgetUsd: opts.maxBudgetUsd,
    permissionMode: opts.permissionMode,
    cwd: opts.cwd,
    addDirs: opts.addDirs,
    timeout: opts.timeout,
  });
}
