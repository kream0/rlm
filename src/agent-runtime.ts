import { randomUUID } from 'node:crypto';
import type {
  IAgentRuntime,
  AgentConfig,
  Agent,
  AgentResult,
  AgentStatus,
  IContextStore,
  LLMProvider,
  ExecutionResult,
} from './types.js';

export interface AgentRuntimeOptions {
  provider: LLMProvider;
  store: IContextStore;
  onLog?: (agentId: string, message: string) => void;
}

export class AgentRuntime implements IAgentRuntime {
  private agents = new Map<string, Agent>();
  private provider: LLMProvider;
  private store: IContextStore;
  private onLog: (agentId: string, message: string) => void;

  constructor(opts: AgentRuntimeOptions) {
    this.provider = opts.provider;
    this.store = opts.store;
    this.onLog = opts.onLog ?? (() => {});
  }

  create(config: AgentConfig): Agent {
    const agent: Agent = {
      id: config.id || randomUUID(),
      config,
      status: 'idle',
      iterations: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cancelled: false,
    };
    this.agents.set(agent.id, agent);
    return agent;
  }

  async run(agent: Agent): Promise<AgentResult> {
    agent.status = 'running';
    this.agents.set(agent.id, agent);
    this.onLog(agent.id, `Agent started: ${agent.id}`);

    if (agent.cancelled) {
      agent.status = 'cancelled';
      return {
        agentId: agent.id,
        result: undefined,
        tokenUsage: { ...agent.tokenUsage },
        iterations: 0,
        children: [],
      };
    }

    try {
      // Build prompt with context
      const prompt = await this.buildPrompt(agent);

      // Single call to provider.execute()
      const execResult: ExecutionResult = await this.provider.execute({
        prompt,
        model: agent.config.model,
      });

      agent.iterations = 1;
      agent.result = execResult.result;
      agent.status = 'completed';
      this.onLog(agent.id, `Agent completed with result`);

      // Store result in context store
      const resultKey = `agent-result-${agent.id}`;
      await this.store.set(resultKey, agent.result, {
        type: 'result',
        scope: agent.config.parentId ? `agent:${agent.config.parentId}` : 'global',
      });

      return {
        agentId: agent.id,
        result: agent.result,
        tokenUsage: { ...agent.tokenUsage },
        iterations: agent.iterations,
        children: [],
        costUsd: execResult.costUsd,
        sessionId: execResult.sessionId,
        numTurns: execResult.numTurns,
      };
    } catch (err: unknown) {
      const error = err as Error;
      agent.status = 'failed';
      agent.result = { error: error.message };
      this.onLog(agent.id, `Agent failed: ${error.message}`);

      // Store error result
      const resultKey = `agent-result-${agent.id}`;
      await this.store.set(resultKey, agent.result, {
        type: 'result',
        scope: agent.config.parentId ? `agent:${agent.config.parentId}` : 'global',
      });

      return {
        agentId: agent.id,
        result: agent.result,
        tokenUsage: { ...agent.tokenUsage },
        iterations: agent.iterations,
        children: [],
      };
    }
  }

  async cancel(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.cancelled = true;
      agent.status = 'cancelled';
    }
  }

  getStatus(agentId: string): AgentStatus | undefined {
    return this.agents.get(agentId)?.status;
  }

  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  private async buildPrompt(agent: Agent): Promise<string> {
    let prompt = agent.config.prompt;

    if (agent.config.contextRef) {
      try {
        const contextSummary = await this.store.summarize(agent.config.contextRef.key, 500);
        prompt += `\n\nContext variable "${agent.config.contextRef.key}" (${agent.config.contextRef.sizeBytes} bytes, type: ${agent.config.contextRef.type}):\n${contextSummary}`;
      } catch {
        // Context ref might not be resolvable
      }
    }

    if (agent.config.parentId) {
      prompt += '\n\nYou are a sub-agent. Complete your task and return the result.';
    }

    return prompt;
  }
}
