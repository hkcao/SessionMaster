import { randomUUID } from "node:crypto";
import type { AgentEvent, BackendId, SessionStatus } from "./types.js";

export function eventBase(sessionId: string, backendId: BackendId, timestamp = new Date().toISOString()) {
  return { id: randomUUID(), sessionId, backendId, timestamp };
}

export function statusEvent(sessionId: string, backendId: BackendId, status: SessionStatus): AgentEvent {
  return { ...eventBase(sessionId, backendId), type: "status_changed", status };
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return [part.text];
    return [];
  }).join("\n");
}
