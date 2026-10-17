/** The audience rules the flows API applies to trigger_config, without a database. */
import { describe, it, expect } from "vitest";
import { audienceIssues } from "../src/routes/flows.js";

const audience = { conditions: [{ field: "payment_status", op: "is", value: "paid" }] };

describe("audienceIssues", () => {
  it("is fine when there is no audience", () => {
    expect(audienceIssues("lifecycle_transition", { from: "engaged", to: "at_risk" })).toBeNull();
    expect(audienceIssues("segment", { tenure_bucket: "new", recency_bucket: "active" })).toBeNull();
    expect(audienceIssues("event", undefined)).toBeNull();
  });

  it("accepts a valid audience on lifecycle and event triggers", () => {
    expect(audienceIssues("lifecycle_transition", { from: "a", to: "b", audience })).toBeNull();
    expect(audienceIssues("event", { event: "x", audience })).toBeNull();
  });

  it("refuses an audience on segment and manual triggers", () => {
    for (const type of ["segment", "manual", undefined]) {
      const issues = audienceIssues(type, { audience });
      expect(issues?.[0]?.path).toEqual(["trigger_config", "audience"]);
      expect(issues?.[0]?.message).toMatch(/lifecycle_transition or event/);
    }
  });

  it("reports a bad condition with its full path", () => {
    const issues = audienceIssues("event", { event: "x", audience: { conditions: [{ field: "payment_status", op: "is", value: "vip" }] } });
    expect(issues?.length).toBeGreaterThan(0);
    expect(issues!.every((i) => i.path.slice(0, 2).join(".") === "trigger_config.audience")).toBe(true);
  });

  it("refuses an empty or oversized audience and unknown keys", () => {
    expect(audienceIssues("event", { event: "x", audience: { conditions: [] } })).not.toBeNull();
    const six = Array.from({ length: 6 }, () => ({ field: "has_email", op: "is", value: true }));
    expect(audienceIssues("event", { event: "x", audience: { conditions: six } })).not.toBeNull();
    expect(audienceIssues("event", { event: "x", audience: { conditions: [], match: "any" } })).not.toBeNull();
  });
});
