import { describe, it, expect } from "vitest";
import { flowHealth } from "../src/index.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const base = { status: "active", sent30: 0, sent7: 0, bounced30: 0, complained30: 0, activeSince: daysAgo(10), now: NOW };

describe("flowHealth", () => {
  it("does not judge drafts or paused flows", () => {
    expect(flowHealth({ ...base, status: "draft" }).state).toBe("draft");
    expect(flowHealth({ ...base, status: "paused" }).state).toBe("paused");
    expect(flowHealth({ ...base, status: "archived" }).state).toBe("draft");
  });

  it("is waiting for the first three days after switching on, then quiet", () => {
    expect(flowHealth({ ...base, activeSince: daysAgo(1) }).state).toBe("waiting");
    const quiet = flowHealth({ ...base, activeSince: daysAgo(5) });
    expect(quiet.state).toBe("quiet");
    expect(quiet.note).toMatch(/event/);
  });

  it("is ok when it has sent in the last week", () => {
    expect(flowHealth({ ...base, sent30: 12, sent7: 3 })).toEqual({ state: "ok", note: null });
  });

  it("asks for attention on high bounces or complaints, but only with enough sends", () => {
    expect(flowHealth({ ...base, sent30: 100, sent7: 10, bounced30: 6 }).state).toBe("attention");
    expect(flowHealth({ ...base, sent30: 1000, sent7: 100, complained30: 4 }).state).toBe("attention");
    expect(flowHealth({ ...base, sent30: 10, sent7: 10, bounced30: 5 }).state).toBe("ok"); // too few sends to trust a rate
    expect(flowHealth({ ...base, sent30: 100, sent7: 10, bounced30: 4 }).state).toBe("ok"); // 4% is under the line
  });

  it("puts spam complaints ahead of bounces in the message", () => {
    const h = flowHealth({ ...base, sent30: 100, sent7: 10, bounced30: 10, complained30: 2 });
    expect(h.note).toMatch(/spam/);
  });
});
