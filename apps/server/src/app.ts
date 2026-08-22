import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, relative, sep } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { BackendId } from "@session-master/core";
import type { SessionService } from "./service.js";

interface IdParams { id: string }
interface StartBody { backendId: BackendId; cwd: string; prompt: string; title?: string }
interface MessageBody { message: string }
interface ContinueBody { backendId: BackendId; prompt?: string }
interface ApprovalBody { option?: string }

export async function buildApp(service: SessionService, webRoot?: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: true }); await app.register(websocket);
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/backends", async () => service.backends());
  app.get<{ Querystring: { backendId?: string; query?: string; status?: string; project?: string } }>("/api/sessions", async (request) => service.list(request.query));
  app.post("/api/sessions/refresh", async () => service.refresh());
  app.get<{ Params: IdParams }>("/api/sessions/:id", async (request) => service.get(request.params.id));
  app.get<{ Params: IdParams }>("/api/sessions/:id/events", async (request) => service.history(request.params.id));
  app.post<{ Body: StartBody }>("/api/sessions", async (request, reply) => {
    const { backendId, cwd, prompt, title } = request.body; validateDirectory(cwd); if (!prompt?.trim()) throw new Error("Initial prompt is required");
    return reply.code(201).send(await service.start(backendId, cwd, prompt, title));
  });
  app.post<{ Params: IdParams; Body: { prompt?: string } }>("/api/sessions/:id/resume", async (request) => service.resume(request.params.id, request.body?.prompt));
  app.post<{ Params: IdParams; Body: MessageBody }>("/api/sessions/:id/message", async (request) => { if (!request.body.message?.trim()) throw new Error("Message is required"); await service.message(request.params.id, request.body.message); return { ok: true }; });
  app.post<{ Params: IdParams; Body: ContinueBody }>("/api/sessions/:id/continue", async (request, reply) => reply.code(201).send(await service.continueWith(request.params.id, request.body.backendId, request.body.prompt)));
  app.post<{ Params: IdParams; Body: ApprovalBody }>("/api/permissions/:id/approve", async (request) => { await service.approve(request.params.id, request.body?.option); return { ok: true }; });
  app.post<{ Params: IdParams }>("/api/permissions/:id/reject", async (request) => { await service.reject(request.params.id); return { ok: true }; });
  app.post<{ Params: IdParams }>("/api/runtime/:id/stop", async (request) => { await service.stop(request.params.id); return { ok: true }; });
  app.get<{ Querystring: { path?: string; sessionId?: string } }>("/api/files", async (request, reply) => {
    const { path = "", sessionId = "" } = request.query; const type = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!sessionId || !type) return reply.code(404).send({ error: "Not found" });
    try {
      const session = await service.get(sessionId); const source = allowedImagePath(path, [session.cwd, tmpdir()].filter((root): root is string => Boolean(root)));
      if (!source) return reply.code(404).send({ error: "Not found" });
      reply.headers({ "cache-control": "private, max-age=60", "content-security-policy": "sandbox", "cross-origin-resource-policy": "same-origin", "x-content-type-options": "nosniff" }); return reply.type(type).send(createReadStream(source));
    } catch { return reply.code(404).send({ error: "Not found" }); }
  });
  app.get("/ws", { websocket: true }, (socket) => { const unsubscribe = service.onEvent((event) => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); }); socket.on("close", unsubscribe); });
  app.get("/api/*", async (_request, reply) => reply.code(404).send({ error: "Not found" }));
  if (webRoot && existsSync(webRoot)) { await app.register(fastifyStatic, { root: webRoot, wildcard: false, setHeaders: (res, path) => { if (path.endsWith("index.html")) res.setHeader("cache-control", "no-cache"); } }); app.get("/*", async (_request, reply) => reply.header("cache-control", "no-cache").sendFile("index.html")); }
  app.setErrorHandler((error: unknown, _request, reply) => {
    const value = error as { statusCode?: number; message?: string };
    return reply.code(value.statusCode && value.statusCode >= 400 ? value.statusCode : 400).send({ error: value.message ?? String(error) });
  });
  return app;
}

function validateDirectory(path: string): void { if (!path || !isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) throw new Error("cwd must be an existing absolute directory"); }

function allowedImagePath(path: string, roots: string[]): string | undefined {
  if (!isAbsolute(path)) return undefined;
  try {
    const source = realpathSync(path); if (!statSync(source).isFile()) return undefined;
    return roots.some((root) => { const fromRoot = relative(realpathSync(root), source); return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)); }) ? source : undefined;
  } catch { return undefined; }
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
