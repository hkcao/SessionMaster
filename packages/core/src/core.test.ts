import { describe, expect, it } from "vitest";
import { BackendRegistry, textFromContent, type AgentAdapter } from "./index.js";

const adapter = (id: string, detect: AgentAdapter["detect"]): AgentAdapter => ({
  id, name: id, capabilities: { discoverSessions: true, readHistory: true, nativeResume: false, structuredEvents: false, terminalStreaming: false, sendMessage: false, permissions: false, stop: false, crossAgentContinue: false },
  detect, listSessions: async () => [], getSession: async () => { throw new Error("missing"); }, getHistory: async () => [],
  start: async () => { throw new Error("unsupported"); }, resume: async () => { throw new Error("unsupported"); }, sendMessage: async () => {}, subscribe: () => () => {},
});

describe("BackendRegistry", () => {
  it("isolates adapter detection failures", async () => {
    const registry = new BackendRegistry();
    registry.register(adapter("ok", async () => ({ installed: true, available: true })));
    registry.register(adapter("bad", async () => { throw new Error("boom"); }));
    const result = await registry.detectAll();
    expect(result.find((item) => item.id === "ok")?.available).toBe(true);
    expect(result.find((item) => item.id === "bad")?.error).toBe("boom");
  });
});

describe("event normalization", () => {
  it("extracts text blocks without unsafe coercion", () => {
    expect(textFromContent([{ type: "text", text: "one" }, { type: "image" }, "two"])).toBe("one\ntwo");
  });
});
