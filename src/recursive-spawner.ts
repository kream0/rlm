import { randomUUID } from 'node:crypto';
import type {
  IRecursiveSpawner,
  SpawnConfig,
  VariableRef,
  MergeStrategy,
  AgentTree,
  TokenUsage,
  AgentConfig,
} from './types.js';
import type { AgentRuntime } from './agent-runtime.js';
import type { ContextStore } from './context-store.js';

export interface RecursiveSpawnerOptions {
  runtime: AgentRuntime;
  store: ContextStore;
  defaultModel: string;
  maxDepth: number;
  maxConcurrent: number;
  onLog?: (message: string) => void;
}

interface SpawnedAgent {
  id: string;
  parentId: string | undefined;
  depth: number;
  status: string;
  tokenUsage: TokenUsage;
  children: string[];
  resultRef?: VariableRef;
}

export class RecursiveSpawner implements IRecursiveSpawner {
  private runtime: AgentRuntime;
  private store: ContextStore;
  private defaultModel: string;
  private maxDepth: number;
  private maxConcurrent: number;
  private onLog: (message: string) => void;
  private spawnedAgents = new Map<string, SpawnedAgent>();
  private rootId: string | undefined;
  private activeConcurrent = 0;
  private currentDepth = 0;

  constructor(opts: RecursiveSpawnerOptions) {
    this.runtime = opts.runtime;
    this.store = opts.store;
    this.defaultModel = opts.defaultModel;
    this.maxDepth = opts.maxDepth;
    this.maxConcurrent = opts.maxConcurrent;
    this.onLog = opts.onLog ?? (() => {});
  }

  async spawn(config: SpawnConfig, parentId?: string, depth = 0): Promise<VariableRef> {
    // Check recursion depth
    if (depth >= this.maxDepth) {
      throw new Error(`Maximum recursion depth (${this.maxDepth}) exceeded`);
    }

    // Check concurrency
    if (this.activeConcurrent >= this.maxConcurrent) {
      await this.waitForSlot();
    }

    const agentId = randomUUID();
    this.activeConcurrent++;
    this.currentDepth = Math.max(this.currentDepth, depth);

    // Track the spawned agent
    const spawnedAgent: SpawnedAgent = {
      id: agentId,
      parentId,
      depth,
      status: 'running',
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      children: [],
    };
    this.spawnedAgents.set(agentId, spawnedAgent);

    if (!this.rootId && !parentId) {
      this.rootId = agentId;
    }

    // Add to parent's children
    if (parentId) {
      const parent = this.spawnedAgents.get(parentId);
      if (parent) {
        parent.children.push(agentId);
      }
    }

    this.onLog(`Spawning agent ${agentId} at depth ${depth}${parentId ? ` (parent: ${parentId})` : ''}`);

    // Build context prompt: always persist variables to disk and provide file paths
    let contextPrompt = config.prompt;
    for (const [name, ref] of Object.entries(config.context)) {
      try {
        const filePath = await this.store.persistForSubAgent(ref.key);
        contextPrompt += `\n\nContext variable "${name}" (${ref.sizeBytes} bytes, type: ${ref.type}):`;
        contextPrompt += `\nRead ${filePath}`;
        contextPrompt += `\nThe JSON file has a "value" field with the data.`;
      } catch {
        contextPrompt += `\n\nContext variable "${name}" (ref: ${ref.key}): [not resolvable]`;
      }
    }

    // Create and configure the agent
    const agentConfig: AgentConfig = {
      id: agentId,
      prompt: contextPrompt,
      model: config.model ?? this.defaultModel,
      parentId,
      onComplete: config.onComplete ?? 'return',
    };

    try {
      const agent = this.runtime.create(agentConfig);
      const result = await this.runtime.run(agent);

      // Store the result as a variable
      const resultKey = `sub-result-${agentId}`;
      const resultRef = await this.store.set(resultKey, result.result, {
        type: 'result',
        scope: parentId ? `agent:${parentId}` : 'global',
      });

      // Update tracking
      spawnedAgent.status = 'completed';
      spawnedAgent.tokenUsage = result.tokenUsage;
      spawnedAgent.resultRef = resultRef;

      this.onLog(`Agent ${agentId} completed (iterations: ${result.iterations})`);

      return resultRef;
    } catch (err: unknown) {
      const error = err as Error;
      spawnedAgent.status = 'failed';
      this.onLog(`Agent ${agentId} failed: ${error.message}`);

      // Store error as result
      const resultKey = `sub-result-${agentId}`;
      return this.store.set(resultKey, { error: error.message }, {
        type: 'result',
        scope: parentId ? `agent:${parentId}` : 'global',
      });
    } finally {
      this.activeConcurrent--;
    }
  }

  async spawnMany(configs: SpawnConfig[], parentId?: string, depth = 0): Promise<VariableRef[]> {
    this.onLog(`Spawning ${configs.length} agents in parallel`);

    // Spawn all agents concurrently (respecting maxConcurrent internally)
    const promises = configs.map((config) => this.spawn(config, parentId, depth));
    return Promise.all(promises);
  }

  async merge(refs: VariableRef[], strategy: MergeStrategy): Promise<VariableRef> {
    this.onLog(`Merging ${refs.length} results with strategy: ${strategy.type}`);

    // Resolve all results
    const results: unknown[] = [];
    for (const ref of refs) {
      const value = await this.store.resolve(ref);
      results.push(value);
    }

    let merged: unknown;

    switch (strategy.type) {
      case 'concatenate': {
        const parts = results.map((r) => typeof r === 'string' ? r : JSON.stringify(r));
        merged = parts.join('\n---\n');
        break;
      }

      case 'structured': {
        const obj: Record<string, unknown> = {};
        refs.forEach((ref, i) => {
          obj[ref.key] = results[i];
        });
        merged = obj;
        break;
      }

      case 'vote': {
        const votes = new Map<string, { count: number; value: unknown }>();
        for (const result of results) {
          const key = JSON.stringify(result);
          const existing = votes.get(key);
          if (existing) {
            existing.count++;
          } else {
            votes.set(key, { count: 1, value: result });
          }
        }
        let maxCount = 0;
        let winner: unknown = results[0];
        for (const { count, value } of votes.values()) {
          if (count > maxCount) {
            maxCount = count;
            winner = value;
          }
        }
        merged = { winner, votes: Object.fromEntries(votes) };
        break;
      }

      case 'summarize': {
        const summaryParts = results.map((r, i) => {
          const str = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
          return `[Result ${i + 1} from ${refs[i].key}]:\n${str}`;
        });
        merged = summaryParts.join('\n\n');
        break;
      }

      case 'custom': {
        if (!strategy.customMergeFn) {
          throw new Error('Custom merge strategy requires customMergeFn');
        }
        merged = await strategy.customMergeFn(results);
        break;
      }

      default:
        throw new Error(`Unknown merge strategy: ${strategy.type}`);
    }

    // Store merged result
    const mergedKey = `merged-${randomUUID()}`;
    return this.store.set(mergedKey, merged, { type: 'result', scope: 'global' });
  }

  getTree(): AgentTree {
    if (!this.rootId) {
      return {
        id: 'none',
        status: 'idle',
        children: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        depth: 0,
      };
    }
    return this.buildTree(this.rootId, 0);
  }

  getTotalTokenUsage(): TokenUsage {
    let total: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const agent of this.spawnedAgents.values()) {
      total.inputTokens += agent.tokenUsage.inputTokens;
      total.outputTokens += agent.tokenUsage.outputTokens;
      total.totalTokens += agent.tokenUsage.totalTokens;
    }
    return total;
  }

  getActiveCount(): number {
    return this.activeConcurrent;
  }

  reset(): void {
    this.spawnedAgents.clear();
    this.rootId = undefined;
    this.activeConcurrent = 0;
    this.currentDepth = 0;
  }

  // --- Private helpers ---

  private buildTree(agentId: string, depth: number): AgentTree {
    const agent = this.spawnedAgents.get(agentId);
    if (!agent) {
      return {
        id: agentId,
        status: 'unknown',
        children: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        depth,
      };
    }

    return {
      id: agent.id,
      status: agent.status,
      children: agent.children.map((childId) => this.buildTree(childId, depth + 1)),
      tokenUsage: { ...agent.tokenUsage },
      depth,
    };
  }

  private async waitForSlot(): Promise<void> {
    while (this.activeConcurrent >= this.maxConcurrent) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
