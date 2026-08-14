import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
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
  app.get("/ws", { websocket: true }, (socket) => { const unsubscribe = service.onEvent((event) => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); }); socket.on("close", unsubscribe); });
  if (webRoot && existsSync(webRoot)) { await app.register(fastifyStatic, { root: webRoot, wildcard: false }); app.get("/*", async (_request, reply) => reply.sendFile("index.html")); }
  app.setErrorHandler((error: unknown, _request, reply) => {
    const value = error as { statusCode?: number; message?: string };
    return reply.code(value.statusCode && value.statusCode >= 400 ? value.statusCode : 400).send({ error: value.message ?? String(error) });
  });
  return app;
}

function validateDirectory(path: string): void { if (!path || !resolve(path).startsWith("/") || !existsSync(path) || !statSync(path).isDirectory()) throw new Error("cwd must be an existing absolute directory"); }
