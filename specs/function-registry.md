# Function Registry Specification

## Purpose

The Function Registry manages all callable functions available to agents. In the RLM paradigm, everything is a function: tools, the human user, sub-LLMs, and even the agent itself. The user is demoted from "privileged conversation partner" to "a callable function within the environment."

## Requirements

### Built-in Functions

Every agent has access to these core functions:

#### Context Functions
- `store_set(key, value)` - Store a variable
- `store_get(key)` - Retrieve a variable
- `store_ref(key)` - Get a reference handle
- `store_list()` - List all variables
- `store_summarize(key)` - Get a summary of a variable

#### Execution Functions
- `shell(command)` - Execute a shell command
- `read_file(path)` - Read a file
- `write_file(path, content)` - Write a file
- `edit_file(path, edits)` - Edit a file

#### Agent Functions
- `spawn_agent(prompt, context)` - Spawn a sub-agent
- `spawn_many(configs)` - Spawn multiple sub-agents
- `return_result(value)` - Return a result to parent and terminate
- `call_llm(prompt, context)` - Make a one-shot LLM call (no agent loop)

#### User Functions
- `ask_user(question)` - Ask the human user a question (blocks until response)
- `notify_user(message)` - Send a notification (non-blocking)
- `final_answer(result)` - Present the final result to the user and terminate

### Custom Functions

Users can register custom functions:
```typescript
registry.register({
  name: 'search_web',
  description: 'Search the web for information',
  parameters: {
    query: { type: 'string', description: 'Search query' }
  },
  handler: async (params) => {
    // Implementation
    return results;
  }
});
```

### Function-to-Tool Translation

Functions are automatically translated to LLM tool definitions:
```typescript
// Registry entry becomes:
{
  name: "ask_user",
  description: "Ask the human user a question. The user is a function in this system. Use this when you need human input or judgment.",
  input_schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask" }
    },
    required: ["question"]
  }
}
```

### User-as-Function

The human user is treated as a callable function:
- `ask_user()` blocks the agent loop until the user responds
- `notify_user()` sends a message without blocking
- `final_answer()` presents the result and terminates the agent
- The user function has higher latency than other functions (human response time)
- Agents should minimize user calls and batch questions when possible

### Function Scoping

- **Core functions**: Available to all agents (store, shell, files)
- **Agent functions**: Available to agents that can spawn (spawn, return_result)
- **User functions**: Available only to top-level agents (ask_user, final_answer)
- **Custom functions**: Registered per-agent or globally

## Interface

```typescript
interface FunctionRegistry {
  register(spec: FunctionSpec): void;
  unregister(name: string): void;
  get(name: string): FunctionSpec;
  list(scope?: string): FunctionSpec[];
  toToolDefinitions(): ToolDefinition[];  // For LLM API
  execute(name: string, params: unknown): Promise<unknown>;
}

interface FunctionSpec {
  name: string;
  description: string;
  parameters: Record<string, ParameterSpec>;
  handler: (params: any) => Promise<any>;
  scope?: 'core' | 'agent' | 'user' | 'custom';
}
```
