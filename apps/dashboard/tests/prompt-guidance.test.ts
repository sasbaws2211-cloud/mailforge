/**
 * The "what the AI can use" help in the flow editor.
 *
 * It must (a) actually render, and (b) stay true: it describes the drafting context built in
 * packages/worker/src/context-assembler.ts, so one test reads that file and fails if the two drift apart.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PromptGuidance } from "../src/components/prompt-guidance.js";
import { AI_CANNOT_USE, AI_CAN_USE, PROMPT_EXAMPLE_FAILS, PROMPT_EXAMPLE_FAILS_WHY, PROMPT_EXAMPLE_WORKS } from "../src/prompt-guidance.js";

const repoPath = (rel: string) => resolve(__dirname, "../../..", rel);
const repo = (rel: string) => readFileSync(repoPath(rel), "utf8");
// The written guides are not mounted in every environment (the dev container mounts only the code).
// Say so loudly as a skipped suite instead of failing, or worse, passing without having looked.
const guidesPresent = existsSync(repoPath("guide/FLOW-PROMPTS.md")) && existsSync(repoPath("guide/INGESTION.md"));

describe("PromptGuidance component", () => {
  const html = renderToStaticMarkup(createElement(PromptGuidance));

  it("is a closed-by-default disclosure with a clear title", () => {
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("What the AI can use when it writes each email");
  });

  it("lists everything the AI is given and everything it is not", () => {
    for (const line of [...AI_CAN_USE, ...AI_CANNOT_USE]) {
      // renderToStaticMarkup escapes quotes and apostrophes; compare on the escaped text.
      const escaped = line.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
      expect(html, line).toContain(escaped);
    }
  });

  it("shows one prompt that works and one that cannot, with the reason", () => {
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
    expect(html).toContain(esc(PROMPT_EXAMPLE_WORKS));
    expect(html).toContain(esc(PROMPT_EXAMPLE_FAILS));
    expect(html).toContain(esc(PROMPT_EXAMPLE_FAILS_WHY));
  });
});

describe("the guidance matches what the AI is actually given", () => {
  // The contact block of the drafting context, as written in the assembler.
  const assembler = repo("packages/worker/src/context-assembler.ts");
  const start = assembler.indexOf("const draftCtx: DraftPromptContext");
  const contactBlock = assembler.slice(assembler.indexOf("contact: {", start), assembler.indexOf("lifecycle: {", start));

  it("the contact fields the AI gets are the ones the help names", () => {
    for (const field of ["name:", "email:", "company:", "plan:"]) expect(contactBlock, field).toContain(field);
    // Custom traits are not passed through: no properties bag, no first_name.
    expect(contactBlock).not.toContain("properties");
    expect(contactBlock).not.toContain("first_name");
    // So the help must not promise them.
    expect(AI_CAN_USE.join(" ")).not.toMatch(/first_name(?! or plan_name)/);
  });

  it("the plan name the help tells people to send is really stored, and really read by the AI's context", () => {
    // identify's "plan" trait (when it is not a payment status word) is written to properties.plan ...
    expect(repo("packages/api/src/routes/ingest.ts")).toContain("propsToMerge.plan = value");
    // ... and the contact section of the AI's context reads that same property.
    expect(repo("packages/worker/src/context-contact.ts")).toContain('row.properties["plan"]');
    expect(AI_CAN_USE.join(" ")).toMatch(/send it as plan/);
  });

  it("event details are kept out of the prompt, as the help says", () => {
    const events = repo("packages/worker/src/context-events.ts");
    expect(events).toMatch(/Properties are excluded/);
    expect(AI_CANNOT_USE.join(" ")).toMatch(/details inside an event/);
  });

  it("the payment statuses named in the help are the ones the API accepts", () => {
    const ingest = repo("packages/api/src/routes/ingest.ts");
    const set = /VALID_PAYMENT_STATUSES = new Set\(\[([^\]]*)\]/.exec(ingest)?.[1] ?? "";
    const accepted = [...set.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(accepted.sort()).toEqual(["cancelled", "free", "paid", "past_due", "trial"]);
    expect(AI_CAN_USE.join(" ")).toMatch(/free, trial, paid, past due or cancelled/);
  });
});

describe.skipIf(!guidesPresent)("the written guides carry the same advice", () => {
  const prompts = guidesPresent ? repo("guide/FLOW-PROMPTS.md") : "";
  const ingestion = guidesPresent ? repo("guide/INGESTION.md") : "";

  it("FLOW-PROMPTS.md has the section, with the given / not given lists and the one-nurture-flow rule", () => {
    expect(prompts).toContain("## What the AI can see when it writes each email");
    expect(prompts).toContain("**The AI is given, for every email:**");
    expect(prompts).toContain("**The AI is not given:**");
    expect(prompts).toMatch(/details inside an event/);
    expect(prompts).toMatch(/only \*\*one nurture flow at a time\*\*/);
    expect(prompts).toContain("`value_gated`");
  });

  it("INGESTION.md explains which traits matter and that plan is a status, not a plan name", () => {
    expect(ingestion).toContain("## What the AI sees of the data you send");
    expect(ingestion).toMatch(/`traits\.name`/);
    expect(ingestion).toMatch(/`first_name` but the AI does not see it|AI does not see it/);
    expect(ingestion).toContain("`traits.plan` is the **name of the plan**");
    expect(ingestion).toContain("`traits.payment_status` is only ever a **status**");
    expect(ingestion).toContain("FLOW-PROMPTS.md#what-the-ai-can-see-when-it-writes-each-email");
  });

  it("the anchor INGESTION.md links to exists as a heading in FLOW-PROMPTS.md", () => {
    const heading = "What the AI can see when it writes each email";
    const slug = heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");
    expect(ingestion).toContain(`#${slug}`);
    expect(prompts).toContain(`## ${heading}`);
  });
});
