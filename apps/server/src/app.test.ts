import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "@session-master/core";
import { buildApp } from "./app.js";
import type { SessionService } from "./service.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true }))); });

function serviceFor(session: Session): SessionService {
  return { get: async () => session, onEvent: () => () => {} } as unknown as SessionService;
}

describe("HTTP app", () => {
  it("rejects a relative working directory", async () => {
    const app = await buildApp({ onEvent: () => () => {} } as unknown as SessionService);
    const response = await app.inject({ method: "POST", url: "/api/sessions", payload: { backendId: "codex", cwd: ".", prompt: "test" } });
    expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ error: "cwd must be an existing absolute directory" }); await app.close();
  });

  it("serves images only for a named session and an allowed root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "session-master-app-")); temporary.push(cwd); const image = join(cwd, "preview.png"); await writeFile(image, "png");
    const app = await buildApp(serviceFor({ id: "mock:one", backendId: "mock", cwd, status: "idle" }));
    const allowed = await app.inject({ method: "GET", url: `/api/files?sessionId=mock%3Aone&path=${encodeURIComponent(image)}` });
    expect(allowed.statusCode).toBe(200); expect(allowed.headers["x-content-type-options"]).toBe("nosniff");
    const missingSession = await app.inject({ method: "GET", url: `/api/files?path=${encodeURIComponent(image)}` }); expect(missingSession.statusCode).toBe(404);
    const outside = resolve(process.cwd(), "../../docs/assets/sessionmaster-ui.jpg"); const denied = await app.inject({ method: "GET", url: `/api/files?sessionId=mock%3Aone&path=${encodeURIComponent(outside)}` }); expect(denied.statusCode).toBe(404); await app.close();
  });

  it("does not return the SPA shell for an unknown API route", async () => {
    const app = await buildApp({ onEvent: () => () => {} } as unknown as SessionService, resolve(process.cwd(), "../web/dist"));
    const response = await app.inject({ method: "GET", url: "/api/missing" }); expect(response.statusCode).toBe(404); expect(response.json()).toEqual({ error: "Not found" }); await app.close();
  });
});
