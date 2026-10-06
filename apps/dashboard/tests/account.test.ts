/**
 * Tests for the owner-facing deletion helpers: the typed confirmation and the
 * wording of how long is left. Pure functions.
 */
import { describe, it, expect } from "vitest";
import { confirmationMatches, timeUntilErasure } from "../src/account.js";

const NOW = new Date("2026-10-04T12:00:00Z");
const DAY = 86_400_000;

describe("confirmationMatches", () => {
  it("accepts the exact name, ignoring spaces around it", () => {
    expect(confirmationMatches("acme-co", "acme-co")).toBe(true);
    expect(confirmationMatches("  acme-co  ", "acme-co")).toBe(true);
  });

  it("rejects anything else, including a different case and a prefix", () => {
    expect(confirmationMatches("Acme-Co", "acme-co")).toBe(false);
    expect(confirmationMatches("acme", "acme-co")).toBe(false);
    expect(confirmationMatches("acme-co2", "acme-co")).toBe(false);
    expect(confirmationMatches("", "acme-co")).toBe(false);
  });

  it("never matches while the workspace name is still loading (empty)", () => {
    expect(confirmationMatches("", "")).toBe(false);
    expect(confirmationMatches("   ", "")).toBe(false);
  });
});

describe("timeUntilErasure", () => {
  it("rounds up to whole days and uses the singular", () => {
    expect(timeUntilErasure(new Date(NOW.getTime() + 6 * DAY).toISOString(), NOW)).toBe("in 6 days");
    expect(timeUntilErasure(new Date(NOW.getTime() + DAY).toISOString(), NOW)).toBe("in 1 day");
    expect(timeUntilErasure(new Date(NOW.getTime() + DAY + 1).toISOString(), NOW)).toBe("in 2 days");
    expect(timeUntilErasure(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe("in 1 day");
  });

  it("says today once the time has come", () => {
    expect(timeUntilErasure(NOW.toISOString(), NOW)).toBe("today");
    expect(timeUntilErasure(new Date(NOW.getTime() - DAY).toISOString(), NOW)).toBe("today");
  });
});
