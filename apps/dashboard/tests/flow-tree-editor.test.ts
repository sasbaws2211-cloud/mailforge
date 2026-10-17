/**
 * The flow tree editor, rendered for real (including the existing step editor inside it).
 * Rules under test: a split ends its path, the depth and size limits stop adding, empty paths say the flow
 * ends there, and problems are shown next to the split or condition that has them.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SequenceEditor, type TreeContext } from "../src/components/flow-tree-editor.js";
import { emptySequence, newFork, MAX_FLOW_NODES, MAX_FORK_DEPTH, type ForkData, type SequenceData } from "../src/flow-tree.js";
import { newConditionRow } from "../src/conditions.js";
import type { StepData } from "../src/components/step-writer.js";

let n = 0;
const email = (): StepData => ({
  order: ++n,
  delay: "0m",
  action_type: "nurture_value",
  subject: `Subject ${n}`,
  body_html: "<p>Hi</p>",
  body_text: "",
  window_policy: "respect_window",
});
const fork = (yes: SequenceData = emptySequence(), no: SequenceData = emptySequence()): ForkData => ({
  ...newFork({ ...newConditionRow("payment_status"), op: "is", value: "paid" }),
  yes,
  no,
});

const ctx = (over: Partial<TreeContext> = {}): TreeContext => ({
  flowId: "flow-1",
  hasLlm: false,
  conditionErrors: {},
  eventSuggestions: [],
  totalNodes: 0,
  ...over,
});

const render = (value: SequenceData, c: TreeContext = ctx()) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(SequenceEditor, { value, onChange: () => {}, ctx: c }),
    ),
  );

/** The "Split into two paths" button, found by its label, and whether it is switched off. */
const splitButton = (html: string) => /<button[^>]*>(?:(?!<\/button>)[\s\S])*Split into two paths(?:(?!<\/button>)[\s\S])*<\/button>/.exec(html)?.[0] ?? null;

describe("a flow with no split", () => {
  it("offers the emails and, below them, a way to split", () => {
    const html = render({ steps: [email()], fork: null });
    expect(html).toContain("Add step");
    const button = splitButton(html);
    expect(button).not.toBeNull();
    expect(button).not.toMatch(/disabled=""/);
    expect(html).toContain("sent down one path or the other");
  });

  it("an empty flow can still start with a split", () => {
    expect(splitButton(render(emptySequence()))).not.toMatch(/disabled=""/);
  });

  it("is read-only when disabled", () => {
    expect(splitButton(render({ steps: [email()], fork: null }, ctx({ disabled: true })))).toMatch(/disabled=""/);
  });
});

describe("a flow with a split", () => {
  const withFork = () => render({ steps: [email()], fork: fork() });

  it("shows the split, its wait, its condition, and both paths", () => {
    const html = withFork();
    expect(html).toContain('aria-label="Split 1"');
    expect(html).toContain("Split into two paths");
    expect(html).toContain("After the emails above, wait");
    expect(html).toContain('aria-label="How long to wait before checking"');
    expect(html).toContain('aria-label="If it holds"');
    expect(html).toContain('aria-label="Otherwise"');
    expect(html).toContain('aria-label="Condition 1 field"'); // the condition editor is there
  });

  it("a split is the last thing in its path: no second split button next to it", () => {
    // the only "Split into two paths" button left is the one inside each of the two empty paths
    const buttons = withFork().match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Split into two paths/g) ?? [];
    expect(buttons).toHaveLength(2);
  });

  it("an empty path says the flow ends there", () => {
    expect(withFork()).toContain("Nothing is sent on this path: the flow ends here for these contacts.");
  });

  it("shows emails on each path with a path-specific add button", () => {
    const html = render({ steps: [email()], fork: fork({ steps: [email(), email()], fork: null }, { steps: [email()], fork: null }) });
    expect(html).toContain("Add an email to this path");
    expect(html).not.toContain("Nothing is sent on this path");
    expect(html.match(/Subject line/g)).toHaveLength(4); // one editor per email: 1 + 2 + 1
  });

  it("a split with no condition, or a bad row, shows the problem on the split", () => {
    const f = fork();
    const html = render({ steps: [email()], fork: f }, ctx({ conditionErrors: { [f.id]: "Add at least one condition to decide the path." } }));
    expect(html).toContain("Add at least one condition to decide the path.");
    const rowId = f.condition.rows[0]!.id;
    expect(render({ steps: [email()], fork: f }, ctx({ conditionErrors: { [rowId]: "Enter the plan name." } }))).toContain("Enter the plan name.");
  });
});

describe("limits", () => {
  const nest = (levels: number): SequenceData => {
    let inner: SequenceData = { steps: [email()], fork: null };
    for (let i = 0; i < levels; i++) inner = { steps: [], fork: fork(inner, emptySequence()) };
    return inner;
  };

  const buttonsIn = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Split into two paths/g) ?? [];
  const disabled = (b: string) => /disabled=""/.test(b);

  it("a path two splits down can still split once more", () => {
    // splits F2 > F1: F1's two paths sit at depth 2, which is still under the limit
    const buttons = buttonsIn(render(nest(2)));
    expect(buttons.filter(disabled)).toHaveLength(0);
  });

  it("a path already three splits down cannot split again, and says so", () => {
    // splits F3 > F2 > F1. Four paths have room for a button: F3's and F2's empty 'otherwise' paths (shallower,
    // still allowed) and F1's two paths (depth 3: at the limit).
    const html = render(nest(MAX_FORK_DEPTH));
    const buttons = buttonsIn(html);
    expect(buttons).toHaveLength(4);
    expect(buttons.filter(disabled)).toHaveLength(2);
    expect(html).toContain(`A path can pass through at most ${MAX_FORK_DEPTH} splits.`);
  });

  it("at the size limit nothing more can be added, and it says so", () => {
    const html = render({ steps: [email()], fork: null }, ctx({ totalNodes: MAX_FLOW_NODES }));
    expect(html).toContain(`A flow can have at most ${MAX_FLOW_NODES} emails and splits in total.`);
    expect(splitButton(html)).toMatch(/disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add step/);
  });
});
