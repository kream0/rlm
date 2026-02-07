# Agent Runtime Specification

## Purpose

The Agent Runtime is the REPL that hooks the LLM directly to computational execution. No chat UI, no turn-by-turn. The LLM operates in a loop: read context, decide action, execute, observe result, repeat. The context window is a variable it can operate over.

## Requirements

### The REPL Loop

```
LOOP:
  1. Build prompt from: system instructions + context variable + available functions
  2. Send to LLM
  3. Receive response (text + tool calls)
  4. Execute any tool calls
  5. Store results in context store
  6. Update context variable with new observations
  7. Check termination conditions
  8. GOTO 1
```

### Agent Configuration

```typescript
interface AgentConfig {
  id: string;
  prompt: string;                    // The agent's instructions
  contextRef?: VariableRef;          // Reference to its context variable
  functions: FunctionSpec[];         // Available callable functions
  model: string;                    // LLM model to use
  maxIterations?: number;           // Safety limit
  terminationFn?: (result: any) => boolean; // Custom termination check
  parentId?: string;                // If this is a sub-agent
  onComplete?: 'return' | 'merge' | 'store'; // What to do with result
}
```

### Context Variable

Each agent has a `context` variable in the store that it can read and write:
- The agent can append to it (add observations, results)
- The agent can compact it (summarize old entries, remove stale data)
- The agent can fork it (create a sub-context for a sub-agent)
- The context variable IS the agent's memory

### Tool Execution

The runtime executes tool calls in a sandboxed environment:
- **Shell execution**: Run commands, scripts
- **File operations**: Read, write, edit files
- **Store operations**: Get, set, ref, resolve variables
- **Spawn operations**: Create sub-agents
- **User operations**: Call the user function
- **LLM operations**: Call a sub-LLM for reasoning/analysis

### Termination Conditions

An agent terminates when:
1. It calls the `return_result` function
2. It exceeds `maxIterations`
3. Its context window is approaching capacity (triggers compaction or handoff)
4. The parent agent cancels it
5. It calls the `user` function and the user signals stop

### Token Tracking

The runtime tracks token usage per agent:
- Input tokens, output tokens, total tokens
- Context window utilization percentage
- Token budget remaining
- Automatic context compaction when utilization > 70%

## Interface

```typescript
interface AgentRuntime {
  create(config: AgentConfig): Agent;
  run(agent: Agent): Promise<AgentResult>;
  cancel(agentId: string): Promise<void>;
  getStatus(agentId: string): AgentStatus;
}

interface Agent {
  id: string;
  config: AgentConfig;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  iterations: number;
  tokenUsage: TokenUsage;
  result?: unknown;
}

interface AgentResult {
  agentId: string;
  result: unknown;
  tokenUsage: TokenUsage;
  iterations: number;
  children: AgentResult[];  // Results from sub-agents
}
```

## LLM Integration

- Use Anthropic SDK with streaming for responsiveness
- System prompt includes: agent instructions, available functions, context summary
- Tool definitions generated from FunctionSpec[]
- Handle rate limits with exponential backoff
- Support model override per agent (cheap model for simple tasks)
