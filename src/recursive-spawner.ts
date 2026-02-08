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
  tokenBudget?: number;
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
  private tokenBudget: number;
  private totalTokensUsed = 0;
  private onLog: (message: string) => void;
  private spawnedAgents = new Map<string, SpawnedAgent>();
  private rootId: string | undefined;
  private activeConcurrent = 0;
  private currentDepth = 0;
  private waitQueue: Array<() => void> = [];

  constructor(opts: RecursiveSpawnerOptions) {
    this.runtime = opts.runtime;
    this.store = opts.store;
    this.defaultModel = opts.defaultModel;
    this.maxDepth = opts.maxDepth;
    this.maxConcurrent = opts.maxConcurrent;
    this.tokenBudget = opts.tokenBudget ?? Infinity;
    this.onLog = opts.onLog ?? (() => {});
  }

  async spawn(config: SpawnConfig, parentId?: string, depth = 0): Promise<VariableRef> {
    // Check recursion depth
    if (depth >= this.maxDepth) {
      throw new Error(`Maximum recursion depth (${this.maxDepth}) exceeded`);
    }

    // Check token budget
    if (this.totalTokensUsed >= this.tokenBudget) {
      throw new Error(
        `Token budget exhausted `
        + `(${this.totalTokensUsed} / ${this.tokenBudget} tokens used)`
      );
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

    // Build context: create a manifest file and pass a single reference
    const manifestPath = await this.createContextManifest(agentId, config.context);
    let contextPrompt = config.prompt;
    if (manifestPath) {
      contextPrompt += `\n\nContext manifest: Read ${manifestPath}`;
      contextPrompt += '\nThe JSON file maps variable names to '
        + '{filePath, sizeBytes, type}. Read each filePath to access '
        + 'the data (look in the "value" field of each JSON file).';
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

      let resultPromise: Promise<import('./types.js').AgentResult> = this.runtime.run(agent);

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
      this.totalTokensUsed += result.tokenUsage.totalTokens;

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
      // Wake up the next waiting spawner, if any
      if (this.waitQueue.length > 0) {
        const next = this.waitQueue.shift()!;
        next();
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

  getTotalTokensUsed(): number {
    return this.totalTokensUsed;
  }

  reset(): void {
    this.spawnedAgents.clear();
    this.rootId = undefined;
    this.activeConcurrent = 0;
    this.currentDepth = 0;
    this.totalTokensUsed = 0;
    // Resolve any pending waiters (they will find slots available)
    for (const resolve of this.waitQueue) {
      resolve();
    }
    this.waitQueue = [];
  }

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

  // --- Private helpers ---

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
      } catch (err: unknown) {
        const error = err as Error;
        this.onLog(
          `Warning: Could not persist context variable `
            + `"${name}" for sub-agent: ${error.message}`
        );
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

  private waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }
}
