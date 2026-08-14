export type BackendId = "codex" | "claude-code" | (string & {});

export interface BackendCapabilities {
  discoverSessions: boolean;
  readHistory: boolean;
  nativeResume: boolean;
  structuredEvents: boolean;
  terminalStreaming: boolean;
  sendMessage: boolean;
  permissions: boolean;
  stop: boolean;
  crossAgentContinue: boolean;
}

export interface AgentBackend {
  id: BackendId;
  name: string;
  icon?: string;
  executable?: string;
  installed: boolean;
  available: boolean;
  version?: string;
  error?: string;
  capabilities: BackendCapabilities;
}

export type SessionStatus = "running" | "waiting_input" | "waiting_permission" | "idle" | "completed" | "failed" | "unknown";
export type RuntimeStatus = "starting" | "running" | "waiting_input" | "waiting_permission" | "completed" | "failed" | "stopped";

export interface Session {
  id: string;
  backendId: BackendId;
  nativeSessionId?: string;
  title?: string;
  projectName?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  status: SessionStatus;
  runtimeId?: string;
  parentSessionId?: string;
  continuedFromBackend?: string;
  metadata?: Record<string, unknown>;
}

export interface Runtime {
  id: string;
  sessionId: string;
  backendId: BackendId;
  pid?: number;
  cwd?: string;
  startedAt: string;
  status: RuntimeStatus;
  transport: "structured" | "pty" | "tmux";
  host: "local";
}

export interface EventBase { id: string; sessionId: string; backendId: BackendId; timestamp: string }
export type AgentEvent =
  | (EventBase & { type: "user_message"; content: string })
  | (EventBase & { type: "assistant_message"; content: string; partial?: boolean })
  | (EventBase & { type: "reasoning"; content: string })
  | (EventBase & { type: "tool_call"; toolName: string; input?: unknown; status: "running" | "success" | "failed" })
  | (EventBase & { type: "tool_result"; toolName: string; content: string; success: boolean })
  | (EventBase & { type: "command"; command: string; cwd?: string; output?: string; status: "running" | "success" | "failed" })
  | (EventBase & { type: "terminal_output"; data: string })
  | (EventBase & { type: "permission_request"; requestId: string; permissionType: string; description: string; options: string[] })
  | (EventBase & { type: "status_changed"; status: SessionStatus })
  | (EventBase & { type: "error"; message: string });

export interface BackendDetection { installed: boolean; available: boolean; executable?: string; version?: string; error?: string }
export interface StartOptions { cwd: string; prompt: string; title?: string }
export interface ResumeOptions { prompt?: string }
export type Unsubscribe = () => void;

export interface AgentAdapter {
  readonly id: BackendId;
  readonly name: string;
  readonly capabilities: BackendCapabilities;
  detect(): Promise<BackendDetection>;
  listSessions(): Promise<Session[]>;
  getSession(sessionId: string): Promise<Session>;
  getHistory(sessionId: string): Promise<AgentEvent[]>;
  start(options: StartOptions): Promise<Runtime>;
  resume(sessionId: string, options?: ResumeOptions): Promise<Runtime>;
  sendMessage(runtimeId: string, message: string): Promise<void>;
  approve?(requestId: string, option?: string): Promise<void>;
  reject?(requestId: string): Promise<void>;
  stop?(runtimeId: string): Promise<void>;
  subscribe(sessionId: string, listener: (event: AgentEvent) => void): Unsubscribe;
}
