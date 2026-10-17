/**
 * The plan preview: a straight-line plan reads as before, a branching plan reads as an outline of its paths.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { CompiledPlanPreview } from "../src/pages/FlowEditorPage.js";

const render = (plan: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(CompiledPlanPreview, { plan })),
    ),
  );

const trigger = { type: "event", condition: { event: "signed_up" } };
const email = (order: number, extra: Record<string, unknown> = {}) => ({
  order,
  action_type: "nurture_value",
  delay: "0m",
  window_policy: "respect_window",
  ...extra,
});

describe("a straight-line plan", () => {
  it("reads as before: 'Then, in order', no split", () => {
    const html = render({ trigger, steps: [email(1), email(2, { delay: "2d", condition: { lifecycle_state: "at_risk" } })] });
    expect(html).toContain("Then, in order");
    expect(html).not.toContain("Then, following these paths");
    expect(html).not.toContain("Split.");
    expect(html).toContain("after 2 days");
    expect(html).toContain("only if");
  });
});

describe("a branching plan", () => {
  const plan = {
    version: 2,
    trigger,
    steps: [email(1, { next: 2 }), email(3, { next: "end", brain_instruction: "Congratulate them." }), email(4, { next: "end", delay: "1d" })],
    branches: [
      { order: 2, delay: "3d", condition: { field: "event", name: "project_created", op: "performed", since: "flow" }, then: 3, else: 4 },
    ],
  };

  it("reads as an outline of paths", () => {
    const html = render(plan);
    expect(html).toContain("Then, following these paths");
    expect(html).not.toContain("Then, in order");
    expect(html).toContain("Split.");
    expect(html).toContain("after 3 days");
    expect(html).toContain("did project_created since entering the flow");
    expect(html).toContain("If yes");
    expect(html).toContain("Otherwise");
    expect(html.match(/The flow ends here\./g)).toHaveLength(2);
  });

  it("shows each email once, with its details, indented under its path", () => {
    const html = render(plan);
    expect(html.match(/nurture_value/g)).toHaveLength(3);
    expect(html).toContain("Congratulate them.");
    expect(html).toContain("margin-left:40px"); // emails sit two levels in, under 'If yes' / 'Otherwise'
    expect(html).toContain("margin-left:0px");
  });

  it("says when paths rejoin instead of repeating the step", () => {
    const joined = {
      version: 2,
      trigger,
      steps: [email(2, { next: 4 }), email(3, { next: 4 }), email(4, { next: "end" })],
      branches: [{ order: 1, delay: "0m", condition: { lifecycle_state: "engaged" }, then: 2, else: 3 }],
    };
    const html = render(joined);
    expect(html.match(/nurture_value/g)).toHaveLength(3);
    expect(html).toContain("Continues at step 4, shown above.");
  });

  it("does not hang or crash on a plan the engine would refuse", () => {
    const loop = { version: 2, trigger, steps: [email(1, { next: 2 }), email(2, { next: 1 })] };
    expect(() => render(loop)).not.toThrow();
  });

  it("still shows the flow-wide exits", () => {
    const html = render({ ...plan, exit_conditions: [{ condition: { field: "payment_status", op: "is", value: "cancelled" } }] });
    expect(html).toContain("The flow ends early if");
    expect(html).toContain("payment status is cancelled");
  });
});
