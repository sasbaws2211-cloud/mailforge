/**
 * Segment rules in the editor: rows <-> the stored definition, plain-English summaries, and building a
 * segment from the People page's filters.
 *
 * The contract tests run everything the editor can produce through the SERVER's schema
 * (packages/core/src/segment.ts), so the two cannot drift apart unnoticed.
 */
import { describe, it, expect } from "vitest";
import {
  SEGMENT_MAX_EVENT_DAYS,
  SEGMENT_MAX_GROUP_LEAVES,
  SEGMENT_MAX_LEAVES,
  changeRowField,
  changeRowOp,
  countRows,
  definitionToState,
  describeSegment,
  emptySegmentState,
  newGroup,
  newSegmentRow,
  opsFor,
  stateFromFilters,
  stateToDefinition,
  type SegmentField,
  type SegmentItem,
  type SegmentRow,
  type SegmentState,
} from "../src/segment-rules.js";
import {
  segmentDefinitionSchema,
  SEGMENT_MAX_EVENT_DAYS as SERVER_MAX_EVENT_DAYS,
  SEGMENT_MAX_GROUP_LEAVES as SERVER_MAX_GROUP,
  SEGMENT_MAX_LEAVES as SERVER_MAX_LEAVES,
} from "../../../packages/core/src/segment.js";

const row = (over: Partial<SegmentRow>): SegmentRow => ({ ...newSegmentRow(), ...over });
const item = (r: SegmentRow): SegmentItem => ({ kind: "row", row: r });
const state = (rows: SegmentRow[], match: "all" | "any" = "all"): SegmentState => ({ match, items: rows.map(item) });

describe("rows to a definition", () => {
  it("no rules means no definition", () => {
    expect(stateToDefinition(emptySegmentState())).toEqual({ definition: null, errors: {} });
  });

  it("builds each kind of check", () => {
    const rows = [
      row({ field: "payment_status", op: "in", values: ["trial", "paid"] }),
      row({ field: "plan", op: "is", value: " Pro " }),
      row({ field: "lifecycle_state", op: "is_not", value: "churned" }),
      row({ field: "lifecycle_state", op: "in", values: ["at_risk", "dormant"] }),
      row({ field: "last_seen", op: "before_days", days: "14" }),
      row({ field: "first_seen", op: "within_days", days: "30" }),
      row({ field: "event", op: "not_performed", name: " exported ", days: "7" }),
      row({ field: "event", op: "performed", name: "login", days: "30", minCount: "3" }),
      row({ field: "event", op: "performed", name: "login", days: "30", minCount: "1" }),
      row({ field: "trait", key: "seats", op: "gt", value: "10" }),
      row({ field: "has_email", op: "is", value: "no" }),
    ];
    expect(stateToDefinition(state(rows)).definition?.rules).toEqual([
      { field: "payment_status", op: "in", value: ["trial", "paid"] },
      { field: "plan", op: "is", value: "Pro" },
      { field: "lifecycle_state", op: "is_not", value: "churned" },
      { field: "lifecycle_state", op: "in", value: ["at_risk", "dormant"] },
      { field: "last_seen", op: "before_days", days: 14 },
      { field: "first_seen", op: "within_days", days: 30 },
      { field: "event", name: "exported", op: "not_performed", within_days: 7 },
      { field: "event", name: "login", op: "performed", within_days: 30, min_count: 3 },
      { field: "event", name: "login", op: "performed", within_days: 30 }, // "1 time" is just "did"
      { field: "trait", key: "seats", op: "gt", value: 10 },
      { field: "has_email", op: "is", value: false },
    ]);
  });

  it("keeps the match and puts a group's rules together under its own match", () => {
    const g = newGroup();
    g.match = "any";
    g.rows = [row({ field: "plan", op: "is", value: "Pro" }), row({ field: "plan", op: "is", value: "Growth" })];
    const s: SegmentState = { match: "all", items: [item(row({ field: "payment_status", op: "is", value: "paid" })), { kind: "group", group: g }] };
    expect(stateToDefinition(s).definition).toEqual({
      match: "all",
      rules: [
        { field: "payment_status", op: "is", value: "paid" },
        { match: "any", rules: [{ field: "plan", op: "is", value: "Pro" }, { field: "plan", op: "is", value: "Growth" }] },
      ],
    });
  });

  it("reports each bad row and sends nothing while any remain", () => {
    const bad = [
      row({ field: "event", op: "performed", name: "", days: "7" }),
      row({ field: "event", op: "performed", name: "x", days: "0" }),
      row({ field: "event", op: "performed", name: "x", days: String(SEGMENT_MAX_EVENT_DAYS + 1) }),
      row({ field: "event", op: "performed", name: "x", days: "7", minCount: "many" }),
      row({ field: "last_seen", op: "before_days", days: "-3" }),
      row({ field: "last_seen", op: "before_days", days: "" }),
      row({ field: "first_seen", op: "within_days", days: "2.5" }),
      row({ field: "lifecycle_state", op: "in", values: [] }),
      row({ field: "lifecycle_state", op: "is", value: "happy" }),
      row({ field: "plan", op: "is", value: "" }),
      row({ field: "trait", key: "", op: "is", value: "x" }),
    ];
    const good = row({ field: "payment_status", op: "is", value: "paid" });
    const result = stateToDefinition(state([...bad, good]));
    expect(result.definition).toBeNull();
    expect(Object.keys(result.errors)).toEqual(bad.map((r) => r.id));
  });

  it("an empty group is an error on the group", () => {
    const g = newGroup();
    g.rows = [];
    const result = stateToDefinition({ match: "all", items: [item(row({ field: "plan", op: "is", value: "x" })), { kind: "group", group: g }] });
    expect(result.definition).toBeNull();
    expect(result.errors[g.id]).toMatch(/at least one rule/);
  });
});

describe("changing a row", () => {
  it("changing the field restarts the row but keeps its place; each field starts sensibly", () => {
    const before = row({ field: "trait", key: "x", op: "gt", value: "5" });
    const after = changeRowField(before, "event");
    expect(after).toMatchObject({ id: before.id, field: "event", op: "performed", key: "", days: "30" });
    expect(changeRowField(before, "last_seen")).toMatchObject({ op: "within_days", days: "14" });
    expect(changeRowField(before, "lifecycle_state")).toMatchObject({ op: "is", value: "signed_up" });
  });

  it("'is one of' keeps the value, and back keeps the first", () => {
    const r = changeRowOp(row({ field: "lifecycle_state", op: "is", value: "engaged" }), "in");
    expect(r.values).toEqual(["engaged"]);
    expect(changeRowOp({ ...r, values: ["dormant", "churned"] }, "is").value).toBe("dormant");
  });

  it("offers only sensible operators per field", () => {
    expect(opsFor("event")).toEqual(["performed", "not_performed"]);
    expect(opsFor("last_seen")).toEqual(["within_days", "before_days"]);
    expect(opsFor("lifecycle_state")).toEqual(["is", "is_not", "in"]);
    expect(opsFor("has_email")).toEqual(["is"]);
  });

  it("counts rows, including those in groups", () => {
    const g = newGroup();
    g.rows = [row({}), row({}), row({})];
    expect(countRows({ match: "all", items: [item(row({})), { kind: "group", group: g }] })).toBe(4);
  });
});

describe("a stored definition back to rows", () => {
  it("round-trips whatever the editor builds", () => {
    const g = newGroup();
    g.match = "all";
    g.rows = [row({ field: "event", op: "performed", name: "login", days: "7", minCount: "3" }), row({ field: "lifecycle_state", op: "in", values: ["at_risk", "dormant"] })];
    const original: SegmentState = {
      match: "any",
      items: [
        item(row({ field: "payment_status", op: "is", value: "paid" })),
        item(row({ field: "last_seen", op: "before_days", days: "14" })),
        item(row({ field: "trait", key: "seats", op: "lt", value: "5" })),
        { kind: "group", group: g },
      ],
    };
    const { definition } = stateToDefinition(original);
    const back = definitionToState(definition);
    expect(back.unreadable).toBe(false);
    expect(stateToDefinition(back.state).definition).toEqual(definition);
    expect(back.state.match).toBe("any");
  });

  it("will not show what it cannot show without changing it", () => {
    for (const bad of [
      null,
      "paid",
      { match: "all", rules: [] },
      { match: "some", rules: [{ field: "plan", op: "is", value: "x" }] },
      { match: "all", rules: [{ field: "hair", op: "is", value: "red" }] },
      { match: "all", rules: [{ match: "any", rules: [] }] },
      { match: "all", rules: [{ match: "any", rules: [{ match: "all", rules: [{ field: "plan", op: "is", value: "x" }] }] }] }, // a group in a group
      { match: "all", rules: [{ field: "event", name: "x", op: "performed" }] },
    ]) {
      expect(definitionToState(bad).unreadable).toBe(true);
    }
  });
});

describe("the contract with the server", () => {
  const FIELDS: SegmentField[] = ["payment_status", "plan", "engagement_depth", "lifecycle_state", "has_email", "trait", "first_seen", "last_seen", "event"];

  it("every kind of row the editor can build is accepted by the server's schema", () => {
    for (const field of FIELDS) {
      for (const op of opsFor(field)) {
        const r = { ...changeRowField(newSegmentRow(), field), op };
        if (op === "in") r.values = r.value ? [r.value] : ["paid"];
        if (field === "trait") {
          r.key = "seats";
          r.value = op === "gt" || op === "lt" ? "10" : "x";
        }
        if (field === "plan") r.value = "Pro";
        if (field === "event") r.name = "login";
        const { definition, errors } = stateToDefinition(state([r]));
        expect(errors, `${field}/${op}`).toEqual({});
        const parsed = segmentDefinitionSchema.safeParse(definition);
        if (!parsed.success) throw new Error(`${field}/${op} refused: ${JSON.stringify(parsed.error.issues)}`);
      }
    }
  });

  it("random combinations, with groups, are accepted too", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let i = 0; i < 200; i++) {
      const makeRow = (): SegmentRow => {
        const field = FIELDS[Math.floor(rand() * FIELDS.length)]!;
        const ops = opsFor(field);
        const r = { ...changeRowField(newSegmentRow(), field), op: ops[Math.floor(rand() * ops.length)]! };
        if (r.op === "in") r.values = [r.value || "paid"];
        if (field === "trait") {
          r.key = `k${Math.floor(rand() * 5)}`;
          r.value = r.op === "gt" || r.op === "lt" ? String(Math.floor(rand() * 100)) : "v";
        }
        if (field === "plan") r.value = "Pro";
        if (field === "event") {
          r.name = "evt";
          r.days = String(1 + Math.floor(rand() * 300));
          if (r.op === "performed" && rand() < 0.5) r.minCount = String(2 + Math.floor(rand() * 5));
        }
        return r;
      };
      const items: SegmentItem[] = [];
      const top = 1 + Math.floor(rand() * 4);
      for (let t = 0; t < top; t++) {
        if (rand() < 0.3) {
          const g = newGroup();
          g.match = rand() < 0.5 ? "all" : "any";
          g.rows = Array.from({ length: 1 + Math.floor(rand() * 3) }, makeRow);
          items.push({ kind: "group", group: g });
        } else items.push(item(makeRow()));
      }
      const { definition, errors } = stateToDefinition({ match: rand() < 0.5 ? "all" : "any", items });
      expect(errors).toEqual({});
      const parsed = segmentDefinitionSchema.safeParse(definition);
      if (!parsed.success) throw new Error(`#${i}: ${JSON.stringify(parsed.error.issues)}\n${JSON.stringify(definition)}`);
      // and it reads back to the same thing
      expect(stateToDefinition(definitionToState(definition).state).definition).toEqual(definition);
    }
  });

  it("the limits match the server's", () => {
    expect(SEGMENT_MAX_LEAVES).toBe(SERVER_MAX_LEAVES);
    expect(SEGMENT_MAX_GROUP_LEAVES).toBe(SERVER_MAX_GROUP);
    expect(SEGMENT_MAX_EVENT_DAYS).toBe(SERVER_MAX_EVENT_DAYS);
  });
});

describe("describeSegment", () => {
  it("reads like a sentence", () => {
    expect(
      describeSegment({
        match: "all",
        rules: [
          { field: "payment_status", op: "is", value: "paid" },
          { field: "last_seen", op: "before_days", days: 14 },
          { match: "any", rules: [{ field: "plan", op: "is", value: "Pro" }, { field: "event", name: "exported", op: "not_performed", within_days: 7 }] },
        ],
      }),
    ).toBe("payment status is paid and last seen more than 14 days ago and (plan is Pro or did not do exported in the last 7 days)");
  });

  it("covers the other checks, and the wording of one day", () => {
    expect(describeSegment({ match: "any", rules: [{ field: "lifecycle_state", op: "in", value: ["at_risk", "dormant"] }, { field: "first_seen", op: "within_days", days: 1 }] })).toBe(
      "lifecycle stage is one of at_risk, dormant or first seen in the last 1 day",
    );
    expect(describeSegment({ match: "all", rules: [{ field: "last_seen", op: "within_days", days: 0 }, { field: "event", name: "x", op: "performed", within_days: 14, min_count: 3 }] })).toBe(
      "last seen today and did x at least 3 times in the last 14 days",
    );
  });

  it("never throws, and is empty when there is nothing to say", () => {
    expect(describeSegment(null)).toBe("");
    expect(describeSegment({})).toBe("");
    expect(() => describeSegment({ match: "all", rules: [{ whatever: 1 }, "x", null] })).not.toThrow();
  });
});

describe("from the People page's filters", () => {
  it("turns a lifecycle stage and engagement into rules", () => {
    const { state: s } = stateFromFilters({ lifecycle_state: "at_risk", engagement_depth: "casual" });
    expect(stateToDefinition(s!).definition).toEqual({
      match: "all",
      rules: [{ field: "lifecycle_state", op: "is", value: "at_risk" }, { field: "engagement_depth", op: "is", value: "casual" }],
    });
  });

  it("says why when it cannot", () => {
    expect(stateFromFilters({ search: "ada" }).reason).toMatch(/text search/);
    expect(stateFromFilters({ tenure_bucket: "new" }).reason).toMatch(/retention cell/);
    expect(stateFromFilters({ recency_bucket: "idle", lifecycle_state: "engaged" }).state).toBeNull();
    expect(stateFromFilters({}).reason).toMatch(/Pick a lifecycle stage/);
    expect(stateFromFilters({ search: "  ", lifecycle_state: "engaged" }).state).not.toBeNull(); // a blank search is no search
  });
});
