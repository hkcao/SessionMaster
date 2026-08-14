import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BackendRegistry } from "@session-master/core";
import { CodexAdapter } from "@session-master/adapter-codex";
import { ClaudeCodeAdapter } from "@session-master/adapter-claude";
import { buildApp } from "./app.js";
import { SessionService } from "./service.js";
import { LocalStore } from "./store.js";

const projectRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const registry = new BackendRegistry(); registry.register(new CodexAdapter()); registry.register(new ClaudeCodeAdapter());
const store = new LocalStore(process.env.SESSION_MASTER_DB ?? join(projectRoot, ".session-master", "session-master.sqlite"));
const service = new SessionService(registry, store); await service.refresh();
const app = await buildApp(service, join(projectRoot, "apps", "web", "dist"));
const port = Number(process.env.PORT ?? 4310); const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
