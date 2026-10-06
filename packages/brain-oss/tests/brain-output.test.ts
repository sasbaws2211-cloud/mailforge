/**
 * Tests for brain output schemas: decideOutputSchema, draftOutputSchema,
 * and assessOutputSchema.
 *
 * These schemas validate runtime output from brain.decide(), brain.draft(),
 * and brain.assess(). Defined in @mailforge/core, re-exported through @mailforge/brain-oss.
 */
import { describe, it, expect } from "vitest";
import { decideOutputSchema, draftOutputSchema, assessOutputSchema } from "../src/index.js";

// ---------------------------------------------------------------------------
// decideOutputSchema
// ---------------------------------------------------------------------------

describe("decideOutputSchema", () => {
  it("accepts action=contact (minimal)", () => {
    const result = decideOutputSchema.safeParse({ action: "contact" });
    expect(result.success).toBe(true);
  });

  it("accepts action=skip (minimal)", () => {
    const result = decideOutputSchema.safeParse({ action: "skip" });
    expect(result.success).toBe(true);
  });

  it("accepts action=wait (minimal)", () => {
    const result = decideOutputSchema.safeParse({ action: "wait" });
    expect(result.success).toBe(true);
  });

  it("accepts valid payload with all optional fields", () => {
    const result = decideOutputSchema.safeParse({
      action: "contact",
      confidence: 0.87,
      reasoning: "Contact is highly engaged and the timing is appropriate.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action).toBe("contact");
      expect(result.data.confidence).toBe(0.87);
    }
  });

  it("accepts confidence=0 (boundary)", () => {
    const result = decideOutputSchema.safeParse({ action: "skip", confidence: 0 });
    expect(result.success).toBe(true);
  });

  it("accepts confidence=1 (boundary)", () => {
    const result = decideOutputSchema.safeParse({ action: "contact", confidence: 1 });
    expect(result.success).toBe(true);
  });

  it("rejects unknown action value (noop)", () => {
    const result = decideOutputSchema.safeParse({ action: "noop" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown action value (send)", () => {
    const result = decideOutputSchema.safeParse({ action: "send" });
    expect(result.success).toBe(false);
  });

  it("rejects missing action field", () => {
    const result = decideOutputSchema.safeParse({ confidence: 0.5, reasoning: "some reason" });
    expect(result.success).toBe(false);
  });

  it("rejects confidence below 0", () => {
    const result = decideOutputSchema.safeParse({ action: "contact", confidence: -0.1 });
    expect(result.success).toBe(false);
  });

  it("rejects confidence above 1", () => {
    const result = decideOutputSchema.safeParse({ action: "contact", confidence: 1.1 });
    expect(result.success).toBe(false);
  });

  it("rejects non-string action", () => {
    const result = decideOutputSchema.safeParse({ action: 42 });
    expect(result.success).toBe(false);
  });

  it("rejects null input", () => {
    const result = decideOutputSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// draftOutputSchema
// ---------------------------------------------------------------------------

describe("draftOutputSchema", () => {
  it("accepts valid payload", () => {
    const result = draftOutputSchema.safeParse({
      subject: "We noticed you haven't logged in recently",
      body_markdown: "## Hi there\n\nWe'd love to see you back.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subject).toBe("We noticed you haven't logged in recently");
      expect(result.data.body_markdown).toContain("## Hi there");
    }
  });

  it("rejects empty subject", () => {
    const result = draftOutputSchema.safeParse({
      subject: "",
      body_markdown: "Some content here.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty body_markdown", () => {
    const result = draftOutputSchema.safeParse({
      subject: "A valid subject",
      body_markdown: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing subject", () => {
    const result = draftOutputSchema.safeParse({
      body_markdown: "Some content here.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing body_markdown", () => {
    const result = draftOutputSchema.safeParse({
      subject: "A valid subject",
    });
    expect(result.success).toBe(false);
  });

  it("rejects old body field name (body instead of body_markdown)", () => {
    const result = draftOutputSchema.safeParse({
      subject: "A valid subject",
      body: "Some content here.",
    });
    // body is not a recognized field; body_markdown is missing -> failure
    expect(result.success).toBe(false);
  });

  it("rejects null input", () => {
    const result = draftOutputSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assessOutputSchema (task 20)
// ---------------------------------------------------------------------------

describe("assessOutputSchema", () => {
  it("accepts verdict=pass with reasoning", () => {
    const result = assessOutputSchema.safeParse({ verdict: "pass", reasoning: "Good email." });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verdict).toBe("pass");
      expect(result.data.reasoning).toBe("Good email.");
    }
  });

  it("accepts verdict=fail with reasoning", () => {
    const result = assessOutputSchema.safeParse({ verdict: "fail", reasoning: "Too generic." });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verdict).toBe("fail");
    }
  });

  it("rejects unknown verdict value", () => {
    const result = assessOutputSchema.safeParse({ verdict: "maybe", reasoning: "Not sure." });
    expect(result.success).toBe(false);
  });

  it("rejects missing verdict", () => {
    const result = assessOutputSchema.safeParse({ reasoning: "Some reasoning." });
    expect(result.success).toBe(false);
  });

  it("rejects missing reasoning", () => {
    const result = assessOutputSchema.safeParse({ verdict: "pass" });
    expect(result.success).toBe(false);
  });

  it("rejects empty reasoning string (min(1))", () => {
    const result = assessOutputSchema.safeParse({ verdict: "pass", reasoning: "" });
    expect(result.success).toBe(false);
  });

  it("rejects null input", () => {
    const result = assessOutputSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});
