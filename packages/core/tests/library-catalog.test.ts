/**
 * The library catalog: every ready-made flow must be installable and runnable as shipped.
 * Pure checks on the data, so a typo in copy or a bad plan fails here, not in a customer's workspace.
 */
import { describe, it, expect } from "vitest";
import { LIBRARY_CATALOG, libraryEntry, compiledPlanSchema, LIFECYCLE_STATES } from "../src/index.js";

describe("library catalog", () => {
  it("has the welcome flow first and at least six more", () => {
    expect(LIBRARY_CATALOG[0]!.id).toBe("welcome-onboarding");
    expect(LIBRARY_CATALOG.length).toBeGreaterThanOrEqual(7);
  });

  it("uses unique ids, flow names and template slugs across the whole catalog", () => {
    const ids = LIBRARY_CATALOG.map((e) => e.id);
    const names = LIBRARY_CATALOG.map((e) => e.flow.name);
    const slugs = LIBRARY_CATALOG.flatMap((e) => e.templates.map((t) => t.slug));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    // The welcome set may be shared by reference, but no slug may repeat between different flows.
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  for (const e of LIBRARY_CATALOG) {
    describe(e.id, () => {
      it("has a valid compiled plan", () => {
        const parsed = compiledPlanSchema.safeParse(e.flow.compiledPlan);
        expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
      });

      it("references only templates it ships, and each has a subject and a body", () => {
        const slugs = new Set(e.templates.map((t) => t.slug));
        for (const step of e.flow.compiledPlan.steps) expect(slugs.has(step.template_ref), step.template_ref).toBe(true);
        for (const step of e.flow.steps) expect(slugs.has(step.template_ref)).toBe(true);
        for (const t of e.templates) {
          expect(t.subject.length).toBeGreaterThan(5);
          expect(t.bodyHtml).toContain("{{contact.first_name|there}}");
          expect(t.bodyText ?? "").not.toMatch(/<[a-z]/i);
        }
      });

      it("is a short, polite sequence: three emails at most, with steps in order", () => {
        expect(e.flow.steps.length).toBeGreaterThanOrEqual(2 - (e.id === "welcome-onboarding" ? 0 : 0));
        expect(e.flow.steps.length).toBeLessThanOrEqual(3);
        e.flow.steps.forEach((s, i) => expect(s.order).toBe(i + 1));
      });

      it("uses only real lifecycle states in its triggers, conditions and exits", () => {
        const states = new Set<string>(LIFECYCLE_STATES);
        const cfg = e.flow.triggerConfig as { from?: string; to?: string };
        if (e.flow.triggerType === "lifecycle_transition") {
          expect(states.has(cfg.from!)).toBe(true);
          expect(states.has(cfg.to!)).toBe(true);
        }
        for (const s of e.flow.compiledPlan.steps as Array<{ condition?: Record<string, string> }>) {
          const c = s.condition;
          if (c) for (const v of Object.values(c)) expect(states.has(v), v).toBe(true);
        }
        for (const x of e.flow.compiledPlan.exit_conditions as Array<{ lifecycle_state_change?: { to: string } }>) {
          if (x.lifecycle_state_change) expect(states.has(x.lifecycle_state_change.to)).toBe(true);
        }
      });

      it("says which event it needs exactly when it is event-triggered", () => {
        if (e.flow.triggerType === "event") {
          expect(e.needsEvent).toBe((e.flow.triggerConfig as { event: string }).event);
        } else {
          expect(e.needsEvent).toBeNull();
        }
      });

      it("is findable by id", () => {
        expect(libraryEntry(e.id)).toBe(e);
      });
    });
  }
});

describe("recommendedLibraryFlow", () => {
  it("maps each signup goal to a flow that exists, and gives no recommendation without a goal", async () => {
    const { recommendedLibraryFlow, ONBOARDING_GOALS } = await import("../src/index.js");
    for (const g of ONBOARDING_GOALS) {
      const id = recommendedLibraryFlow(g);
      expect(id, g).not.toBeNull();
      expect(libraryEntry(id!), g).toBeDefined();
    }
    expect(recommendedLibraryFlow(null)).toBeNull();
    expect(recommendedLibraryFlow("something-else")).toBeNull();
  });
});
