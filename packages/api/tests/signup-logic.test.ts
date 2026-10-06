/**
 * Tests for signup validation, slug generation and the rate limiter.
 * Pure functions: no database needed.
 */
import { describe, it, expect } from "vitest";
import { createLimiter, slugify, slugWithSuffix, validateSignup } from "../src/marketing/signup-logic.js";

const good = { workspace: "Acme Inc", email: "Ama@Acme.com ", terms: "yes", website: "" };

describe("validateSignup", () => {
  it("accepts a good form and normalizes email and workspace", () => {
    const r = validateSignup({ ...good, workspace: "  Acme   Inc  " });
    expect(r).toEqual({ ok: true, value: { workspace: "Acme Inc", email: "ama@acme.com", plan: "growth", goal: null } });
  });

  it("accepts JSON-style booleans for terms", () => {
    expect(validateSignup({ ...good, terms: true }).ok).toBe(true);
    expect(validateSignup({ ...good, terms: "on" }).ok).toBe(true);
  });

  it("treats a filled honeypot as a bot, silently", () => {
    expect(validateSignup({ ...good, website: "http://spam.test" })).toEqual({ ok: false, kind: "bot" });
  });

  it("rejects short, long and missing workspace names", () => {
    for (const workspace of ["", "A", "x".repeat(61), undefined, 42]) {
      const r = validateSignup({ ...good, workspace });
      expect(r.ok, String(workspace)).toBe(false);
      if (!r.ok && r.kind === "invalid") expect(r.message).toMatch(/workspace name/i);
    }
  });

  it("rejects malformed emails", () => {
    for (const email of ["", "nope", "a@b", "a b@c.com", "<x>@c.com", "a@@c.com", "x".repeat(250) + "@c.com"]) {
      const r = validateSignup({ ...good, email });
      expect(r.ok, email).toBe(false);
    }
  });

  it("rejects disposable-mailbox domains with a clear message", () => {
    const r = validateSignup({ ...good, email: "x@mailinator.com" });
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === "invalid") expect(r.message).toMatch(/disposable/i);
  });

  it("requires accepting the terms", () => {
    for (const terms of [undefined, "", "no", false]) {
      const r = validateSignup({ ...good, terms });
      expect(r.ok, String(terms)).toBe(false);
      if (!r.ok && r.kind === "invalid") expect(r.message).toMatch(/terms/i);
    }
  });

  it("keeps a valid plan and falls back to the trial plan for anything else", () => {
    const ok = (plan: unknown) => {
      const r = validateSignup({ ...good, plan });
      return r.ok ? r.value.plan : null;
    };
    expect(ok("free")).toBe("free");
    expect(ok("scale")).toBe("scale");
    expect(ok("enterprise")).toBe("growth");
    expect(ok(undefined)).toBe("growth");
    expect(ok("<script>")).toBe("growth");
  });

  it("copes with a non-object body", () => {
    expect(validateSignup(null).ok).toBe(false);
    expect(validateSignup("a=b").ok).toBe(false);
    expect(validateSignup(undefined).ok).toBe(false);
  });
});

describe("slugify", () => {
  it("makes url-safe slugs", () => {
    expect(slugify("Acme Inc")).toBe("acme-inc");
    expect(slugify("  Acme -- Inc!!  ")).toBe("acme-inc");
    expect(slugify("Café Crème")).toBe("cafe-creme");
  });

  it("never returns an empty slug", () => {
    expect(slugify("!!!")).toBe("workspace");
    expect(slugify("中文")).toBe("workspace");
  });

  it("caps the length and never ends in a dash", () => {
    const s = slugify("a".repeat(39) + " b" + "c".repeat(30));
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith("-")).toBe(false);
  });

  it("adds a short random suffix when asked", () => {
    const a = slugWithSuffix("Acme");
    const b = slugWithSuffix("Acme");
    expect(a).toMatch(/^acme-[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
  });
});

describe("createLimiter", () => {
  it("allows up to max hits per window, then blocks with a retry hint", () => {
    const l = createLimiter({ windowMs: 60_000, max: 3 });
    const t = 1_000_000;
    expect(l.hit("k", t).allowed).toBe(true);
    expect(l.hit("k", t + 1).allowed).toBe(true);
    expect(l.hit("k", t + 2).allowed).toBe(true);
    const blocked = l.hit("k", t + 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("keys are independent", () => {
    const l = createLimiter({ windowMs: 60_000, max: 1 });
    expect(l.hit("a", 1).allowed).toBe(true);
    expect(l.hit("b", 1).allowed).toBe(true);
    expect(l.hit("a", 2).allowed).toBe(false);
  });

  it("resets after the window", () => {
    const l = createLimiter({ windowMs: 1_000, max: 1 });
    expect(l.hit("k", 0).allowed).toBe(true);
    expect(l.hit("k", 500).allowed).toBe(false);
    expect(l.hit("k", 1_001).allowed).toBe(true);
  });

  it("retry hint counts down to the window end", () => {
    const l = createLimiter({ windowMs: 10_000, max: 1 });
    l.hit("k", 0);
    expect(l.hit("k", 4_000).retryAfterSec).toBe(6);
  });
});

describe("validateSignup: goal", () => {
  const goal = (g: unknown) => {
    const r = validateSignup({ ...good, goal: g });
    return r.ok ? r.value.goal : "invalid";
  };
  it("keeps a known goal", () => {
    for (const g of ["welcome", "convert_trials", "upgrade_free", "explore"]) expect(goal(g)).toBe(g);
  });
  it("is null when skipped", () => {
    expect(goal(undefined)).toBeNull();
    expect(goal("")).toBeNull();
  });
  it("ignores an unknown or hostile goal instead of failing the signup", () => {
    for (const g of ["WELCOME", "buy_now", "<script>", 7, {}, ["welcome"]]) expect(goal(g)).toBeNull();
  });
});
