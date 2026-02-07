import { randomUUID } from 'node:crypto';
import type {
  IRecursiveSpawner,
  SpawnConfig,
  VariableRef,
  MergeStrategy,
  AgentTree,
  TokenUsage,
  IContextStore,
  AgentConfig,
  AgentResult,
  FunctionSpec,
} from './types.js';
import type { AgentRuntime } from './agent-runtime.js';
import type { FunctionRegistry } from './function-registry.js';

export interface RecursiveSpawnerOptions {
  runtime: AgentRuntime;
  store: IContextStore;
  registry: FunctionRegistry;
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
  private store: IContextStore;
  private registry: FunctionRegistry;
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
    this.registry = opts.registry;
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
      // Wait for a slot to open
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

    // Build context summary for the agent
    let contextPrompt = config.prompt;
    for (const [name, ref] of Object.entries(config.context)) {
      try {
        const summary = await this.store.summarize(ref.key, 200);
        contextPrompt += `\n\nContext variable "${name}" (ref: ${ref.key}, ${ref.sizeBytes} bytes, type: ${ref.type}): ${summary}`;
      } catch {
        contextPrompt += `\n\nContext variable "${name}" (ref: ${ref.key}): [not resolvable]`;
      }
    }

    // Create agent functions that allow this sub-agent to spawn its own children
    const childSpawner = this;
    const agentFunctions: FunctionSpec[] = [
      {
        name: 'spawn_agent',
        description: 'Spawn a sub-agent with its own prompt and context.',
        parameters: {
          prompt: { type: 'string', description: 'Instructions for the sub-agent', required: true },
          context_keys: { type: 'string', description: 'Comma-separated list of variable keys to pass as context', required: false, default: '' },
        },
        handler: async (params) => {
          const contextKeys = (params.context_keys as string || '').split(',').filter(Boolean);
          const subContext: Record<string, VariableRef> = {};
          for (const key of contextKeys) {
            const trimmedKey = key.trim();
            if (this.store.has(trimmedKey)) {
              subContext[trimmedKey] = this.store.ref(trimmedKey);
            }
          }
          const resultRef = await childSpawner.spawn(
            {
              prompt: params.prompt as string,
              context: subContext,
              model: config.model,
              maxIterations: config.maxIterations,
            },
            agentId,
            depth + 1,
          );
          return { spawned: true, resultRef };
        },
        scope: 'agent',
      },
      {
        name: 'return_result',
        description: 'Return a result to the parent agent and terminate.',
        parameters: {
          value: { type: 'string', description: 'The result to return', required: true },
        },
        handler: async (params) => {
          return { returned: true, value: params.value };
        },
        scope: 'agent',
      },
    ];

    // Create and configure the agent
    const agentConfig: AgentConfig = {
      id: agentId,
      prompt: contextPrompt,
      model: config.model ?? this.defaultModel,
      maxIterations: config.maxIterations ?? 20,
      parentId,
      onComplete: config.onComplete ?? 'return',
      functions: [...this.registry.list('core'), ...agentFunctions],
    };

    // Register the agent-specific functions temporarily
    for (const fn of agentFunctions) {
      const scopedName = `${fn.name}_${agentId.slice(0, 8)}`;
      if (!this.registry.has(scopedName)) {
        this.registry.register({ ...fn, name: scopedName });
      }
    }

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

      this.onLog(`Agent ${agentId} completed (tokens: ${result.tokenUsage.totalTokens}, iterations: ${result.iterations})`);

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
      // Clean up scoped functions
      for (const fn of agentFunctions) {
        const scopedName = `${fn.name}_${agentId.slice(0, 8)}`;
        if (this.registry.has(scopedName)) {
          this.registry.unregister(scopedName);
        }
      }
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
        // Join all results as strings
        const parts = results.map((r) => typeof r === 'string' ? r : JSON.stringify(r));
        merged = parts.join('\n---\n');
        break;
      }

      case 'structured': {
        // Each result is a field in the merged object
        const obj: Record<string, unknown> = {};
        refs.forEach((ref, i) => {
          obj[ref.key] = results[i];
        });
        merged = obj;
        break;
      }

      case 'vote': {
        // Count occurrences of each result (stringified for comparison)
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
        // Return the most common result
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
        // Create a text summary of all results
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
    // Simple polling wait - in production would use a semaphore
    while (this.activeConcurrent >= this.maxConcurrent) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
