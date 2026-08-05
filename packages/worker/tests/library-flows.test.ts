/**
 * Unit tests for library-flows.ts.
 *
 * Validates that the pre-compiled plan and templates are structurally correct
 * and compatible with the compiled plan schema and template renderer.
 */
import { describe, it, expect } from "vitest";
import {
  LIBRARY_TEMPLATES,
  LIBRARY_FLOW_WELCOME,
  compiledPlanSchema,
} from "@claros/core";
import { renderTemplate, type TemplateContext } from "../src/template-renderer.js";

describe("library-flows", () => {
  it("LIBRARY_FLOW_WELCOME compiled plan passes schema validation", () => {
    const result = compiledPlanSchema.safeParse(LIBRARY_FLOW_WELCOME.compiledPlan);
    expect(result.success).toBe(true);
    if (!result.success) {
      console.error(result.error.issues);
    }
  });

  it("every step template_ref has a matching template slug", () => {
    const templateSlugs = LIBRARY_TEMPLATES.map((t) => t.slug);
    for (const step of LIBRARY_FLOW_WELCOME.compiledPlan.steps) {
      expect(templateSlugs).toContain(step.template_ref);
    }
  });

  it("all templates render successfully with a complete context", () => {
    const ctx: TemplateContext = {
      contact: {
        first_name: "Test",
        last_name: "User",
        email: "test@example.com",
        external_id: "ext-1",
        properties: {},
      },
      tenant: { name: "MyApp" },
      flow: { name: "Welcome Onboarding" },
    };

    for (const tmpl of LIBRARY_TEMPLATES) {
      const result = renderTemplate(
        tmpl.subject,
        tmpl.bodyHtml,
        tmpl.bodyText,
        ctx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.subject.length).toBeGreaterThan(0);
        expect(result.bodyHtml.length).toBeGreaterThan(0);
      }
    }
  });

  it("templates declare only tenant.name as a required variable (first_name uses fallback)", () => {
    for (const tmpl of LIBRARY_TEMPLATES) {
      expect(tmpl.variables).toContain("tenant.name");
      // contact.first_name uses pipe-fallback syntax, so it is NOT a required variable
      expect(tmpl.variables).not.toContain("contact.first_name");
    }
  });

  it("templates render successfully even without contact.first_name", () => {
    const ctx: TemplateContext = {
      contact: {
        first_name: null,
        last_name: null,
        email: "anon@example.com",
        external_id: "ext-anon",
        properties: {},
      },
      tenant: { name: "MyApp" },
      flow: { name: "Welcome Onboarding" },
    };

    for (const tmpl of LIBRARY_TEMPLATES) {
      const result = renderTemplate(
        tmpl.subject,
        tmpl.bodyHtml,
        tmpl.bodyText,
        ctx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The fallback "there" should appear where first_name would be
        expect(result.bodyHtml).toContain("Hi there,");
      }
    }
  });

  it("flow has approval_mode auto (no human approval needed for templates)", () => {
    expect(LIBRARY_FLOW_WELCOME.approvalMode).toBe("auto");
  });

  it("flow has reentry_policy once (contact gets welcome only once)", () => {
    expect(LIBRARY_FLOW_WELCOME.reentryPolicy).toBe("once");
  });

  it("first step has delay 0m (immediate send on enrollment)", () => {
    expect(LIBRARY_FLOW_WELCOME.compiledPlan.steps[0]!.delay).toBe("0m");
  });

  it("first step has window_policy immediate (bypasses send window)", () => {
    expect(LIBRARY_FLOW_WELCOME.compiledPlan.steps[0]!.window_policy).toBe("immediate");
  });

  it("exit condition fires on activated event", () => {
    expect(LIBRARY_FLOW_WELCOME.compiledPlan.exit_conditions).toEqual([
      { event: "activated" },
    ]);
  });
});
