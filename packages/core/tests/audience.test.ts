import { describe, it, expect } from "vitest";
import {
  evaluateAudience,
  audienceSchema,
  readAudience,
  stripAudience,
  AUDIENCE_MAX_CONDITIONS,
  type AudienceContact,
} from "../src/index.js";

const contact = (over: Partial<AudienceContact> = {}): AudienceContact => ({
  paymentStatus: "paid",
  engagementDepth: "regular",
  email: "a@b.c",
  properties: { plan: "Pro", country: "Ghana", seats: 12, beta: true, tags: ["vip", "Early"], note: "Loves the API" },
  ...over,
});

const run = (conditions: unknown[], c = contact()) => evaluateAudience({ conditions }, c).outcome;

describe("no audience", () => {
  it("matches everyone when there is none", () => {
    expect(evaluateAudience(undefined, contact()).outcome).toBe("match");
    expect(evaluateAudience(null, contact()).outcome).toBe("match");
  });
});

describe("payment_status and engagement_depth", () => {
  it("is / is_not / in", () => {
    expect(run([{ field: "payment_status", op: "is", value: "paid" }])).toBe("match");
    expect(run([{ field: "payment_status", op: "is", value: "free" }])).toBe("no_match");
    expect(run([{ field: "payment_status", op: "is_not", value: "free" }])).toBe("match");
    expect(run([{ field: "payment_status", op: "in", value: ["trial", "paid"] }])).toBe("match");
    expect(run([{ field: "payment_status", op: "in", value: ["trial", "free"] }])).toBe("no_match");
    expect(run([{ field: "engagement_depth", op: "in", value: ["power", "regular"] }])).toBe("match");
    expect(run([{ field: "engagement_depth", op: "is", value: "power" }])).toBe("no_match");
  });

  it("treats an unset value as matching only 'is not'", () => {
    const c = contact({ paymentStatus: null, engagementDepth: null });
    expect(run([{ field: "payment_status", op: "is", value: "free" }], c)).toBe("no_match");
    expect(run([{ field: "payment_status", op: "in", value: ["free"] }], c)).toBe("no_match");
    expect(run([{ field: "payment_status", op: "is_not", value: "paid" }], c)).toBe("match");
    expect(run([{ field: "engagement_depth", op: "is", value: "casual" }], c)).toBe("no_match");
  });
});

describe("plan", () => {
  it("compares the plan name ignoring case and spaces", () => {
    expect(run([{ field: "plan", op: "is", value: "pro" }])).toBe("match");
    expect(run([{ field: "plan", op: "is", value: " PRO " }])).toBe("match");
    expect(run([{ field: "plan", op: "is", value: "Growth" }])).toBe("no_match");
    expect(run([{ field: "plan", op: "is_not", value: "Growth" }])).toBe("match");
  });

  it("a contact with no plan is 'not' any plan and never 'is' one", () => {
    const c = contact({ properties: {} });
    expect(run([{ field: "plan", op: "is", value: "Pro" }], c)).toBe("no_match");
    expect(run([{ field: "plan", op: "is_not", value: "Pro" }], c)).toBe("match");
  });
});

describe("has_email", () => {
  it("checks for a real address", () => {
    expect(run([{ field: "has_email", op: "is", value: true }])).toBe("match");
    expect(run([{ field: "has_email", op: "is", value: false }])).toBe("no_match");
    expect(run([{ field: "has_email", op: "is", value: false }], contact({ email: null }))).toBe("match");
    expect(run([{ field: "has_email", op: "is", value: true }], contact({ email: "  " }))).toBe("no_match");
  });
});

describe("traits", () => {
  it("is / is_not compare text without case, numbers, and booleans", () => {
    expect(run([{ field: "trait", key: "country", op: "is", value: "ghana" }])).toBe("match");
    expect(run([{ field: "trait", key: "country", op: "is_not", value: "Kenya" }])).toBe("match");
    expect(run([{ field: "trait", key: "seats", op: "is", value: 12 }])).toBe("match");
    expect(run([{ field: "trait", key: "seats", op: "is", value: 13 }])).toBe("no_match");
    expect(run([{ field: "trait", key: "beta", op: "is", value: true }])).toBe("match");
    expect(run([{ field: "trait", key: "beta", op: "is", value: false }])).toBe("no_match");
  });

  it("reads numbers and booleans that were stored as text", () => {
    const c = contact({ properties: { seats: "12", beta: "TRUE" } });
    expect(run([{ field: "trait", key: "seats", op: "is", value: 12 }], c)).toBe("match");
    expect(run([{ field: "trait", key: "beta", op: "is", value: true }], c)).toBe("match");
  });

  it("a missing trait is never 'is' and always 'is not'", () => {
    expect(run([{ field: "trait", key: "nope", op: "is", value: "x" }])).toBe("no_match");
    expect(run([{ field: "trait", key: "nope", op: "is_not", value: "x" }])).toBe("match");
  });

  it("is_set / is_not_set treat null, empty and missing as not set", () => {
    const c = contact({ properties: { a: "x", b: null, c: "", d: 0, e: false } });
    expect(run([{ field: "trait", key: "a", op: "is_set" }], c)).toBe("match");
    expect(run([{ field: "trait", key: "b", op: "is_set" }], c)).toBe("no_match");
    expect(run([{ field: "trait", key: "c", op: "is_set" }], c)).toBe("no_match");
    expect(run([{ field: "trait", key: "zzz", op: "is_not_set" }], c)).toBe("match");
    expect(run([{ field: "trait", key: "d", op: "is_set" }], c)).toBe("match"); // 0 is a value
    expect(run([{ field: "trait", key: "e", op: "is_set" }], c)).toBe("match"); // false is a value
  });

  it("contains finds text, and list items", () => {
    expect(run([{ field: "trait", key: "note", op: "contains", value: "the api" }])).toBe("match");
    expect(run([{ field: "trait", key: "note", op: "contains", value: "cats" }])).toBe("no_match");
    expect(run([{ field: "trait", key: "tags", op: "contains", value: "EARLY" }])).toBe("match");
    expect(run([{ field: "trait", key: "tags", op: "contains", value: "ear" }])).toBe("no_match"); // whole item, not a piece
    expect(run([{ field: "trait", key: "missing", op: "contains", value: "x" }])).toBe("no_match");
  });

  it("gt / lt need a number, and never match a non-number", () => {
    expect(run([{ field: "trait", key: "seats", op: "gt", value: 10 }])).toBe("match");
    expect(run([{ field: "trait", key: "seats", op: "lt", value: 10 }])).toBe("no_match");
    const c = contact({ properties: { seats: "abc", empty: "", n: "7" } });
    expect(run([{ field: "trait", key: "seats", op: "gt", value: 1 }], c)).toBe("no_match");
    expect(run([{ field: "trait", key: "seats", op: "lt", value: 1 }], c)).toBe("no_match");
    expect(run([{ field: "trait", key: "empty", op: "lt", value: 1 }], c)).toBe("no_match");
    expect(run([{ field: "trait", key: "n", op: "lt", value: 10 }], c)).toBe("match");
  });

  it("only reads the contact's own keys, never inherited ones", () => {
    expect(run([{ field: "trait", key: "constructor", op: "is_set" }])).toBe("no_match");
    expect(run([{ field: "trait", key: "toString", op: "is_set" }])).toBe("no_match");
  });

  it("copes with properties that are null or not an object", () => {
    expect(run([{ field: "trait", key: "a", op: "is_not_set" }], contact({ properties: null }))).toBe("match");
    expect(run([{ field: "plan", op: "is_not", value: "Pro" }], contact({ properties: "oops" }))).toBe("match");
    expect(run([{ field: "trait", key: "a", op: "is_not_set" }], contact({ properties: [1, 2] }))).toBe("match");
  });
});

describe("combining conditions", () => {
  it("needs every condition, and reports the first that failed", () => {
    const result = evaluateAudience(
      { conditions: [
        { field: "payment_status", op: "is", value: "paid" },
        { field: "plan", op: "is", value: "Growth" },
        { field: "trait", key: "country", op: "is", value: "Ghana" },
      ] },
      contact(),
    );
    expect(result.outcome).toBe("no_match");
    expect(result.outcome === "no_match" && result.failed).toMatchObject({ field: "plan" });
    expect(run([
      { field: "payment_status", op: "is", value: "paid" },
      { field: "plan", op: "is", value: "Pro" },
      { field: "trait", key: "country", op: "is", value: "Ghana" },
    ])).toBe("match");
  });
});

describe("a bad audience fails closed", () => {
  it.each([
    ["unknown field", { conditions: [{ field: "hair", op: "is", value: "x" }] }],
    ["unknown operator", { conditions: [{ field: "plan", op: "like", value: "x" }] }],
    ["wrong value type", { conditions: [{ field: "payment_status", op: "is", value: "vip" }] }],
    ["non-numeric gt", { conditions: [{ field: "trait", key: "a", op: "gt", value: "ten" }] }],
    ["bad trait key", { conditions: [{ field: "trait", key: "a b", op: "is_set" }] }],
    ["no conditions", { conditions: [] }],
    ["extra keys", { conditions: [{ field: "plan", op: "is", value: "x", sneaky: 1 }] }],
    ["not an object", "paid"],
    ["too many", { conditions: Array.from({ length: AUDIENCE_MAX_CONDITIONS + 1 }, () => ({ field: "has_email", op: "is", value: true })) }],
  ])("%s", (_name, audience) => {
    expect(evaluateAudience(audience, contact()).outcome).toBe("invalid");
  });
});

describe("helpers", () => {
  it("readAudience and stripAudience", () => {
    const cfg = { from: "engaged", to: "at_risk", audience: { conditions: [] } };
    expect(readAudience(cfg)).toEqual({ conditions: [] });
    expect(readAudience({ event: "x" })).toBeUndefined();
    expect(readAudience(null)).toBeUndefined();
    expect(stripAudience(cfg)).toEqual({ from: "engaged", to: "at_risk" });
    expect(cfg.audience).toBeDefined(); // original untouched
    const plain = { event: "x" };
    expect(stripAudience(plain)).toBe(plain);
    expect(stripAudience(null)).toBeNull();
  });

  it("the schema accepts what the editor will send", () => {
    expect(audienceSchema.safeParse({ conditions: [{ field: "payment_status", op: "in", value: ["paid", "trial"] }] }).success).toBe(true);
  });
});
