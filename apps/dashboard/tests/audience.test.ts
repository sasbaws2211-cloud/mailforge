/**
 * The flow trigger audience editor: rows <-> API shape, plain-English summaries, and the component.
 *
 * The contract test at the bottom runs everything the editor can produce through the SERVER's schema
 * (packages/core/src/audience.ts), so the two cannot drift apart unnoticed.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_AUDIENCE_CONDITIONS,
  audienceToRows,
  changeField,
  changeOp,
  describeAudience,
  newRow,
  opsFor,
  rowsToAudience,
  type AudienceRow,
} from "../src/audience.js";
import { AudienceEditor } from "../src/components/audience-editor.js";
import { audienceSchema, AUDIENCE_MAX_CONDITIONS } from "../../../packages/core/src/audience.js";

const row = (over: Partial<AudienceRow>): AudienceRow => ({ ...newRow(), ...over });

describe("rowsToAudience", () => {
  it("no rows means no audience (everyone)", () => {
    expect(rowsToAudience([])).toEqual({ audience: null, errors: {} });
  });

  it("builds each kind of condition", () => {
    const rows = [
      row({ field: "payment_status", op: "is", value: "paid" }),
      row({ field: "payment_status", op: "in", values: ["trial", "paid"] }),
      row({ field: "engagement_depth", op: "is_not", value: "minimal" }),
      row({ field: "plan", op: "is", value: " Pro " }),
      row({ field: "has_email", op: "is", value: "no" }),
    ];
    expect(rowsToAudience(rows).audience?.conditions).toEqual([
      { field: "payment_status", op: "is", value: "paid" },
      { field: "payment_status", op: "in", value: ["trial", "paid"] },
      { field: "engagement_depth", op: "is_not", value: "minimal" },
      { field: "plan", op: "is", value: "Pro" },
      { field: "has_email", op: "is", value: false },
    ]);
  });

  it("builds trait conditions, with numbers for greater/less than", () => {
    const rows = [
      row({ field: "trait", key: "country", op: "is", value: "Ghana" }),
      row({ field: "trait", key: "seats", op: "gt", value: "10" }),
      row({ field: "trait", key: "note", op: "contains", value: "api" }),
      row({ field: "trait", key: "beta", op: "is_set", value: "" }),
    ];
    expect(rowsToAudience(rows).audience?.conditions).toEqual([
      { field: "trait", key: "country", op: "is", value: "Ghana" },
      { field: "trait", key: "seats", op: "gt", value: 10 },
      { field: "trait", key: "note", op: "contains", value: "api" },
      { field: "trait", key: "beta", op: "is_set" },
    ]);
  });

  it("reports a problem per row and sends nothing while any remain", () => {
    const rows = [
      row({ field: "plan", op: "is", value: "" }),
      row({ field: "trait", key: "", op: "is", value: "x" }),
      row({ field: "trait", key: "bad key", op: "is", value: "x" }),
      row({ field: "trait", key: "seats", op: "gt", value: "ten" }),
      row({ field: "payment_status", op: "in", values: [] }),
      row({ field: "payment_status", op: "is", value: "vip" }),
      row({ field: "plan", op: "is", value: "fine" }),
    ];
    const result = rowsToAudience(rows);
    expect(result.audience).toBeNull();
    expect(Object.keys(result.errors)).toEqual(rows.slice(0, 6).map((r) => r.id));
  });
});

describe("changing a row", () => {
  it("changing the field restarts the operator and value but keeps the row", () => {
    const before = row({ field: "trait", key: "x", op: "gt", value: "5" });
    const after = changeField(before, "payment_status");
    expect(after.id).toBe(before.id);
    expect(after).toMatchObject({ field: "payment_status", op: "is", key: "", value: "free" });
  });

  it("switching to 'is one of' keeps the chosen value, and back keeps the first", () => {
    const r = changeOp(row({ field: "payment_status", op: "is", value: "paid" }), "in");
    expect(r.values).toEqual(["paid"]);
    expect(changeOp({ ...r, values: ["trial", "paid"] }, "is").value).toBe("trial");
  });

  it("offers only sensible operators per field", () => {
    expect(opsFor("has_email")).toEqual(["is"]);
    expect(opsFor("plan")).toEqual(["is", "is_not"]);
    expect(opsFor("trait")).toContain("gt");
  });
});

describe("audienceToRows", () => {
  it("nothing stored is simply no rows", () => {
    expect(audienceToRows(undefined)).toEqual({ rows: [], unreadable: false });
    expect(audienceToRows(null)).toEqual({ rows: [], unreadable: false });
  });

  it("turns a stored audience back into the same audience", () => {
    const audience = {
      conditions: [
        { field: "payment_status", op: "in", value: ["trial", "paid"] },
        { field: "plan", op: "is_not", value: "Free" },
        { field: "has_email", op: "is", value: true },
        { field: "trait", key: "seats", op: "lt", value: 5 },
        { field: "trait", key: "beta", op: "is_not_set" },
      ],
    };
    const { rows, unreadable } = audienceToRows(audience);
    expect(unreadable).toBe(false);
    expect(rowsToAudience(rows).audience).toEqual(audience);
  });

  it("shows a stored true/false/number trait value as text (the server compares text and values alike)", () => {
    const { rows } = audienceToRows({ conditions: [{ field: "trait", key: "vip", op: "is", value: true }] });
    expect(rowsToAudience(rows).audience?.conditions).toEqual([{ field: "trait", key: "vip", op: "is", value: "true" }]);
  });

  it("never guesses at a shape it does not know", () => {
    expect(audienceToRows({ conditions: [{ field: "hair", op: "is", value: "x" }] }).unreadable).toBe(true);
    expect(audienceToRows({ nope: 1 }).unreadable).toBe(true);
    expect(audienceToRows("paid").unreadable).toBe(true);
    expect(audienceToRows({ conditions: [{ field: "plan", op: "is", value: 4 }] }).unreadable).toBe(true);
  });
});

describe("describeAudience", () => {
  it("reads like a sentence", () => {
    expect(
      describeAudience({
        conditions: [
          { field: "payment_status", op: "is", value: "paid" },
          { field: "engagement_depth", op: "in", value: ["power", "regular"] },
          { field: "plan", op: "is", value: "Pro" },
          { field: "has_email", op: "is", value: true },
          { field: "trait", key: "seats", op: "gt", value: 10 },
          { field: "trait", key: "beta", op: "is_set" },
        ],
      }),
    ).toEqual([
      "payment status is paid",
      "engagement is one of power, regular",
      "plan is Pro",
      "has an email address",
      "seats is greater than 10",
      "beta is set",
    ]);
  });

  it("says so when it cannot show the stored filter", () => {
    expect(describeAudience({ conditions: [{ field: "hair", op: "is", value: "x" }] })).toEqual([
      "a filter this editor cannot show",
    ]);
  });
});

describe("AudienceEditor", () => {
  const render = (rows: AudienceRow[], errors = {}) =>
    renderToStaticMarkup(createElement(AudienceEditor, { rows, onChange: () => {}, errors }));

  it("with no rows says everyone enters, and offers to add one", () => {
    const html = render([]);
    expect(html).toContain("Everyone who matches the trigger enters the flow.");
    expect(html).toContain("Add a condition");
  });

  it("shows each row with its controls and 'and' between them", () => {
    const html = render([row({}), row({ field: "trait", key: "country", op: "is", value: "Ghana" })]);
    expect(html).toContain("Only if");
    expect(html).toContain(">and<");
    expect(html).toContain('aria-label="Condition 2 trait name"');
    expect(html).toContain('value="Ghana"');
    expect(html).toContain("Add another");
  });

  it("shows a row's problem next to it", () => {
    const r = row({ field: "plan", value: "" });
    expect(render([r], { [r.id]: "Enter the plan name." })).toContain("Enter the plan name.");
  });

  it("stops offering more at the limit", () => {
    const html = render(Array.from({ length: MAX_AUDIENCE_CONDITIONS }, () => row({})));
    expect(html).toContain(`Up to ${MAX_AUDIENCE_CONDITIONS} conditions.`);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Add another/);
  });

  it("hides the value box for 'is set' and the comparison for the email field", () => {
    const set = render([row({ field: "trait", key: "k", op: "is_set" })]);
    expect(set).not.toContain('aria-label="Condition 1 value"');
    expect(render([row({ field: "has_email", op: "is", value: "yes" })])).not.toContain("comparison");
  });
});

describe("contract with the server", () => {
  it("every condition the editor can produce is accepted by the server schema", () => {
    const groups: AudienceRow[][] = [
      [
        row({ field: "payment_status", op: "is", value: "past_due" }),
        row({ field: "payment_status", op: "in", values: ["free", "trial", "paid", "past_due", "cancelled"] }),
        row({ field: "engagement_depth", op: "in", values: ["power", "regular", "casual", "minimal"] }),
        row({ field: "plan", op: "is_not", value: "Free" }),
        row({ field: "has_email", op: "is", value: "yes" }),
      ],
      [
        row({ field: "trait", key: "a.b-c_d", op: "is", value: "x" }),
        row({ field: "trait", key: "n", op: "lt", value: "-2.5" }),
        row({ field: "trait", key: "n", op: "is_not_set" }),
        row({ field: "trait", key: "t", op: "contains", value: "y" }),
        row({ field: "trait", key: "g", op: "gt", value: "0" }),
      ],
    ];
    for (const rows of groups) {
      const { audience, errors } = rowsToAudience(rows);
      expect(errors).toEqual({});
      expect(audienceSchema.safeParse(audience).success).toBe(true);
    }
  });

  it("the limit matches the server's", () => {
    expect(MAX_AUDIENCE_CONDITIONS).toBe(AUDIENCE_MAX_CONDITIONS);
  });
});
