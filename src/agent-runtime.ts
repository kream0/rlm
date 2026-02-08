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
  IMemoryManager,
  IFunctionRegistry,
} from './types.js';

export interface AgentRuntimeOptions {
  provider: LLMProvider;
  store: IContextStore;
  memory?: IMemoryManager;
  functions?: IFunctionRegistry;
  onLog?: (agentId: string, message: string) => void;
}

export class AgentRuntime implements IAgentRuntime {
  private agents = new Map<string, Agent>();
  private provider: LLMProvider;
  private store: IContextStore;
  private memory?: IMemoryManager;
  private functions?: IFunctionRegistry;
  private onLog: (agentId: string, message: string) => void;

  constructor(opts: AgentRuntimeOptions) {
    this.provider = opts.provider;
    this.store = opts.store;
    this.memory = opts.memory;
    this.functions = opts.functions;
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
      // Update token usage from execution result
      if (execResult.tokenUsage) {
        agent.tokenUsage = { ...execResult.tokenUsage };
      }
      agent.result = execResult.result;
      agent.status = 'completed';
      this.onLog(agent.id, `Agent completed with result`);

      // Record execution in episodic memory
      if (this.memory) {
        try {
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
        } catch (memErr: unknown) {
          this.onLog(agent.id, `Warning: Failed to log to episodic memory: ${(memErr as Error).message}`);
        }
      }

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

      // Record failure in episodic memory
      if (this.memory) {
        try {
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
        } catch (memErr: unknown) {
          this.onLog(agent.id, `Warning: Failed to log to episodic memory: ${(memErr as Error).message}`);
        }
      }

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
      } catch (err: unknown) {
        const error = err as Error;
        this.onLog(
          agent.id,
          `Warning: Could not resolve context ref `
            + `"${agent.config.contextRef.key}": ${error.message}`
        );
      }
    }

    if (agent.config.parentId) {
      prompt += '\n\nYou are a sub-agent. Complete your task and return the result.';
    }

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

    return prompt;
  }
}
