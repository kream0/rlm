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
}

export interface IFunctionRegistry {
  register(spec: FunctionSpec): void;
  unregister(name: string): void;
  get(name: string): FunctionSpec;
  list(): FunctionSpec[];
  execute(name: string, params: Record<string, unknown>): Promise<unknown>;
}

// --- Token Tracking ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// --- LLM Provider ---

export interface ExecutionResult {
  result: string;
  costUsd?: number;
  durationMs?: number;
  sessionId?: string;
  numTurns?: number;
}

export interface LLMProvider {
  execute(params: {
    prompt: string;
    model?: string;
    maxBudgetUsd?: number;
    permissionMode?: string;
  }): Promise<ExecutionResult>;
}

// --- Agent ---

export type AgentStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
export type OnComplete = 'return' | 'merge' | 'store';

export interface AgentConfig {
  id: string;
  prompt: string;
  contextRef?: VariableRef;
  model: string;
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
  costUsd?: number;
  sessionId?: string;
  numTurns?: number;
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
  maxDepth: number;
  maxConcurrent: number;
  tokenBudget: number;
  storageDir: string;
  verbose: boolean;
  claudeBinary?: string;
  claudeMaxBudgetUsd?: number;
  claudeModel?: string;
  claudePermissionMode?: string;
}

export interface RunOptions {
  contextFiles?: string[];
  model?: string;
  maxDepth?: number;
  verbose?: boolean;
}
