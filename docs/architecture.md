# SessionMaster architecture

SessionMaster is a localhost-only, local-first Web UI over existing AI coding CLIs. It is a session viewer and runtime console, not an IDE or orchestrator. The first release supports Codex and Claude Code; zcode is deliberately out of scope.

## Domain model

- **Backend** describes a named CLI and its measured capabilities. A failed adapter is isolated and reported as unavailable.
- **Session** is a durable logical conversation owned by one backend. It may exist with no runtime. Native history remains the source of truth and is never rewritten.
- **Runtime** is a process or structured-protocol connection created by SessionMaster for a session. A runtime has its own lifecycle and may disappear while the session remains.
- **AgentEvent** is the normalized stream consumed by the UI: user/assistant messages, reasoning, tools, commands, terminal output, permissions, status changes, and errors.
- **Adapter** discovers native sessions and history and starts/resumes a backend-specific runtime. Business services do not branch on backend names.

## Components and dependency direction

```text
React UI -> HTTP/WebSocket API -> SessionService -> BackendRegistry -> Adapter -> Agent
                                      |
                                      +-> RuntimeManager -> managed process/protocol
```

`packages/core` owns types, normalization helpers, the registry, and failure isolation. `adapter-codex` reads Codex JSONL history and uses the structured app-server JSON-RPC protocol for live work. `adapter-claude` reads Claude project JSONL and uses Claude Code's bidirectional `stream-json` CLI mode. `apps/server` owns HTTP, the local SQLite index, WebSocket fan-out, and runtime lifecycle. `apps/web` never invokes a CLI.

## History and index

Codex history is discovered under `~/.codex/sessions` and names are read from `~/.codex/session_index.jsonl`. Claude history is discovered under `~/.claude/projects`. SessionMaster stores only normalized mappings and UI/runtime metadata in `.session-master/session-master.sqlite`; native JSONL files remain authoritative.

## Runtime and WebSocket flow

```text
POST start/resume -> adapter -> RuntimeManager -> structured child process
                                             -> normalized AgentEvent
                                             -> WebSocket /ws
Browser message/approval/stop -> HTTP API -> RuntimeManager -> protocol stdin
```

Codex uses `initialize`, `thread/start` or `thread/resume`, and `turn/start`; app-server notifications and server approval requests are normalized. Claude uses `--input-format stream-json --output-format stream-json`; CLI messages and permission control requests are normalized. Only runtimes created by SessionMaster are controllable.

## Security boundaries

The server binds to `127.0.0.1` by default. Directory paths must be absolute and exist. Approvals require an explicit user action and are never auto-approved. Environment values and auth files are neither indexed nor returned by the API. Sensitive command text is shown to the local user because it is necessary for informed approval.
