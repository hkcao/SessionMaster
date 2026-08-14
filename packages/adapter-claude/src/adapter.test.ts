import { describe, expect, it } from "vitest";
import { buildClaudeArgs, normalizeClaudeHistory } from "./index.js";

describe("Claude event normalization", () => {
  it("maps text and tool results", () => {
    const events = normalizeClaudeHistory([
      { timestamp: "2026-01-01T00:00:00Z", type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
      { timestamp: "2026-01-01T00:00:01Z", type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
    ], "claude-code:one");
    expect(events.map((event) => event.type)).toEqual(["assistant_message", "tool_result"]);
  });
  it("assigns a native id to new sessions and keeps resume separate", () => {
    expect(buildClaudeArgs(undefined, "new-id")).toContainEqual("--session-id");
    expect(buildClaudeArgs(undefined, "new-id")).toContainEqual("new-id");
    expect(buildClaudeArgs("old-id", "ignored").slice(-2)).toEqual(["--resume", "old-id"]);
  });
});
