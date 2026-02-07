// ============================================================
// RLM - Recursive Language Model - Type Definitions
// ============================================================

// --- Variable Types ---

export type VariableType = 'text' | 'json' | 'memory' | 'result' | 'stream';

export interface VariableRef {
  id: string;
  key: string;
  scope: string; // 'global' | 'agent:{id}' | 'session:{id}'
  type: VariableType;
  sizeBytes: number;
  createdAt: number;
}

export interface VariableMeta {
  key: string;
  type: VariableType;
  scope: string;
  sizeBytes: number;
  createdAt: number;
  persist: boolean;
}

export interface SetOptions {
  scope?: string;
  type?: VariableType;
  persist?: boolean;
}

export interface ListFilter {
  scope?: string;
  type?: VariableType;
}

// --- Context Store ---

export interface IContextStore {
  set(key: string, value: unknown, opts?: SetOptions): Promise<VariableRef>;
  get(key: string): Promise<unknown>;
  ref(key: string): VariableRef;
  resolve(ref: VariableRef): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(filter?: ListFilter): Promise<VariableMeta[]>;
  summarize(key: string, maxTokens?: number): Promise<string>;
  has(key: string): boolean;
  clear(): Promise<void>;
}

// --- Function Registry ---

export interface ParameterSpec {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface FunctionSpec {
  name: string;
  description: string;
  parameters: Record<string, ParameterSpec>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
  scope?: 'core' | 'agent' | 'user' | 'custom';
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface IFunctionRegistry {
  register(spec: FunctionSpec): void;
  unregister(name: string): void;
  get(name: string): FunctionSpec;
  list(scope?: string): FunctionSpec[];
  toToolDefinitions(scope?: string): ToolDefinition[];
  execute(name: string, params: Record<string, unknown>): Promise<unknown>;
}

// --- Token Tracking ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// --- Agent ---

export type AgentStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
export type OnComplete = 'return' | 'merge' | 'store';

export interface AgentConfig {
  id: string;
  prompt: string;
  contextRef?: VariableRef;
  functions: FunctionSpec[];
  model: string;
  maxIterations?: number;
  terminationFn?: (result: unknown) => boolean;
  parentId?: string;
  onComplete?: OnComplete;
}

export interface Agent {
  id: string;
  config: AgentConfig;
  status: AgentStatus;
  iterations: number;
  tokenUsage: TokenUsage;
  result?: unknown;
  cancelled: boolean;
}

export interface AgentResult {
  agentId: string;
  result: unknown;
  tokenUsage: TokenUsage;
  iterations: number;
  children: AgentResult[];
}

export interface IAgentRuntime {
  create(config: AgentConfig): Agent;
  run(agent: Agent): Promise<AgentResult>;
  cancel(agentId: string): Promise<void>;
  getStatus(agentId: string): AgentStatus | undefined;
}

// --- Recursive Spawner ---

export interface SpawnConfig {
  prompt: string;
  context: Record<string, VariableRef>;
  model?: string;
  maxIterations?: number;
  timeout?: number;
  onComplete?: OnComplete;
}

export type MergeStrategyType = 'concatenate' | 'summarize' | 'structured' | 'vote' | 'custom';

export interface MergeStrategy {
  type: MergeStrategyType;
  customMergeFn?: (results: unknown[]) => Promise<unknown>;
}

export interface AgentTree {
  id: string;
  status: string;
  children: AgentTree[];
  tokenUsage: TokenUsage;
  depth: number;
}

export interface IRecursiveSpawner {
  spawn(config: SpawnConfig): Promise<VariableRef>;
  spawnMany(configs: SpawnConfig[]): Promise<VariableRef[]>;
  merge(refs: VariableRef[], strategy: MergeStrategy): Promise<VariableRef>;
  getTree(): AgentTree;
}

// --- Memory Manager ---

export type MemoryType = 'working' | 'episodic' | 'semantic' | 'procedural';

export interface MemoryEntry {
  id: string;
  timestamp: number;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeEntry {
  key: string;
  value: string;
  timestamp?: number;
}

export interface ProceduralRule {
  condition: string;
  action: string;
  timestamp?: number;
}

export interface CompactOptions {
  keepLast?: number;
  summarizeOlder?: boolean;
}

export interface MemoryStats {
  workingMemoryTokens: number;
  episodicEntryCount: number;
  semanticEntryCount: number;
  proceduralRuleCount: number;
  totalStorageBytes: number;
}

export interface IMemoryManager {
  append(type: MemoryType, entry: MemoryEntry): Promise<void>;
  search(type: MemoryType, query: string, limit?: number): Promise<MemoryEntry[]>;
  learn(knowledge: KnowledgeEntry): Promise<void>;
  recall(key: string): Promise<KnowledgeEntry | null>;
  compact(type: MemoryType, opts?: CompactOptions): Promise<void>;
  getStats(): MemoryStats;
  clear(type?: MemoryType): Promise<void>;
}

// --- CLI / Config ---

export interface RLMConfig {
  model: string;
  apiKey: string;
  maxDepth: number;
  maxConcurrent: number;
  maxIterations: number;
  tokenBudget: number;
  storageDir: string;
  verbose: boolean;
}

export interface RunOptions {
  contextFiles?: string[];
  model?: string;
  maxIterations?: number;
  maxDepth?: number;
  verbose?: boolean;
}

// --- LLM Provider ---

export interface LLMProvider {
  chat(params: {
    model: string;
    system: string;
    messages: LLMMessage[];
    tools?: ToolDefinition[];
    maxTokens?: number;
  }): Promise<LLMResponse>;
}

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string | LLMContentBlock[];
}

export type LLMContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface LLMResponse {
  content: LLMContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: TokenUsage;
}
