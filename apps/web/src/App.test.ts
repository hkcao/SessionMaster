import { describe, expect, it } from "vitest";
import { eventBase, type AgentEvent } from "@session-master/core";
import { appendLiveEvent, mergeEvents } from "./App";

function assistant(content: string): AgentEvent { return { ...eventBase("codex:one", "codex"), type: "assistant_message", content, partial: true }; }

describe("live event handling", () => {
  it("coalesces streaming assistant deltas", () => { const events = appendLiveEvent([assistant("hel")], assistant("lo")); expect(events).toHaveLength(1); expect((events[0] as { content: string }).content).toBe("hello"); });
  it("keeps live events while deduplicating loaded history", () => { const existing = assistant("existing"); const live = assistant("live"); expect(mergeEvents([existing], [existing, live])).toEqual([existing, live]); });
});
