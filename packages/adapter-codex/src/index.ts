import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { eventBase, statusEvent, textFromContent, type AgentAdapter, type AgentEvent, type BackendCapabilities, type BackendDetection, type ResumeOptions, type Runtime, type Session, type StartOptions } from "@session-master/core";

type JsonObject = Record<string, unknown>;
type Listener = (event: AgentEvent) => void;
interface ManagedCodex { client: AppServerClient; runtime: Runtime; threadId: string; turnId: string | undefined }

async function terminateProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off("exit", onExit); child.off("error", onError); };
    const onExit = () => { cleanup(); resolve(true); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    child.once("exit", onExit); child.once("error", onError);
  });
  if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) throw new Error("Failed to signal Codex process");
  if (await waitForExit(5_000)) return;
  if (!child.kill("SIGKILL") && child.exitCode === null && child.signalCode === null) throw new Error("Failed to force-stop Codex process");
  if (!await waitForExit(2_000)) throw new Error("Codex process did not exit after stop request");
}

const capabilities: BackendCapabilities = {
  discoverSessions: true, readHistory: true, nativeResume: true, structuredEvents: true,
  terminalStreaming: true, sendMessage: true, permissions: true, stop: true, crossAgentContinue: true,
};

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

async function jsonLines(path: string): Promise<JsonObject[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).flatMap((line) => {
      try { const value: unknown = JSON.parse(line); return object(value) ? [value as JsonObject] : []; } catch { return []; }
    });
  } catch { return []; }
}

async function headJsonLines(path: string, maxBytes = 262_144): Promise<JsonObject[]> {
  try {
    const handle = await open(path, "r");
    try { const buffer = Buffer.alloc(maxBytes); const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0); return buffer.subarray(0, bytesRead).toString("utf8").split("\n").filter(Boolean).flatMap((line) => { try { const value: unknown = JSON.parse(line); return object(value) ? [value as JsonObject] : []; } catch { return []; } }); }
    finally { await handle.close(); }
  } catch { return []; }
}

class AppServerClient {
  readonly child: ChildProcessWithoutNullStreams;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void }>();
  onMessage?: (message: JsonObject) => void;

  constructor(executable: string) {
    this.child = spawn(executable, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; }
      const value = object(message);
      if (!value) return;
      if (typeof value.id === "number" && ("result" in value || "error" in value)) {
        const pending = this.#pending.get(value.id);
        if (pending) {
          this.#pending.delete(value.id);
          if (value.error) pending.reject(new Error(JSON.stringify(value.error)));
          else pending.resolve(object(value.result) ?? {});
        }
      } else this.onMessage?.(value);
    });
    createInterface({ input: this.child.stderr }).on("line", (line) => this.onMessage?.({ method: "stderr", params: { data: line } }));
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method: string, params: JsonObject = {}): void { this.child.stdin.write(`${JSON.stringify({ method, params })}\n`); }
  respond(id: number | string, result: JsonObject): void { this.child.stdin.write(`${JSON.stringify({ id, result })}\n`); }
  stop(): Promise<void> { return terminateProcess(this.child); }
}

export interface CodexAdapterOptions { home?: string; executable?: string }

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly name = "Codex";
  readonly capabilities = capabilities;
  readonly #home: string;
  #executable: string | undefined;
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #eventBuffer = new Map<string, AgentEvent[]>();
  readonly #runtimes = new Map<string, ManagedCodex>();
  readonly #approvals = new Map<string, { client: AppServerClient; rpcId: number | string }>();
  #sessions?: Session[];

  constructor(options: CodexAdapterOptions = {}) {
    this.#home = options.home ?? join(homedir(), ".codex");
    this.#executable = options.executable;
  }

  async detect(): Promise<BackendDetection> {
    const candidates = [this.#executable, "/Applications/ChatGPT.app/Contents/Resources/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"].filter((item): item is string => Boolean(item));
    for (const executable of candidates) {
      if (!existsSync(executable)) continue;
      const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5_000 });
      if (result.status === 0) {
        this.#executable = executable;
        return { installed: true, available: true, executable, version: result.stdout.trim() };
      }
    }
    const installed = candidates.some(existsSync);
    return { installed, available: false, error: installed ? "Codex launcher exists but is not runnable" : "Codex executable not found" };
  }

  async listSessions(): Promise<Session[]> {
    const names = new Map<string, { title: string; updatedAt?: string }>();
    for (const line of await jsonLines(join(this.#home, "session_index.jsonl"))) {
      if (typeof line.id === "string" && typeof line.thread_name === "string") names.set(line.id, { title: line.thread_name, ...(typeof line.updated_at === "string" ? { updatedAt: line.updated_at } : {}) });
    }
    const root = join(this.#home, "sessions");
    let entries: string[] = [];
    try { entries = (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".jsonl")); } catch { return []; }
    const sessions = await Promise.all(entries.map(async (relative): Promise<Session | undefined> => {
      const sourcePath = join(root, relative);
      const lines = await headJsonLines(sourcePath);
      const metaLine = lines.find((line) => line.type === "session_meta");
      const payload = object(metaLine?.payload);
      const nativeId = typeof payload?.id === "string" ? payload.id : basename(relative).match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0];
      if (!nativeId) return undefined;
      const fileStat = await stat(sourcePath);
      const named = names.get(nativeId);
      const cwd = typeof payload?.cwd === "string" ? payload.cwd : undefined;
      return {
        id: `codex:${nativeId}`, backendId: this.id, nativeSessionId: nativeId,
        title: named?.title ?? firstUserTitle(lines) ?? "Untitled Codex session",
        ...(cwd ? { cwd, projectName: basename(cwd) } : {}),
        createdAt: typeof payload?.timestamp === "string" ? payload.timestamp : fileStat.birthtime.toISOString(),
        updatedAt: named?.updatedAt ?? fileStat.mtime.toISOString(), status: "idle", metadata: { sourcePath },
      };
    }));
    this.#sessions = sessions.filter((session): session is Session => Boolean(session)).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return this.#sessions;
  }

  async getSession(sessionId: string): Promise<Session> {
    const session = (this.#sessions ?? await this.listSessions()).find((item) => item.id === sessionId);
    if (!session) throw new Error(`Codex session not found: ${sessionId}`);
    const runtime = [...this.#runtimes.values()].find((item) => item.runtime.sessionId === sessionId)?.runtime;
    return runtime ? { ...session, runtimeId: runtime.id, status: runtime.status === "waiting_permission" ? "waiting_permission" : runtime.status === "running" ? "running" : session.status } : session;
  }

  async getHistory(sessionId: string): Promise<AgentEvent[]> {
    const session = await this.getSession(sessionId);
    const sourcePath = session.metadata?.sourcePath;
    if (typeof sourcePath !== "string") return [];
    return normalizeCodexHistory(await jsonLines(sourcePath), sessionId);
  }

  async start(options: StartOptions): Promise<Runtime> {
    const client = await this.#newClient();
    const result = await client.request("thread/start", { cwd: options.cwd, approvalPolicy: "on-request", sandbox: "workspace-write", experimentalRawEvents: false });
    const thread = object(result.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : undefined;
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
    const sessionId = `codex:${threadId}`;
    const runtime = this.#registerRuntime(client, sessionId, threadId, options.cwd);
    await this.#turn(client, threadId, options.prompt);
    return runtime;
  }

  async resume(sessionId: string, options: ResumeOptions = {}): Promise<Runtime> {
    const session = await this.getSession(sessionId);
    if (!session.nativeSessionId) throw new Error("Codex session has no native id");
    const client = await this.#newClient();
    await client.request("thread/resume", { threadId: session.nativeSessionId, approvalPolicy: "on-request", sandbox: "workspace-write" });
    const runtime = this.#registerRuntime(client, sessionId, session.nativeSessionId, session.cwd);
    if (options.prompt) await this.#turn(client, session.nativeSessionId, options.prompt);
    else this.#emit(sessionId, statusEvent(sessionId, this.id, "waiting_input"));
    return runtime;
  }

  async sendMessage(runtimeId: string, message: string): Promise<void> {
    const managed = this.#runtimes.get(runtimeId);
    if (!managed) throw new Error("Runtime not found");
    await this.#turn(managed.client, managed.threadId, message);
  }

  async approve(requestId: string, option = "accept"): Promise<void> {
    const pending = this.#approvals.get(requestId);
    if (!pending) throw new Error("Approval request not found");
    pending.client.respond(pending.rpcId, { decision: option === "acceptForSession" ? "acceptForSession" : "accept" });
    this.#approvals.delete(requestId);
  }

  async reject(requestId: string): Promise<void> {
    const pending = this.#approvals.get(requestId);
    if (!pending) throw new Error("Approval request not found");
    pending.client.respond(pending.rpcId, { decision: "decline" });
    this.#approvals.delete(requestId);
  }

  async stop(runtimeId: string): Promise<void> {
    const managed = this.#runtimes.get(runtimeId);
    if (!managed) return;
    if (managed.turnId) await managed.client.request("turn/interrupt", { threadId: managed.threadId, turnId: managed.turnId }).catch(() => undefined);
    const previousStatus = managed.runtime.status;
    managed.runtime.status = "stopped";
    try { await managed.client.stop(); } catch (error) { managed.runtime.status = previousStatus; throw error; }
    this.#runtimes.delete(runtimeId);
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set();
    listeners.add(listener); this.#listeners.set(sessionId, listeners);
    for (const event of this.#eventBuffer.get(sessionId) ?? []) listener(event);
    this.#eventBuffer.delete(sessionId);
    return () => listeners.delete(listener);
  }

  async #newClient(): Promise<AppServerClient> {
    if (!this.#executable) {
      const detected = await this.detect();
      if (!detected.available || !detected.executable) throw new Error(detected.error ?? "Codex unavailable");
    }
    const client = new AppServerClient(this.#executable!);
    await client.request("initialize", { clientInfo: { name: "session-master", title: "SessionMaster", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    client.notify("initialized");
    return client;
  }

  #registerRuntime(client: AppServerClient, sessionId: string, threadId: string, cwd?: string): Runtime {
    const runtime: Runtime = { id: randomUUID(), sessionId, backendId: this.id, ...(client.child.pid === undefined ? {} : { pid: client.child.pid }), ...(cwd ? { cwd } : {}), startedAt: new Date().toISOString(), status: "running", transport: "structured", host: "local" };
    const managed: ManagedCodex = { client, runtime, threadId, turnId: undefined };
    this.#runtimes.set(runtime.id, managed);
    client.onMessage = (message) => this.#handle(managed, message);
    client.child.once("exit", (code) => {
      if (runtime.status !== "stopped") runtime.status = code === 0 ? "completed" : "failed";
      this.#emit(sessionId, statusEvent(sessionId, this.id, runtime.status === "failed" ? "failed" : "completed"));
    });
    this.#emit(sessionId, statusEvent(sessionId, this.id, "running"));
    return runtime;
  }

  async #turn(client: AppServerClient, threadId: string, message: string): Promise<void> {
    this.#emit(`codex:${threadId}`, { ...eventBase(`codex:${threadId}`, this.id), type: "user_message", content: message });
    await client.request("turn/start", { threadId, input: [{ type: "text", text: message, text_elements: [] }] });
  }

  #handle(managed: ManagedCodex, message: JsonObject): void {
    const method = typeof message.method === "string" ? message.method : "";
    const params = object(message.params) ?? {};
    const sessionId = managed.runtime.sessionId;
    if (typeof message.id === "number" || typeof message.id === "string") {
      if (method.includes("requestApproval")) {
        const requestId = `${managed.runtime.id}:${String(message.id)}`;
        this.#approvals.set(requestId, { client: managed.client, rpcId: message.id });
        const command = typeof params.command === "string" ? params.command : Array.isArray(params.command) ? params.command.join(" ") : JSON.stringify(params);
        managed.runtime.status = "waiting_permission";
        this.#emit(sessionId, { ...eventBase(sessionId, this.id), type: "permission_request", requestId, permissionType: method, description: command, options: ["accept", "acceptForSession", "decline"] });
        this.#emit(sessionId, statusEvent(sessionId, this.id, "waiting_permission"));
      }
      return;
    }
    if (method === "turn/started") { managed.turnId = typeof object(params.turn)?.id === "string" ? object(params.turn)?.id as string : undefined; managed.runtime.status = "running"; this.#emit(sessionId, statusEvent(sessionId, this.id, "running")); return; }
    if (method === "turn/completed") { managed.turnId = undefined; managed.runtime.status = "waiting_input"; this.#emit(sessionId, statusEvent(sessionId, this.id, "waiting_input")); return; }
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") { this.#emit(sessionId, { ...eventBase(sessionId, this.id), type: "assistant_message", content: params.delta, partial: true }); return; }
    if (method === "item/commandExecution/outputDelta" && typeof params.delta === "string") { this.#emit(sessionId, { ...eventBase(sessionId, this.id), type: "terminal_output", data: params.delta }); return; }
    if (method === "item/started" || method === "item/completed") { const item = object(params.item); if (item) for (const event of codexItemEvents(item, sessionId, method === "item/completed")) this.#emit(sessionId, event); return; }
    if (method === "error") this.#emit(sessionId, { ...eventBase(sessionId, this.id), type: "error", message: typeof object(params.error)?.message === "string" ? object(params.error)!.message as string : JSON.stringify(params) });
    if (method === "stderr" && typeof params.data === "string" && !params.data.startsWith("WARNING:")) this.#emit(sessionId, { ...eventBase(sessionId, this.id), type: "terminal_output", data: params.data });
  }

  #emit(sessionId: string, event: AgentEvent): void { const listeners = this.#listeners.get(sessionId); if (!listeners?.size) { const buffered = [...(this.#eventBuffer.get(sessionId) ?? []), event].slice(-500); this.#eventBuffer.set(sessionId, buffered); return; } for (const listener of listeners) listener(event); }
}

function firstUserTitle(lines: JsonObject[]): string | undefined {
  for (const line of lines) {
    const payload = object(line.payload);
    if (line.type === "event_msg" && payload?.type === "user_message") {
      const text = (typeof payload.message === "string" ? payload.message : "").replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 80);
    }
  }
  return undefined;
}

export function normalizeCodexHistory(lines: JsonObject[], sessionId: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of lines) {
    const payload = object(line.payload); if (!payload) continue;
    const timestamp = typeof line.timestamp === "string" ? line.timestamp : new Date().toISOString();
    if (line.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
      events.push({ ...eventBase(sessionId, "codex", timestamp), type: "user_message", content: payload.message });
    } else if (line.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
      const content = textFromContent(payload.content); if (!content) continue;
      events.push({ ...eventBase(sessionId, "codex", timestamp), type: "assistant_message", content });
    } else if (line.type === "response_item" && payload.type === "function_call") {
      events.push({ ...eventBase(sessionId, "codex", timestamp), type: "tool_call", toolName: typeof payload.name === "string" ? payload.name : "tool", input: payload.arguments, status: "success" });
    }
  }
  return events;
}

function codexItemEvents(item: JsonObject, sessionId: string, completed: boolean): AgentEvent[] {
  const base = eventBase(sessionId, "codex");
  if (item.type === "commandExecution") return [{ ...base, type: "command", command: String(item.command ?? ""), ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}), ...(typeof item.aggregatedOutput === "string" ? { output: item.aggregatedOutput } : {}), status: completed ? (item.status === "failed" ? "failed" : "success") : "running" }];
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") return [{ ...base, type: "tool_call", toolName: String(item.tool ?? "tool"), input: item.arguments, status: completed ? (item.status === "failed" ? "failed" : "success") : "running" }];
  if (item.type === "reasoning" && Array.isArray(item.summary)) return [{ ...base, type: "reasoning", content: item.summary.filter((part): part is string => typeof part === "string").join("\n") }];
  return [];
}
