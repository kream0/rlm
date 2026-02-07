import type {
  IFunctionRegistry,
  FunctionSpec,
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

  list(): FunctionSpec[] {
    return Array.from(this.functions.values());
  }

  async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
    const fn = this.get(name);

    for (const [paramName, paramSpec] of Object.entries(fn.parameters)) {
      if (!(paramName in params)) {
        if (paramSpec.default !== undefined) {
          params[paramName] = paramSpec.default;
        } else if (paramSpec.required !== false) {
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
}
