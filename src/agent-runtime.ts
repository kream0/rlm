import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type {
  IAgentRuntime,
  AgentConfig,
  Agent,
  AgentResult,
  AgentStatus,
  TokenUsage,
  IContextStore,
  IFunctionRegistry,
  ToolDefinition,
  LLMContentBlock,
} from './types.js';

export interface AgentRuntimeOptions {
  apiKey?: string;
  store: IContextStore;
  registry: IFunctionRegistry;
  onLog?: (agentId: string, message: string) => void;
  anthropicClient?: Anthropic;
}

export class AgentRuntime implements IAgentRuntime {
  private agents = new Map<string, Agent>();
  private client: Anthropic;
  private store: IContextStore;
  private registry: IFunctionRegistry;
  private onLog: (agentId: string, message: string) => void;
  private terminationSignals = new Map<string, unknown>();

  constructor(opts: AgentRuntimeOptions) {
    this.client = opts.anthropicClient ?? new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
    this.store = opts.store;
    this.registry = opts.registry;
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

    const childResults: AgentResult[] = [];
    const maxIterations = agent.config.maxIterations ?? 100;

    // Build conversation messages
    const messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }> = [];

    // Initial user message with the task
    let initialContent = agent.config.prompt;
    if (agent.config.contextRef) {
      try {
        const contextSummary = await this.store.summarize(agent.config.contextRef.key, 500);
        initialContent += `\n\nContext variable "${agent.config.contextRef.key}" (${agent.config.contextRef.sizeBytes} bytes, type: ${agent.config.contextRef.type}):\n${contextSummary}`;
      } catch {
        // Context ref might not be resolvable
      }
    }
    messages.push({ role: 'user', content: initialContent });

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(agent);

    // Get tool definitions from registry
    const tools = this.registry.toToolDefinitions();

    try {
      for (let i = 0; i < maxIterations; i++) {
        if (agent.cancelled) {
          agent.status = 'cancelled';
          break;
        }

        agent.iterations = i + 1;
        this.onLog(agent.id, `Iteration ${i + 1}/${maxIterations}`);

        // Call the LLM
        const response = await this.callLLM(agent, systemPrompt, messages, tools);

        // Track token usage
        agent.tokenUsage.inputTokens += response.usage.inputTokens;
        agent.tokenUsage.outputTokens += response.usage.outputTokens;
        agent.tokenUsage.totalTokens += response.usage.inputTokens + response.usage.outputTokens;

        // Process response content
        const assistantContent: ContentBlock[] = [];
        let hasToolUse = false;
        let terminated = false;

        for (const block of response.content) {
          if (block.type === 'text') {
            assistantContent.push({ type: 'text', text: block.text });
            this.onLog(agent.id, `Agent says: ${block.text.slice(0, 200)}`);
          } else if (block.type === 'tool_use') {
            hasToolUse = true;
            assistantContent.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            });
          }
        }

        // Add assistant response to conversation
        messages.push({ role: 'assistant', content: assistantContent });

        // If there are tool calls, execute them
        if (hasToolUse) {
          const toolResults: ContentBlock[] = [];

          for (const block of assistantContent) {
            if (block.type !== 'tool_use') continue;

            this.onLog(agent.id, `Calling tool: ${block.name}`);
            let result: unknown;

            try {
              // Check for termination signals
              if (block.name === 'return_result') {
                const value = tryParseJSON((block.input as Record<string, string>).value || '');
                this.terminationSignals.set(agent.id, value);
                result = { returned: true };
                terminated = true;
              } else if (block.name === 'final_answer') {
                const value = (block.input as Record<string, string>).result || '';
                this.terminationSignals.set(agent.id, value);
                result = { terminated: true };
                terminated = true;
              } else {
                result = await this.registry.execute(
                  block.name,
                  block.input as Record<string, unknown>,
                );
              }
            } catch (err: unknown) {
              const error = err as Error;
              result = { error: error.message };
              this.onLog(agent.id, `Tool error: ${error.message}`);
            }

            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: resultStr,
            });
          }

          // Add tool results to conversation
          messages.push({ role: 'user', content: toolResults });
        }

        // Check termination
        if (terminated || this.terminationSignals.has(agent.id)) {
          agent.result = this.terminationSignals.get(agent.id);
          agent.status = 'completed';
          this.terminationSignals.delete(agent.id);
          this.onLog(agent.id, `Agent completed with result`);
          break;
        }

        // Check custom termination function
        if (agent.config.terminationFn) {
          const lastText = assistantContent.find((b) => b.type === 'text');
          if (lastText && lastText.type === 'text' && agent.config.terminationFn(lastText.text)) {
            agent.result = lastText.text;
            agent.status = 'completed';
            break;
          }
        }

        // If no tool calls and stop reason is end_turn, agent is done
        if (!hasToolUse && response.stopReason === 'end_turn') {
          const textContent = assistantContent
            .filter((b): b is TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          agent.result = textContent;
          agent.status = 'completed';
          break;
        }
      }

      // If we exhausted iterations
      if (agent.status === 'running') {
        agent.status = 'completed';
        agent.result = { maxIterationsReached: true, iterations: agent.iterations };
        this.onLog(agent.id, `Max iterations reached: ${maxIterations}`);
      }
    } catch (err: unknown) {
      const error = err as Error;
      agent.status = 'failed';
      agent.result = { error: error.message };
      this.onLog(agent.id, `Agent failed: ${error.message}`);
    }

    // Store result in context store
    if (agent.result !== undefined) {
      const resultKey = `agent-result-${agent.id}`;
      await this.store.set(resultKey, agent.result, {
        type: 'result',
        scope: agent.config.parentId ? `agent:${agent.config.parentId}` : 'global',
      });
    }

    return {
      agentId: agent.id,
      result: agent.result,
      tokenUsage: { ...agent.tokenUsage },
      iterations: agent.iterations,
      children: childResults,
    };
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

  // --- Private helpers ---

  private buildSystemPrompt(agent: Agent): string {
    const parts: string[] = [
      'You are an agent in the Recursive Language Model (RLM) system.',
      'You are hooked directly to a REPL. You operate in a loop: read context, decide action, execute, observe result, repeat.',
      '',
      'Key principles:',
      '- You are NOT a chatbot. You are a recursive computational system.',
      '- Variables are stored by reference. Use store_ref to pass data to sub-agents without loading it.',
      '- The user is a callable function, not a privileged conversation partner.',
      '- You can spawn sub-agents to handle subtasks in their own context windows.',
      '- When done, call return_result (if sub-agent) or final_answer (if top-level).',
      '',
      'Available function scopes:',
      '- Core: store_set, store_get, store_ref, store_list, store_summarize, shell, read_file, write_file',
      '- Agent: spawn_agent, return_result',
      '- User: ask_user, notify_user, final_answer',
    ];

    if (agent.config.parentId) {
      parts.push('', `You are a sub-agent of agent ${agent.config.parentId}.`);
      parts.push('When you have completed your task, call return_result with your findings.');
    } else {
      parts.push('', 'You are a top-level agent. Use final_answer to present results to the user.');
    }

    return parts.join('\n');
  }

  private async callLLM(
    agent: Agent,
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>,
    tools: ToolDefinition[],
  ): Promise<{ content: ResponseBlock[]; stopReason: string; usage: TokenUsage }> {
    // Convert tools to Anthropic format
    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool['input_schema'],
    }));

    // Convert messages to Anthropic format
    const anthropicMessages = messages.map((m) => {
      if (typeof m.content === 'string') {
        return { role: m.role as 'user' | 'assistant', content: m.content };
      }
      return {
        role: m.role as 'user' | 'assistant',
        content: m.content.map((block) => {
          if (block.type === 'text') {
            return { type: 'text' as const, text: block.text };
          } else if (block.type === 'tool_use') {
            return {
              type: 'tool_use' as const,
              id: block.id,
              name: block.name,
              input: block.input,
            };
          } else if (block.type === 'tool_result') {
            return {
              type: 'tool_result' as const,
              tool_use_id: block.tool_use_id,
              content: block.content,
            };
          }
          return block;
        }),
      };
    });

    const response = await this.client.messages.create({
      model: agent.config.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: anthropicMessages as Anthropic.MessageParam[],
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
    });

    const content: ResponseBlock[] = response.content.map((block) => {
      if (block.type === 'text') {
        return { type: 'text' as const, text: block.text };
      } else if (block.type === 'tool_use') {
        return {
          type: 'tool_use' as const,
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      }
      return block as unknown as ResponseBlock;
    });

    return {
      content,
      stopReason: response.stop_reason ?? 'end_turn',
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }
}

// Content block types for internal use
type TextBlock = { type: 'text'; text: string };
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string };
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
type ResponseBlock = TextBlock | ToolUseBlock;

function tryParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
