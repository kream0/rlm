import { execFileSync } from 'node:child_process';
import type {
  IFunctionRegistry,
  FunctionSpec,
  ToolDefinition,
  ParameterSpec,
} from './types.js';

export class FunctionRegistry implements IFunctionRegistry {
  private functions = new Map<string, FunctionSpec>();

  register(spec: FunctionSpec): void {
    if (this.functions.has(spec.name)) {
      throw new Error(`Function already registered: ${spec.name}`);
    }
    this.functions.set(spec.name, spec);
  }

  unregister(name: string): void {
    if (!this.functions.has(name)) {
      throw new Error(`Function not found: ${name}`);
    }
    this.functions.delete(name);
  }

  get(name: string): FunctionSpec {
    const fn = this.functions.get(name);
    if (!fn) {
      throw new Error(`Function not found: ${name}`);
    }
    return fn;
  }

  list(scope?: string): FunctionSpec[] {
    const all = Array.from(this.functions.values());
    if (!scope) return all;
    return all.filter((fn) => fn.scope === scope);
  }

  toToolDefinitions(scope?: string): ToolDefinition[] {
    const fns = this.list(scope);
    return fns.map((fn) => this.functionToTool(fn));
  }

  async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
    const fn = this.get(name);

    for (const [paramName, paramSpec] of Object.entries(fn.parameters)) {
      if (!(paramName in params)) {
        if (paramSpec.default !== undefined) {
          // Apply default for missing optional params
          params[paramName] = paramSpec.default;
        } else if (paramSpec.required !== false) {
          // Required param with no default - error
          throw new Error(`Missing required parameter: ${paramName} for function ${name}`);
        }
      }
    }

    return fn.handler(params);
  }

  clear(): void {
    this.functions.clear();
  }

  has(name: string): boolean {
    return this.functions.has(name);
  }

  private functionToTool(fn: FunctionSpec): ToolDefinition {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [paramName, paramSpec] of Object.entries(fn.parameters)) {
      properties[paramName] = this.paramToSchema(paramSpec);
      if (paramSpec.required !== false) {
        required.push(paramName);
      }
    }

    return {
      name: fn.name,
      description: fn.description,
      input_schema: {
        type: 'object',
        properties,
        required,
      },
    };
  }

  private paramToSchema(spec: ParameterSpec): Record<string, unknown> {
    const schema: Record<string, unknown> = {
      type: spec.type,
      description: spec.description,
    };
    if (spec.default !== undefined) {
      schema.default = spec.default;
    }
    return schema;
  }
}

// --- Built-in function factories ---

export function createCoreFunctions(deps: {
  store: {
    set: (key: string, value: unknown) => Promise<unknown>;
    get: (key: string) => Promise<unknown>;
    ref: (key: string) => unknown;
    list: () => Promise<unknown>;
    summarize: (key: string, maxTokens?: number) => Promise<string>;
  };
}): FunctionSpec[] {
  return [
    {
      name: 'store_set',
      description: 'Store a value as a variable in the context store. Variables persist and can be referenced by other agents without loading their full contents.',
      parameters: {
        key: { type: 'string', description: 'The variable name/key', required: true },
        value: { type: 'string', description: 'The value to store (string or JSON)', required: true },
      },
      handler: async (params) => {
        const value = tryParseJSON(params.value as string);
        const ref = await deps.store.set(params.key as string, value);
        return { stored: true, ref };
      },
      scope: 'core',
    },
    {
      name: 'store_get',
      description: 'Retrieve the full value of a variable from the context store.',
      parameters: {
        key: { type: 'string', description: 'The variable name/key to retrieve', required: true },
      },
      handler: async (params) => {
        const value = await deps.store.get(params.key as string);
        return typeof value === 'string' ? value : JSON.stringify(value);
      },
      scope: 'core',
    },
    {
      name: 'store_ref',
      description: 'Get a lightweight reference handle to a variable. This is what you pass to sub-agents - it contains metadata but NOT the actual value.',
      parameters: {
        key: { type: 'string', description: 'The variable name/key', required: true },
      },
      handler: async (params) => {
        return deps.store.ref(params.key as string);
      },
      scope: 'core',
    },
    {
      name: 'store_list',
      description: 'List all variables in the context store with their metadata (key, type, size, scope).',
      parameters: {},
      handler: async () => {
        return deps.store.list();
      },
      scope: 'core',
    },
    {
      name: 'store_summarize',
      description: 'Get a token-limited summary of a variable. Useful for understanding contents without loading the full value into context.',
      parameters: {
        key: { type: 'string', description: 'The variable name/key', required: true },
        max_tokens: { type: 'number', description: 'Maximum tokens for the summary', required: false, default: 200 },
      },
      handler: async (params) => {
        return deps.store.summarize(params.key as string, params.max_tokens as number | undefined);
      },
      scope: 'core',
    },
  ];
}

export function createExecutionFunctions(): FunctionSpec[] {
  return [
    {
      name: 'shell',
      description: 'Execute a shell command and return its output. Use for running scripts, builds, tests, etc.',
      parameters: {
        command: { type: 'string', description: 'The shell command to execute', required: true },
      },
      handler: async (params) => {
        try {
          // Use execFileSync with shell args array to prevent injection
          const args = ['-c', params.command as string];
          const result = execFileSync('/bin/sh', args, {
            encoding: 'utf-8',
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          });
          return { success: true, output: result };
        } catch (err: unknown) {
          const error = err as { status?: number; stderr?: string; stdout?: string };
          return {
            success: false,
            exitCode: error.status,
            stderr: error.stderr ?? '',
            stdout: error.stdout ?? '',
          };
        }
      },
      scope: 'core',
    },
    {
      name: 'read_file',
      description: 'Read the contents of a file from the filesystem.',
      parameters: {
        path: { type: 'string', description: 'Path to the file to read', required: true },
      },
      handler: async (params) => {
        const { readFile } = await import('node:fs/promises');
        try {
          const content = await readFile(params.path as string, 'utf-8');
          return content;
        } catch (err: unknown) {
          const error = err as Error;
          return { error: error.message };
        }
      },
      scope: 'core',
    },
    {
      name: 'write_file',
      description: 'Write content to a file on the filesystem.',
      parameters: {
        path: { type: 'string', description: 'Path to the file to write', required: true },
        content: { type: 'string', description: 'Content to write', required: true },
      },
      handler: async (params) => {
        const { writeFile } = await import('node:fs/promises');
        try {
          await writeFile(params.path as string, params.content as string, 'utf-8');
          return { success: true };
        } catch (err: unknown) {
          const error = err as Error;
          return { error: error.message };
        }
      },
      scope: 'core',
    },
  ];
}

export function createUserFunctions(deps: {
  onAskUser: (question: string) => Promise<string>;
  onNotifyUser: (message: string) => void;
  onFinalAnswer: (result: unknown) => void;
}): FunctionSpec[] {
  return [
    {
      name: 'ask_user',
      description: 'Ask the human user a question. The user is a callable function in this system. Blocks until the user responds. Use sparingly - batch questions when possible.',
      parameters: {
        question: { type: 'string', description: 'The question to ask the user', required: true },
      },
      handler: async (params) => {
        return deps.onAskUser(params.question as string);
      },
      scope: 'user',
    },
    {
      name: 'notify_user',
      description: 'Send a non-blocking notification to the user. Does not wait for a response.',
      parameters: {
        message: { type: 'string', description: 'The notification message', required: true },
      },
      handler: async (params) => {
        deps.onNotifyUser(params.message as string);
        return { notified: true };
      },
      scope: 'user',
    },
    {
      name: 'final_answer',
      description: 'Present the final result to the user and terminate this agent. This is the last action the agent takes.',
      parameters: {
        result: { type: 'string', description: 'The final result to present', required: true },
      },
      handler: async (params) => {
        deps.onFinalAnswer(params.result);
        return { terminated: true };
      },
      scope: 'user',
    },
  ];
}

export function createAgentFunctions(deps: {
  onSpawn: (prompt: string, context: Record<string, unknown>) => Promise<unknown>;
  onReturnResult: (value: unknown) => void;
}): FunctionSpec[] {
  return [
    {
      name: 'spawn_agent',
      description: 'Spawn a sub-agent with its own prompt and context. The sub-agent runs independently with its own context window and returns a result reference.',
      parameters: {
        prompt: { type: 'string', description: 'Instructions for the sub-agent', required: true },
        context: { type: 'string', description: 'JSON object mapping variable names to their reference keys', required: false, default: '{}' },
      },
      handler: async (params) => {
        const ctx = tryParseJSON(params.context as string || '{}') as Record<string, unknown>;
        return deps.onSpawn(params.prompt as string, ctx);
      },
      scope: 'agent',
    },
    {
      name: 'return_result',
      description: 'Return a result to the parent agent and terminate this agent. Use this when the task is complete.',
      parameters: {
        value: { type: 'string', description: 'The result value to return', required: true },
      },
      handler: async (params) => {
        const value = tryParseJSON(params.value as string);
        deps.onReturnResult(value);
        return { returned: true };
      },
      scope: 'agent',
    },
  ];
}

function tryParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
