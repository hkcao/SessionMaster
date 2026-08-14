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
interface ManagedClaude { child: ChildProcessWithoutNullStreams; runtime: Runtime; inputByRequest: Map<string, unknown> }

async function terminateProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off("exit", onExit); child.off("error", onError); };
    const onExit = () => { cleanup(); resolve(true); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    child.once("exit", onExit); child.once("error", onError);
  });
  if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) throw new Error("Failed to signal Claude process");
  if (await waitForExit(5_000)) return;
  if (!child.kill("SIGKILL") && child.exitCode === null && child.signalCode === null) throw new Error("Failed to force-stop Claude process");
  if (!await waitForExit(2_000)) throw new Error("Claude process did not exit after stop request");
}

const capabilities: BackendCapabilities = {
  discoverSessions: true, readHistory: true, nativeResume: true, structuredEvents: true,
  terminalStreaming: true, sendMessage: true, permissions: true, stop: true, crossAgentContinue: true,
};

function object(value: unknown): JsonObject | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined; }
async function jsonLines(path: string): Promise<JsonObject[]> {
  try { return (await readFile(path, "utf8")).split("\n").filter(Boolean).flatMap((line) => { try { const parsed: unknown = JSON.parse(line); return object(parsed) ? [parsed as JsonObject] : []; } catch { return []; } }); } catch { return []; }
}
async function headJsonLines(path: string, maxBytes = 262_144): Promise<JsonObject[]> {
  try { const handle = await open(path, "r"); try { const buffer = Buffer.alloc(maxBytes); const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0); return buffer.subarray(0, bytesRead).toString("utf8").split("\n").filter(Boolean).flatMap((line) => { try { const parsed: unknown = JSON.parse(line); return object(parsed) ? [parsed as JsonObject] : []; } catch { return []; } }); } finally { await handle.close(); } } catch { return []; }
}

export interface ClaudeAdapterOptions { home?: string; executable?: string }

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code";
  readonly name = "Claude Code";
  readonly capabilities = capabilities;
  readonly #home: string;
  #executable: string;
  #sessions?: Session[];
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #eventBuffer = new Map<string, AgentEvent[]>();
  readonly #runtimes = new Map<string, ManagedClaude>();
  readonly #approvals = new Map<string, { managed: ManagedClaude; nativeRequestId: string }>();

  constructor(options: ClaudeAdapterOptions = {}) { this.#home = options.home ?? join(homedir(), ".claude"); this.#executable = options.executable ?? "/opt/homebrew/bin/claude"; }

  async detect(): Promise<BackendDetection> {
    const candidates = [this.#executable, "/usr/local/bin/claude"].filter((value, index, all) => all.indexOf(value) === index);
    for (const executable of candidates) {
      if (!existsSync(executable)) continue;
      const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5_000 });
      if (result.status === 0) { this.#executable = executable; return { installed: true, available: true, executable, version: result.stdout.trim() }; }
    }
    return { installed: candidates.some(existsSync), available: false, error: "Claude Code executable not found or not runnable" };
  }

  async listSessions(): Promise<Session[]> {
    const root = join(this.#home, "projects"); let entries: string[] = [];
    try { entries = (await readdir(root, { recursive: true })).filter((path) => /^[0-9a-f-]{36}\.jsonl$/i.test(basename(path)) && !path.includes("/subagents/")); } catch { return []; }
    const sessions = await Promise.all(entries.map(async (relative): Promise<Session | undefined> => {
      const sourcePath = join(root, relative); const lines = await headJsonLines(sourcePath); const first = lines.find((line) => line.type === "user" && typeof line.sessionId === "string");
      const nativeId = typeof first?.sessionId === "string" ? first.sessionId : basename(relative, ".jsonl"); if (!nativeId) return undefined;
      const fileStat = await stat(sourcePath); const cwd = typeof first?.cwd === "string" ? first.cwd : undefined; const title = claudeTitle(lines) ?? "Untitled Claude session";
      return { id: `claude-code:${nativeId}`, backendId: this.id, nativeSessionId: nativeId, title, ...(cwd ? { cwd, projectName: basename(cwd) } : {}), createdAt: typeof first?.timestamp === "string" ? first.timestamp : fileStat.birthtime.toISOString(), updatedAt: fileStat.mtime.toISOString(), status: "idle", metadata: { sourcePath } };
    }));
    this.#sessions = sessions.filter((session): session is Session => Boolean(session)).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")); return this.#sessions;
  }

  async getSession(sessionId: string): Promise<Session> {
    const session = (this.#sessions ?? await this.listSessions()).find((item) => item.id === sessionId); if (!session) throw new Error(`Claude session not found: ${sessionId}`);
    const runtime = [...this.#runtimes.values()].find((item) => item.runtime.sessionId === sessionId)?.runtime;
    return runtime ? { ...session, runtimeId: runtime.id, status: runtime.status === "waiting_permission" ? "waiting_permission" : runtime.status === "running" ? "running" : session.status } : session;
  }

  async getHistory(sessionId: string): Promise<AgentEvent[]> { const session = await this.getSession(sessionId); const path = session.metadata?.sourcePath; return typeof path === "string" ? normalizeClaudeHistory(await jsonLines(path), sessionId) : []; }

  async start(options: StartOptions): Promise<Runtime> { const nativeSessionId = randomUUID(); return this.#launch(`claude-code:${nativeSessionId}`, options.cwd, options.prompt, undefined, nativeSessionId); }
  async resume(sessionId: string, options: ResumeOptions = {}): Promise<Runtime> { const session = await this.getSession(sessionId); if (!session.nativeSessionId) throw new Error("Claude session has no native id"); return this.#launch(sessionId, session.cwd ?? process.cwd(), options.prompt, session.nativeSessionId); }

  async sendMessage(runtimeId: string, message: string): Promise<void> { const managed = this.#runtimes.get(runtimeId); if (!managed) throw new Error("Runtime not found"); this.#writeUser(managed, message); }
  async approve(requestId: string): Promise<void> { this.#respondPermission(requestId, "allow"); }
  async reject(requestId: string): Promise<void> { this.#respondPermission(requestId, "deny"); }
  async stop(runtimeId: string): Promise<void> { const managed = this.#runtimes.get(runtimeId); if (!managed) return; const previousStatus = managed.runtime.status; managed.runtime.status = "stopped"; try { await terminateProcess(managed.child); } catch (error) { managed.runtime.status = previousStatus; throw error; } this.#runtimes.delete(runtimeId); }
  subscribe(sessionId: string, listener: Listener): () => void { const listeners = this.#listeners.get(sessionId) ?? new Set(); listeners.add(listener); this.#listeners.set(sessionId, listeners); for (const event of this.#eventBuffer.get(sessionId) ?? []) listener(event); this.#eventBuffer.delete(sessionId); return () => listeners.delete(listener); }

  async #launch(sessionId: string, cwd: string, prompt?: string, resumeId?: string, newSessionId?: string): Promise<Runtime> {
    const detection = await this.detect(); if (!detection.available) throw new Error(detection.error ?? "Claude Code unavailable");
    const args = buildClaudeArgs(resumeId, newSessionId);
    const child = spawn(this.#executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const runtime: Runtime = { id: randomUUID(), sessionId, backendId: this.id, ...(child.pid === undefined ? {} : { pid: child.pid }), cwd, startedAt: new Date().toISOString(), status: "running", transport: "structured", host: "local" };
    const managed: ManagedClaude = { child, runtime, inputByRequest: new Map() }; this.#runtimes.set(runtime.id, managed);
    createInterface({ input: child.stdout }).on("line", (line) => { try { const message: unknown = JSON.parse(line); const value = object(message); if (value) this.#handle(managed, value); } catch { this.#emit(sessionId, { ...eventBase(sessionId, this.id), type: "terminal_output", data: line }); } });
    createInterface({ input: child.stderr }).on("line", (line) => this.#emit(sessionId, { ...eventBase(sessionId, this.id), type: "terminal_output", data: line }));
    child.once("exit", (code) => { if (runtime.status !== "stopped") runtime.status = code === 0 ? "completed" : "failed"; this.#emit(sessionId, statusEvent(sessionId, this.id, runtime.status === "failed" ? "failed" : "completed")); });
    this.#emit(sessionId, statusEvent(sessionId, this.id, "running")); if (prompt) this.#writeUser(managed, prompt); else this.#emit(sessionId, statusEvent(sessionId, this.id, "waiting_input")); return runtime;
  }

  #writeUser(managed: ManagedClaude, message: string): void { managed.runtime.status = "running"; managed.child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: message } })}\n`); this.#emit(managed.runtime.sessionId, { ...eventBase(managed.runtime.sessionId, this.id), type: "user_message", content: message }); this.#emit(managed.runtime.sessionId, statusEvent(managed.runtime.sessionId, this.id, "running")); }

  #handle(managed: ManagedClaude, message: JsonObject): void {
    const sessionId = managed.runtime.sessionId;
    if (message.type === "assistant") { const content = object(message.message)?.content; if (Array.isArray(content)) for (const block of content) { const item = object(block); if (item?.type === "text" && typeof item.text === "string") this.#emit(sessionId, { ...eventBase(sessionId, this.id), type: "assistant_message", content: item.text }); else if (item?.type === "tool_use") this.#emit(sessionId, { ...eventBase(sessionId, this.id), type: "tool_call", toolName: String(item.name ?? "tool"), input: item.input, status: "running" }); } return; }
    if (message.type === "result") { managed.runtime.status = message.is_error ? "failed" : "waiting_input"; this.#emit(sessionId, statusEvent(sessionId, this.id, message.is_error ? "failed" : "waiting_input")); return; }
    if (message.type === "control_request") { const requestId = typeof message.request_id === "string" ? message.request_id : randomUUID(); const request = object(message.request); const input = request?.input; managed.inputByRequest.set(requestId, input); const publicId = `${managed.runtime.id}:${requestId}`; this.#approvals.set(publicId, { managed, nativeRequestId: requestId }); managed.runtime.status = "waiting_permission"; this.#emit(sessionId, { ...eventBase(sessionId, this.id), type: "permission_request", requestId: publicId, permissionType: String(request?.subtype ?? "can_use_tool"), description: `${String(request?.tool_name ?? "tool")}\n${JSON.stringify(input, null, 2)}`, options: ["allow", "deny"] }); this.#emit(sessionId, statusEvent(sessionId, this.id, "waiting_permission")); }
  }

  #respondPermission(requestId: string, behavior: "allow" | "deny"): void { const pending = this.#approvals.get(requestId); if (!pending) throw new Error("Approval request not found"); const input = pending.managed.inputByRequest.get(pending.nativeRequestId); pending.managed.child.stdin.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: pending.nativeRequestId, response: behavior === "allow" ? { behavior, updatedInput: input } : { behavior, message: "Rejected in SessionMaster" } } })}\n`); pending.managed.runtime.status = "running"; this.#approvals.delete(requestId); this.#emit(pending.managed.runtime.sessionId, statusEvent(pending.managed.runtime.sessionId, this.id, "running")); }
  #emit(sessionId: string, event: AgentEvent): void { const listeners = this.#listeners.get(sessionId); if (!listeners?.size) { this.#eventBuffer.set(sessionId, [...(this.#eventBuffer.get(sessionId) ?? []), event].slice(-500)); return; } for (const listener of listeners) listener(event); }
}

export function buildClaudeArgs(resumeId?: string, newSessionId?: string): string[] {
  const args = ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--replay-user-messages", "--permission-mode", "manual"];
  if (resumeId) args.push("--resume", resumeId);
  else if (newSessionId) args.push("--session-id", newSessionId);
  return args;
}

function claudeTitle(lines: JsonObject[]): string | undefined { for (const line of lines) { if (line.type !== "user" || line.isMeta === true) continue; const message = object(line.message); const text = textFromContent(message?.content).replace(/\s+/g, " ").trim(); if (text && !text.startsWith("<")) return text.slice(0, 80); } return undefined; }

export function normalizeClaudeHistory(lines: JsonObject[], sessionId: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of lines) {
    if (line.type !== "user" && line.type !== "assistant") continue; const message = object(line.message); const content = message?.content; const timestamp = typeof line.timestamp === "string" ? line.timestamp : new Date().toISOString();
    if (Array.isArray(content)) for (const block of content) { const item = object(block); if (!item) continue; if (item.type === "text" && typeof item.text === "string") events.push({ ...eventBase(sessionId, "claude-code", timestamp), type: line.type === "user" ? "user_message" : "assistant_message", content: item.text }); else if (item.type === "tool_use") events.push({ ...eventBase(sessionId, "claude-code", timestamp), type: "tool_call", toolName: String(item.name ?? "tool"), input: item.input, status: "success" }); else if (item.type === "tool_result") events.push({ ...eventBase(sessionId, "claude-code", timestamp), type: "tool_result", toolName: "tool", content: textFromContent(item.content), success: item.is_error !== true }); }
    else { const text = textFromContent(content); if (text) events.push({ ...eventBase(sessionId, "claude-code", timestamp), type: line.type === "user" ? "user_message" : "assistant_message", content: text }); }
  }
  return events;
}
