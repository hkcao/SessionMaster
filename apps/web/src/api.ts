import type { AgentBackend, AgentEvent, BackendId, Runtime, Session } from "@session-master/core";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error ?? `${response.status} ${response.statusText}`); }
  return response.json() as Promise<T>;
}

export const api = {
  backends: () => request<AgentBackend[]>("/api/backends"),
  sessions: (query = "") => request<Session[]>(`/api/sessions${query ? `?query=${encodeURIComponent(query)}` : ""}`),
  refresh: () => request<Session[]>("/api/sessions/refresh", { method: "POST" }),
  events: (id: string) => request<AgentEvent[]>(`/api/sessions/${encodeURIComponent(id)}/events`),
  start: (body: { backendId: BackendId; cwd: string; prompt: string; title?: string }) => request<{ session: Session; runtime: Runtime }>("/api/sessions", { method: "POST", body: JSON.stringify(body) }),
  resume: (id: string) => request<Runtime>(`/api/sessions/${encodeURIComponent(id)}/resume`, { method: "POST", body: "{}" }),
  message: (id: string, message: string) => request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/message`, { method: "POST", body: JSON.stringify({ message }) }),
  continueWith: (id: string, backendId: BackendId) => request<{ session: Session; runtime: Runtime }>(`/api/sessions/${encodeURIComponent(id)}/continue`, { method: "POST", body: JSON.stringify({ backendId }) }),
  approve: (id: string, option?: string) => request<{ ok: true }>(`/api/permissions/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify({ option }) }),
  reject: (id: string) => request<{ ok: true }>(`/api/permissions/${encodeURIComponent(id)}/reject`, { method: "POST", body: "{}" }),
  stop: (id: string) => request<{ ok: true }>(`/api/runtime/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" }),
};
