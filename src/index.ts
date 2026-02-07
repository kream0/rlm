// RLM - Recursive Language Model
// Public API

export { ContextStore } from './context-store.js';
export { FunctionRegistry } from './function-registry.js';
export { MemoryManager } from './memory-manager.js';
export { AgentRuntime } from './agent-runtime.js';
export type { AgentRuntimeOptions } from './agent-runtime.js';
export { RecursiveSpawner } from './recursive-spawner.js';
export type { RecursiveSpawnerOptions } from './recursive-spawner.js';
export { run, main, getDefaultConfig } from './cli.js';

// Provider export
export { ClaudeCodeProvider } from './claude-code-provider.js';
export type { ClaudeCodeProviderOptions, ClaudeCodeMetadata } from './claude-code-provider.js';

// Re-export all types
export type {
  VariableType,
  VariableRef,
  VariableMeta,
  SetOptions,
  ListFilter,
  IContextStore,
  ParameterSpec,
  FunctionSpec,
  IFunctionRegistry,
  TokenUsage,
  ExecutionResult,
  LLMProvider,
  AgentStatus,
  OnComplete,
  AgentConfig,
  Agent,
  AgentResult,
  IAgentRuntime,
  SpawnConfig,
  MergeStrategyType,
  MergeStrategy,
  AgentTree,
  IRecursiveSpawner,
  MemoryType,
  MemoryEntry,
  KnowledgeEntry,
  ProceduralRule,
  CompactOptions,
  MemoryStats,
  IMemoryManager,
  RLMConfig,
  RunOptions,
} from './types.js';
