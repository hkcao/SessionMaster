import { describe, expect, it } from "vitest";
import { normalizeCodexHistory } from "./index.js";

describe("Codex event normalization", () => {
  it("maps messages and tool calls", () => {
    const events = normalizeCodexHistory([
      { timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "user_message", message: "fix it" } },
      { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } },
    ], "codex:one");
    expect(events.map((event) => event.type)).toEqual(["user_message", "tool_call"]);
  });
});
