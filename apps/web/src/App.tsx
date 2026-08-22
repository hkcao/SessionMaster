import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AgentBackend, AgentEvent, BackendId, Session, SessionStatus } from "@session-master/core";
import { api } from "./api";
import { Markdown } from "./markdown";

const attention = new Set<SessionStatus>(["waiting_input", "waiting_permission", "failed"]);
const backendMark: Record<string, string> = { codex: "C", "claude-code": "A" };
type ThemeName = "neutral" | "blue";
type RenderMode = "raw" | "markdown";

export function App() {
  const [theme, setTheme] = useState<ThemeName>(() => { const saved = localStorage.getItem("sm-theme"); return saved === "blue" || saved === "deepseek" ? "blue" : "neutral"; });
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("sm-theme", theme); }, [theme]);
  const [renderMode, setRenderMode] = useState<RenderMode>(() => localStorage.getItem("sm-render-mode") === "raw" ? "raw" : "markdown");
  useEffect(() => { localStorage.setItem("sm-render-mode", renderMode); }, [renderMode]);
  const [backends, setBackends] = useState<AgentBackend[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedBackend, setSelectedBackend] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [events, setEvents] = useState<Record<string, AgentEvent[]>>({});
  const [query, setQuery] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshState, setRefreshState] = useState<"idle" | "refreshing" | "done">("idle");
  const sessionRequest = useRef(0);
  const loadedHistories = useRef(new Set<string>());

  const applySessions = (items: Session[]) => { setSessions(items); setSelectedId((current) => current ?? items[0]?.id); };
  const load = async () => { const requestId = ++sessionRequest.current; try { const [backendData, sessionData] = await Promise.all([api.backends(), api.sessions(query)]); setBackends(backendData); if (requestId === sessionRequest.current) applySessions(sessionData); } catch (reason) { setError(message(reason)); } };
  useEffect(() => { void api.backends().then(setBackends).catch((reason) => setError(message(reason))); }, []);
  useEffect(() => { const requestId = ++sessionRequest.current; const timer = window.setTimeout(() => { void api.sessions(query).then((items) => { if (requestId === sessionRequest.current) applySessions(items); }).catch((reason) => { if (requestId === sessionRequest.current) setError(message(reason)); }); }, 250); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => { if (!selectedId || loadedHistories.current.has(selectedId)) return; loadedHistories.current.add(selectedId); void api.events(selectedId).then((items) => setEvents((current) => ({ ...current, [selectedId]: mergeEvents(items, current[selectedId] ?? []) }))).catch((reason) => { loadedHistories.current.delete(selectedId); setError(message(reason)); }); }, [selectedId, events]);
  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss" : "ws"; const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    socket.onmessage = (messageEvent) => { const event = JSON.parse(messageEvent.data as string) as AgentEvent; if (event.type === "status_changed") setSessions((current) => current.map((session) => session.id === event.sessionId ? { ...session, status: event.status } : session)); else setEvents((current) => ({ ...current, [event.sessionId]: appendLiveEvent(current[event.sessionId] ?? [], event) })); };
    return () => socket.close();
  }, []);

  const visible = useMemo(() => sessions.filter((session) => selectedBackend === "all" || session.backendId === selectedBackend), [sessions, selectedBackend]);
  const groups = useMemo(() => [
    { label: "Needs attention", sessions: visible.filter((session) => attention.has(session.status)) },
    { label: "Running", sessions: visible.filter((session) => session.status === "running") },
    { label: "Recent", sessions: visible.filter((session) => !attention.has(session.status) && session.status !== "running") },
  ].filter((group) => group.sessions.length), [visible]);
  const selected = sessions.find((session) => session.id === selectedId);

  const act = async (operation: () => Promise<unknown>) => { setBusy(true); setError(undefined); try { await operation(); await load(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } };
  const refresh = async () => {
    setRefreshState("refreshing");
    setError(undefined);
    try {
      await api.refresh();
      loadedHistories.current.clear();
      setEvents({});
      await load();
      setRefreshState("done");
      window.setTimeout(() => setRefreshState("idle"), 1400);
    } catch (reason) {
      setError(message(reason));
      setRefreshState("idle");
    }
  };

  return <main className="shell">
    <aside className="backend-sidebar">
      <div className="seg-switch sidebar-seg" role="group" aria-label="界面风格">
        <button className={theme === "neutral" ? "on" : ""} onClick={() => setTheme("neutral")}>中性风</button>
        <button className={theme === "blue" ? "on" : ""} onClick={() => setTheme("blue")}>浅蓝灰</button>
      </div>
      <div className="brand"><span className="brand-mark">S</span><span>SessionMaster</span></div>
      <nav>
        <BackendButton active={selectedBackend === "all"} mark="⌘" label="All sessions" count={sessions.length} alertCount={sessions.filter((item) => attention.has(item.status)).length} onClick={() => setSelectedBackend("all")} />
        <div className="nav-label">Agents</div>
        {backends.map((backend) => <BackendButton key={backend.id} active={selectedBackend === backend.id} mark={backendMark[backend.id] ?? backend.name[0] ?? "?"} label={backend.name} count={sessions.filter((item) => item.backendId === backend.id).length} alertCount={sessions.filter((item) => item.backendId === backend.id && attention.has(item.status)).length} unavailable={!backend.available} onClick={() => setSelectedBackend(backend.id)} />)}
      </nav>
      <div className="sidebar-footer"><span className="local-dot" />Local only · 127.0.0.1</div>
    </aside>

    <section className="session-panel">
      <header className="panel-header"><div><p className="eyebrow">Workspace</p><h1>{selectedBackend === "all" ? "All sessions" : backends.find((item) => item.id === selectedBackend)?.name}</h1></div><div className="refresh-control" aria-live="polite">{refreshState === "done" && <span className="refresh-feedback">✓ Refreshed</span>}<button className={`icon-button refresh-button ${refreshState === "refreshing" ? "spinning" : ""}`} title={refreshState === "refreshing" ? "Refreshing" : "Refresh"} aria-label={refreshState === "refreshing" ? "Refreshing" : "Refresh sessions"} disabled={refreshState === "refreshing"} onClick={() => void refresh()}>↻</button></div></header>
      <div className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions" /></div>
      <button className="new-button" onClick={() => setNewOpen(true)}>＋ New session</button>
      <div className="session-list">{groups.map((group) => <div key={group.label} className="session-group"><div className="group-title"><span>{group.label}</span><span>{group.sessions.length}</span></div>{group.sessions.map((session) => <SessionCard key={session.id} session={session} selected={session.id === selectedId} onClick={() => setSelectedId(session.id)} />)}</div>)}{!groups.length && <Empty text="No sessions found" />}</div>
    </section>

    <section className="detail-panel">
      {selected ? <SessionDetail session={selected} backend={backends.find((item) => item.id === selected.backendId)} availableBackends={backends.filter((item) => item.available && item.id !== selected.backendId)} events={events[selected.id] ?? []} busy={busy} renderMode={renderMode} onRenderModeChange={setRenderMode} onResume={() => void act(async () => { const runtime = await api.resume(selected.id); setSessions((current) => current.map((item) => item.id === selected.id ? { ...item, runtimeId: runtime.id, status: "waiting_input" } : item)); })} onStop={() => selected.runtimeId && void act(() => api.stop(selected.runtimeId!))} onContinue={(backendId) => void act(async () => { const result = await api.continueWith(selected.id, backendId); setSessions((current) => [result.session, ...current]); setSelectedId(result.session.id); })} onSend={(text) => act(() => api.message(selected.id, text))} onApprove={(id, option) => act(() => api.approve(id, option))} onReject={(id) => act(() => api.reject(id))} /> : <Empty text="Select a session to inspect its history" />}
      {error && <div className="toast" role="alert"><span>{error}</span><button onClick={() => setError(undefined)}>×</button></div>}
    </section>
    {newOpen && <NewSession backends={backends.filter((item) => item.available)} busy={busy} onClose={() => setNewOpen(false)} onCreate={(data) => act(async () => { const result = await api.start(data); setSessions((current) => [result.session, ...current]); setSelectedId(result.session.id); setNewOpen(false); })} />}
  </main>;
}

function BackendButton(props: { active: boolean; mark: string; label: string; count: number; alertCount: number; unavailable?: boolean; onClick: () => void }) { return <button className={`backend-item ${props.active ? "active" : ""}`} onClick={props.onClick}><span className="agent-mark">{props.mark}</span><span className="backend-name">{props.label}{props.unavailable && <small>Unavailable</small>}</span>{props.alertCount > 0 && <span className="attention-count">{props.alertCount}</span>}<span className="count">{props.count}</span></button>; }

function SessionCard({ session, selected, onClick }: { session: Session; selected: boolean; onClick: () => void }) { const status = statusInfo(session.status); return <button className={`session-card ${selected ? "selected" : ""}`} onClick={onClick}><div className="card-top"><span className={`status-symbol ${status.className}`}>{status.symbol}</span><strong>{session.title ?? "Untitled session"}</strong></div><div className="cwd">{session.cwd ?? "Unknown directory"}</div><div className="card-bottom"><span className="mini-agent">{backendMark[session.backendId] ?? "?"}</span><span>{session.backendId === "claude-code" ? "Claude Code" : "Codex"}</span><span className="sep">·</span><span>{status.label}</span><time className="card-date" dateTime={session.updatedAt} title={formatDateTime(session.updatedAt)}>{formatDate(session.updatedAt)}</time></div></button>; }

function SessionDetail(props: { session: Session; backend?: AgentBackend; availableBackends: AgentBackend[]; events: AgentEvent[]; busy: boolean; renderMode: RenderMode; onRenderModeChange: (mode: RenderMode) => void; onResume: () => void; onStop: () => void; onContinue: (id: BackendId) => void; onSend: (text: string) => Promise<unknown>; onApprove: (id: string, option?: string) => Promise<unknown>; onReject: (id: string) => Promise<unknown> }) {
  const [messageText, setMessageText] = useState(""); const [continueOpen, setContinueOpen] = useState(false); const status = statusInfo(props.session.status); const canMessage = Boolean(props.session.runtimeId) && !["completed", "failed"].includes(props.session.status);
  const submit = async (event: FormEvent) => { event.preventDefault(); const text = messageText.trim(); if (!text) return; await props.onSend(text); setMessageText(""); };
  return <div className="detail-wrap"><header className="detail-header"><div className="title-row"><span className="large-agent">{backendMark[props.session.backendId]}</span><div><div className="backend-kicker">{props.backend?.name ?? props.session.backendId}</div><h2>{props.session.title ?? "Untitled session"}</h2><div className="detail-meta"><span>{props.session.cwd ?? "Unknown directory"}</span><span className="sep">·</span><span className={status.className}>{status.symbol} {status.label}</span></div></div></div><div className="header-actions"><div className="seg-switch header-seg" role="group" aria-label="输出渲染方式"><button className={props.renderMode === "raw" ? "on" : ""} onClick={() => props.onRenderModeChange("raw")}>原文</button><button className={props.renderMode === "markdown" ? "on" : ""} onClick={() => props.onRenderModeChange("markdown")}>Markdown</button></div>{!props.session.runtimeId && props.backend?.available && props.backend.capabilities.nativeResume && <button className="primary-small" disabled={props.busy} onClick={props.onResume}>Resume</button>}{props.session.runtimeId && props.backend?.capabilities.stop && <button disabled={props.busy} onClick={props.onStop}>Stop</button>}<div className="menu-wrap"><button disabled={!props.availableBackends.length} onClick={() => setContinueOpen((open) => !open)}>Continue with⌄</button>{continueOpen && <div className="menu">{props.availableBackends.map((backend) => <button key={backend.id} onClick={() => props.onContinue(backend.id)}>{backend.name}</button>)}</div>}</div></div></header>
    {props.session.continuedFromBackend && <div className="continued-banner">Continued from {props.session.continuedFromBackend}</div>}
    <div className="conversation">{props.events.length ? props.events.map((event, index) => <EventView key={`${event.id}-${index}`} event={event} renderMode={props.renderMode} cwd={props.session.cwd} onApprove={props.onApprove} onReject={props.onReject} />) : <Empty text="This session has no displayable events yet" />}</div>
    <form className="composer" onSubmit={(event) => void submit(event)}><textarea value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder={canMessage ? "Message the agent…" : "Resume this session to continue"} disabled={!canMessage || props.busy} rows={1} /><button disabled={!canMessage || !messageText.trim() || props.busy} aria-label="Send">↑</button><div className="composer-hint">{props.backend?.name} · {props.session.cwd}</div></form>
  </div>;
}

function EventView({ event, renderMode, cwd, onApprove, onReject }: { event: AgentEvent; renderMode: RenderMode; cwd?: string; onApprove: (id: string, option?: string) => Promise<unknown>; onReject: (id: string) => Promise<unknown> }) {
  const resolveImage = (src: string) => /^(https?:|data:|blob:)/.test(src) ? src : `/api/files?sessionId=${encodeURIComponent(event.sessionId)}&path=${encodeURIComponent(src.startsWith("/") ? src : `${cwd ?? ""}/${src}`)}`;
  if (event.type === "status_changed") return null;
  if (event.type === "user_message") return <article className="message user"><div className="event-label">You</div>{renderMode === "markdown" ? <Markdown text={event.content} imageSrc={resolveImage} /> : <div>{event.content}</div>}</article>;
  if (event.type === "assistant_message") return <article className="message assistant"><div className="event-label">Agent</div>{renderMode === "markdown" ? <Markdown text={event.content} imageSrc={resolveImage} /> : <div>{event.content}</div>}</article>;
  if (event.type === "reasoning") return <details className="event-card"><summary>Reasoning</summary><pre>{event.content}</pre></details>;
  if (event.type === "command") return <details className="event-card command-card" open={event.status === "running"}><summary><span>›_</span><code>{event.command}</code><em>{event.status}</em></summary>{event.output && <pre>{event.output}</pre>}</details>;
  if (event.type === "terminal_output") return <details className="event-card"><summary>Terminal output</summary><pre>{event.data}</pre></details>;
  if (event.type === "tool_call") return <div className="event-card tool-row"><span>◇</span><div><strong>{event.toolName}</strong><small>{event.status}</small></div></div>;
  if (event.type === "tool_result") return <details className="event-card"><summary>{event.toolName} · {event.success ? "Done" : "Failed"}</summary><pre>{event.content}</pre></details>;
  if (event.type === "permission_request") return <div className="permission-card"><div className="permission-icon">!</div><div><strong>Permission required</strong><p>{event.description}</p><div className="permission-actions"><button className="allow" onClick={() => void onApprove(event.requestId)}>Allow once</button>{event.options.includes("acceptForSession") && <button onClick={() => void onApprove(event.requestId, "acceptForSession")}>Allow for session</button>}<button className="reject" onClick={() => void onReject(event.requestId)}>Reject</button></div></div></div>;
  return <div className="error-card">{event.message}</div>;
}

function NewSession({ backends, busy, onClose, onCreate }: { backends: AgentBackend[]; busy: boolean; onClose: () => void; onCreate: (data: { backendId: BackendId; cwd: string; prompt: string }) => Promise<unknown> }) {
  const [backendId, setBackendId] = useState<BackendId>(backends[0]?.id ?? "codex"); const [cwd, setCwd] = useState(""); const [prompt, setPrompt] = useState("");
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="modal" onSubmit={(event) => { event.preventDefault(); void onCreate({ backendId, cwd, prompt }); }}><div className="modal-head"><div><p className="eyebrow">Start managed runtime</p><h2>New session</h2></div><button type="button" className="icon-button" onClick={onClose}>×</button></div><label>Run with<select value={backendId} disabled={!backends.length} onChange={(event) => setBackendId(event.target.value as BackendId)}>{!backends.length && <option>No available backends</option>}{backends.map((backend) => <option key={backend.id} value={backend.id}>{backend.name}</option>)}</select></label><label>Project / directory<input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/Users/you/workspace/project" /></label><label>Initial prompt<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} placeholder="Describe the task…" /></label><div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary-small" disabled={busy || !backends.length || !cwd.trim() || !prompt.trim()}>Start session</button></div></form></div>;
}

function Empty({ text }: { text: string }) { return <div className="empty"><span>◎</span><p>{text}</p></div>; }
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
function statusInfo(status: SessionStatus) { if (status === "running") return { symbol: "●", label: "Running", className: "running" }; if (status === "waiting_permission") return { symbol: "!", label: "Permission required", className: "warning" }; if (status === "waiting_input") return { symbol: "!", label: "Waiting for input", className: "warning" }; if (status === "completed") return { symbol: "✓", label: "Completed", className: "completed" }; if (status === "failed") return { symbol: "×", label: "Failed", className: "failed" }; return { symbol: "○", label: status === "idle" ? "Idle" : "Unknown", className: "idle" }; }
function parsedDate(value?: string): Date | undefined { if (!value) return undefined; const date = new Date(value); return Number.isNaN(date.getTime()) ? undefined : date; }
function formatDate(value?: string): string { const date = parsedDate(value); return date ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("/", "-") : "—"; }
function formatDateTime(value?: string): string { const date = parsedDate(value); return date ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "long", timeStyle: "short" }).format(date) : ""; }

export function mergeEvents(history: AgentEvent[], live: AgentEvent[]): AgentEvent[] { const known = new Set(history.map((event) => event.id)); return [...history, ...live.filter((event) => !known.has(event.id))]; }
export function appendLiveEvent(events: AgentEvent[], event: AgentEvent): AgentEvent[] {
  const last = events.at(-1);
  if (event.type === "assistant_message" && event.partial && last?.type === "assistant_message" && last.partial) return [...events.slice(0, -1), { ...last, content: last.content + event.content, timestamp: event.timestamp }];
  if (event.type === "terminal_output" && last?.type === "terminal_output") return [...events.slice(0, -1), { ...last, data: last.data + event.data, timestamp: event.timestamp }];
  return [...events, event];
}
