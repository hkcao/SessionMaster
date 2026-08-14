import type { AgentAdapter, AgentBackend, BackendId } from "./types.js";

export class BackendRegistry {
  readonly #adapters = new Map<BackendId, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    if (this.#adapters.has(adapter.id)) throw new Error(`Backend already registered: ${adapter.id}`);
    this.#adapters.set(adapter.id, adapter);
  }

  get(id: BackendId): AgentAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new Error(`Unknown backend: ${id}`);
    return adapter;
  }

  list(): AgentAdapter[] { return [...this.#adapters.values()]; }

  async detectAll(): Promise<AgentBackend[]> {
    return Promise.all(this.list().map(async (adapter) => {
      try {
        const detection = await adapter.detect();
        return { id: adapter.id, name: adapter.name, capabilities: adapter.capabilities, ...detection };
      } catch (error) {
        return {
          id: adapter.id,
          name: adapter.name,
          installed: false,
          available: false,
          error: error instanceof Error ? error.message : String(error),
          capabilities: adapter.capabilities,
        };
      }
    }));
  }
}
