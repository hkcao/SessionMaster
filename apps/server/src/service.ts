import { basename } from "node:path";
import type { AgentAdapter, AgentBackend, AgentEvent, BackendId, Runtime, Session, SessionStatus } from "@session-master/core";
import { BackendRegistry } from "@session-master/core";
import type { LocalStore } from "./store.js";

export interface SessionFilters { backendId?: string; query?: string; status?: string; project?: string }

export class SessionService {
  readonly #registry: BackendRegistry;
  readonly #store: LocalStore;
  readonly #ephemeral = new Map<string, Session>();
  readonly #runtimeAdapters = new Map<string, AgentAdapter>();
  readonly #stoppedRuntimeIds = new Set<string>();
  readonly #permissionAdapters = new Map<string, AgentAdapter>();
  readonly #subscriptions = new Map<string, () => void>();
  readonly #eventListeners = new Set<(event: AgentEvent) => void>();
  #sessions: Session[] = [];

  constructor(registry: BackendRegistry, store: LocalStore) { this.#registry = registry; this.#store = store; }
  backends(): Promise<AgentBackend[]> { return this.#registry.detectAll(); }

  async refresh(): Promise<Session[]> {
    const groups = await Promise.all(this.#registry.list().map(async (adapter) => {
      try { return await adapter.listSessions(); } catch { return []; }
    }));
    const discovered = groups.flat();
    const byId = new Map(discovered.map((session) => [session.id, session]));
    for (const session of this.#ephemeral.values()) byId.set(session.id, { ...byId.get(session.id), ...session });
    this.#sessions = [...byId.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    this.#store.upsertSessions(this.#sessions);
    for (const session of this.#sessions) this.#subscribe(session);
    return this.#sessions;
  }

  async list(filters: SessionFilters = {}): Promise<Session[]> {
    if (this.#sessions.length === 0) await this.refresh();
    const query = filters.query?.trim().toLocaleLowerCase();
    const candidates = this.#sessions.filter((session) => {
      if (filters.backendId && session.backendId !== filters.backendId) return false;
      if (filters.status && session.status !== filters.status) return false;
      if (filters.project && session.projectName !== filters.project) return false;
      return true;
    });
    if (!query) return candidates;
    const matched = await Promise.all(candidates.map(async (session) => {
      if ([session.title, session.projectName, session.cwd].some((value) => value?.toLocaleLowerCase().includes(query))) return session;
      try {
        const history = await this.history(session.id);
        return history.some((event) => (event.type === "user_message" || event.type === "assistant_message") && event.content.toLocaleLowerCase().includes(query)) ? session : undefined;
      } catch { return undefined; }
    }));
    return matched.filter((session): session is Session => Boolean(session));
  }

  async get(id: string): Promise<Session> {
    const ephemeral = this.#ephemeral.get(id); if (ephemeral) return ephemeral;
    const cached = this.#sessions.find((item) => item.id === id); if (!cached) await this.refresh();
    return this.#registry.get(id.split(":", 1)[0] as BackendId).getSession(id);
  }

  async history(id: string): Promise<AgentEvent[]> { if (this.#ephemeral.has(id) && !this.#sessions.some((item) => item.id === id && item.nativeSessionId)) return []; return this.#registry.get(id.split(":", 1)[0] as BackendId).getHistory(id); }

  async start(backendId: BackendId, cwd: string, prompt: string, title?: string): Promise<{ session: Session; runtime: Runtime }> {
    const adapter = this.#registry.get(backendId); const runtime = await adapter.start({ cwd, prompt, ...(title ? { title } : {}) });
    const session: Session = { id: runtime.sessionId, backendId, title: title ?? prompt.replace(/\s+/g, " ").slice(0, 80), projectName: basename(cwd), cwd, createdAt: runtime.startedAt, updatedAt: runtime.startedAt, status: "running", runtimeId: runtime.id };
    this.#ephemeral.set(session.id, session);
    this.#sessions = [session, ...this.#sessions.filter((item) => item.id !== session.id)];
    this.#store.upsertSessions([session]);
    this.#runtimeAdapters.set(runtime.id, adapter); this.#subscribe(session); return { session, runtime };
  }

  async resume(id: string, prompt?: string): Promise<Runtime> {
    const adapter = this.#registry.get(id.split(":", 1)[0] as BackendId); const runtime = await adapter.resume(id, prompt ? { prompt } : {}); this.#runtimeAdapters.set(runtime.id, adapter); const session = await this.get(id); const resumed = { ...session, runtimeId: runtime.id, status: prompt ? "running" as const : "waiting_input" as const, updatedAt: new Date().toISOString() }; this.#ephemeral.set(id, resumed); this.#sessions = this.#sessions.map((item) => item.id === id ? resumed : item); this.#store.upsertSessions([resumed]); this.#subscribe(resumed); return runtime;
  }

  async message(id: string, message: string): Promise<void> { const session = await this.get(id); if (!session.runtimeId) throw new Error("Session has no managed runtime; resume it first"); const adapter = this.#runtimeAdapters.get(session.runtimeId); if (!adapter) throw new Error("Runtime is not managed by SessionMaster"); await adapter.sendMessage(session.runtimeId, message); }
  async stop(runtimeId: string): Promise<void> {
    const adapter = this.#runtimeAdapters.get(runtimeId);
    if (!adapter) {
      if (this.#stoppedRuntimeIds.has(runtimeId)) return;
      throw new Error("Runtime is not managed by SessionMaster");
    }
    if (!adapter.stop) throw new Error("Runtime cannot be stopped");
    await adapter.stop(runtimeId);
    this.#runtimeAdapters.delete(runtimeId);
    this.#stoppedRuntimeIds.add(runtimeId);

    const now = new Date().toISOString();
    const stopped: Session[] = [];
    this.#sessions = this.#sessions.map((session) => {
      if (session.runtimeId !== runtimeId) return session;
      const { runtimeId: _runtimeId, ...rest } = session;
      const updated = { ...rest, status: "completed" as const, updatedAt: now };
      stopped.push(updated);
      return updated;
    });
    for (const [id, session] of this.#ephemeral) {
      if (session.runtimeId !== runtimeId) continue;
      const { runtimeId: _runtimeId, ...rest } = session;
      const updated = { ...rest, status: "completed" as const, updatedAt: now };
      this.#ephemeral.set(id, updated);
      if (!stopped.some((item) => item.id === id)) stopped.push(updated);
    }
    if (stopped.length) this.#store.upsertSessions(stopped);
  }
  async approve(requestId: string, option?: string): Promise<void> { const adapter = this.#permissionAdapters.get(requestId); if (!adapter?.approve) throw new Error("Permission request not found"); await adapter.approve(requestId, option); this.#permissionAdapters.delete(requestId); }
  async reject(requestId: string): Promise<void> { const adapter = this.#permissionAdapters.get(requestId); if (!adapter?.reject) throw new Error("Permission request not found"); await adapter.reject(requestId); this.#permissionAdapters.delete(requestId); }

  async continueWith(id: string, backendId: BackendId, prompt?: string): Promise<{ session: Session; runtime: Runtime }> {
    const original = await this.get(id); if (!original.cwd) throw new Error("Original session has no workspace path");
    const history = await this.history(id); const context = history.filter((event) => event.type === "user_message" || event.type === "assistant_message").slice(-30).map((event) => `${event.type === "user_message" ? "User" : "Assistant"}: ${event.content}`).join("\n\n");
    const handoff = `Continue a task from ${original.backendId}. This is a new session, not a native resume.\n\nOriginal task: ${original.title ?? "Untitled"}\nWorkspace: ${original.cwd}\n\nRecent context:\n${context}\n\n${prompt ?? "Inspect the current workspace state and continue the unfinished work."}`;
    const result = await this.start(backendId, original.cwd, handoff, `Continued: ${original.title ?? "Untitled"}`);
    result.session.parentSessionId = id; result.session.continuedFromBackend = original.backendId; this.#store.recordContinuation(result.session.id, id, original.backendId); return result;
  }

  onEvent(listener: (event: AgentEvent) => void): () => void { this.#eventListeners.add(listener); return () => this.#eventListeners.delete(listener); }

  #subscribe(session: Session): void {
    if (this.#subscriptions.has(session.id)) return; const adapter = this.#registry.get(session.backendId);
    this.#subscriptions.set(session.id, adapter.subscribe(session.id, (event) => {
      if (event.type === "permission_request") this.#permissionAdapters.set(event.requestId, adapter);
      if (event.type === "status_changed") this.#applyStatus(event.sessionId, event.status);
      for (const listener of this.#eventListeners) listener(event);
    }));
  }

  #applyStatus(id: string, status: SessionStatus): void { const index = this.#sessions.findIndex((item) => item.id === id); if (index >= 0) this.#sessions[index] = { ...this.#sessions[index]!, status, updatedAt: new Date().toISOString() }; const ephemeral = this.#ephemeral.get(id); if (ephemeral) this.#ephemeral.set(id, { ...ephemeral, status, updatedAt: new Date().toISOString() }); }
}
