/**
 * Unit tests for the throttle gate (pure logic, no I/O).
 *
 * Tests:
 * - L1: Suppression always blocks (including critical flows)
 * - L2: Frequency caps (daily, weekly, min interval)
 * - L3: Send window (timezone-aware timing, day-of-week)
 * - Critical bypass: skips L2 and L3 but NOT L1
 * - Timezone fallback chain: contact -> tenant -> UTC, including invalid IANA
 * - Config resolution: absent/partial/garbage config -> documented defaults
 * - retryAfter correctness (not just presence)
 */
import { describe, it, expect } from "vitest";
import {
  evaluateThrottleGate,
  resolveTimezone,
  isValidTimezone,
  type ThrottleGateInput,
  type ThrottleVerdict,
} from "../src/throttle/gate.js";
import {
  THROTTLE_DEFAULTS,
  resolveThrottleConfig,
  type ThrottleConfig,
} from "../src/throttle/defaults.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<ThrottleGateInput> = {}): ThrottleGateInput {
  // Default: a nurture message, not suppressed, no recent sends,
  // within a Monday 10:00 UTC window
  const now = new Date("2026-07-20T10:00:00Z"); // Monday
  return {
    isSuppressed: false,
    flowClass: "nurture",
    windowPolicy: "respect_window",
    config: { ...THROTTLE_DEFAULTS, send_window_timezone: "tenant_fixed", tenant_timezone: "UTC" },
    recentSends: {
      countLast24h: 0,
      countLast7d: 0,
      lastSentAt: null,
    },
    contactTimezone: null,
    now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// L1: Suppression
// ---------------------------------------------------------------------------

describe("L1: Suppression (hard block)", () => {
  it("blocks a suppressed contact with nurture flow", () => {
    const result = evaluateThrottleGate(makeInput({ isSuppressed: true }));
    expect(result.outcome).toBe("suppress");
    expect((result as { reason: string }).reason).toBe("contact_email_suppressed");
  });

  it("blocks a suppressed contact even with critical flow", () => {
    const result = evaluateThrottleGate(
      makeInput({
        isSuppressed: true,
        flowClass: "critical",
      }),
    );
    expect(result.outcome).toBe("suppress");
    expect((result as { reason: string }).reason).toBe("contact_email_suppressed");
  });

  it("allows a non-suppressed contact", () => {
    const result = evaluateThrottleGate(makeInput());
    expect(result.outcome).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Critical bypass
// ---------------------------------------------------------------------------

describe("Critical bypass (skips L2 + L3, NOT L1)", () => {
  it("critical flow bypasses frequency cap", () => {
    const result = evaluateThrottleGate(
      makeInput({
        flowClass: "critical",
        recentSends: { countLast24h: 5, countLast7d: 10, lastSentAt: new Date("2026-07-20T09:00:00Z") },
      }),
    );
    expect(result.outcome).toBe("allow");
  });

  it("critical flow bypasses send window", () => {
    // Saturday at 23:00 - outside default window (weekdays only)
    const now = new Date("2026-07-25T23:00:00Z"); // Saturday
    const result = evaluateThrottleGate(
      makeInput({
        flowClass: "critical",
        now,
      }),
    );
    expect(result.outcome).toBe("allow");
  });

  it("critical with critical_bypass_throttle=false does NOT bypass", () => {
    const config = { ...THROTTLE_DEFAULTS, critical_bypass_throttle: false, send_window_timezone: "tenant_fixed" as const, tenant_timezone: "UTC" };
    const result = evaluateThrottleGate(
      makeInput({
        flowClass: "critical",
        config,
        recentSends: { countLast24h: 5, countLast7d: 10, lastSentAt: new Date("2026-07-20T09:00:00Z") },
      }),
    );
    expect(result.outcome).toBe("defer_frequency");
  });
});

// ---------------------------------------------------------------------------
// L2: Frequency cap
// ---------------------------------------------------------------------------

describe("L2: Frequency cap", () => {
  it("defers when min_interval not elapsed", () => {
    const lastSentAt = new Date("2026-07-20T08:00:00Z"); // 2h ago
    const now = new Date("2026-07-20T10:00:00Z");
    const result = evaluateThrottleGate(
      makeInput({
        now,
        recentSends: { countLast24h: 0, countLast7d: 0, lastSentAt },
      }),
    );
    expect(result.outcome).toBe("defer_frequency");
    const verdict = result as { outcome: "defer_frequency"; retryAfter: Date };
    // min_interval is 48h, last sent 2h ago, so retryAfter should be lastSentAt + 48h
    const expected = new Date(lastSentAt.getTime() + 48 * 60 * 60 * 1000);
    expect(verdict.retryAfter.getTime()).toBe(expected.getTime());
  });

  it("allows when min_interval has elapsed", () => {
    const lastSentAt = new Date("2026-07-18T08:00:00Z"); // 50h ago
    const now = new Date("2026-07-20T10:00:00Z");
    const result = evaluateThrottleGate(
      makeInput({
        now,
        recentSends: { countLast24h: 0, countLast7d: 0, lastSentAt },
      }),
    );
    expect(result.outcome).toBe("allow");
  });

  it("defers when daily cap reached", () => {
    const now = new Date("2026-07-20T10:00:00Z");
    const result = evaluateThrottleGate(
      makeInput({
        now,
        config: { ...THROTTLE_DEFAULTS, max_emails_per_user_per_day: 1, send_window_timezone: "tenant_fixed" as const, tenant_timezone: "UTC" },
        recentSends: { countLast24h: 1, countLast7d: 1, lastSentAt: new Date("2026-07-18T00:00:00Z") },
      }),
    );
    expect(result.outcome).toBe("defer_frequency");
    const verdict = result as { outcome: "defer_frequency"; retryAfter: Date };
    // retryAfter should be 24h from now
    const expected = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    expect(verdict.retryAfter.getTime()).toBe(expected.getTime());
  });

  it("defers when weekly cap reached", () => {
    const now = new Date("2026-07-20T10:00:00Z");
    const result = evaluateThrottleGate(
      makeInput({
        now,
        config: { ...THROTTLE_DEFAULTS, max_emails_per_user_per_week: 2, send_window_timezone: "tenant_fixed" as const, tenant_timezone: "UTC" },
        recentSends: { countLast24h: 0, countLast7d: 2, lastSentAt: new Date("2026-07-13T00:00:00Z") },
      }),
    );
    expect(result.outcome).toBe("defer_frequency");
    const verdict = result as { outcome: "defer_frequency"; retryAfter: Date };
    // retryAfter should be 7 days from now
    const expected = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(verdict.retryAfter.getTime()).toBe(expected.getTime());
  });

  it("min_interval takes priority over daily cap (first check wins)", () => {
    // Both conditions true, but min_interval is checked first
    const now = new Date("2026-07-20T10:00:00Z");
    const lastSentAt = new Date("2026-07-20T09:00:00Z"); // 1h ago
    const result = evaluateThrottleGate(
      makeInput({
        now,
        recentSends: { countLast24h: 1, countLast7d: 1, lastSentAt },
      }),
    );
    expect(result.outcome).toBe("defer_frequency");
    const verdict = result as { outcome: "defer_frequency"; retryAfter: Date };
    // Should be based on min_interval (lastSentAt + 48h), not daily cap (now + 24h)
    const expected = new Date(lastSentAt.getTime() + 48 * 60 * 60 * 1000);
    expect(verdict.retryAfter.getTime()).toBe(expected.getTime());
  });

  it("allows when all caps are within limits", () => {
    const now = new Date("2026-07-20T10:00:00Z");
    const lastSentAt = new Date("2026-07-17T10:00:00Z"); // 3 days ago (> 48h)
    const result = evaluateThrottleGate(
      makeInput({
        now,
        recentSends: { countLast24h: 0, countLast7d: 1, lastSentAt },
      }),
    );
    expect(result.outcome).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// L3: Send window
// ---------------------------------------------------------------------------

describe("L3: Send window", () => {
  it("allows when within window on a weekday", () => {
    // Monday 10:00 UTC, window 09:00-17:00 UTC weekdays
    const now = new Date("2026-07-20T10:00:00Z");
    const result = evaluateThrottleGate(makeInput({ now }));
    expect(result.outcome).toBe("allow");
  });

  it("defers when outside window hours (too early)", () => {
    // Monday 07:00 UTC
    const now = new Date("2026-07-20T07:00:00Z");
    const result = evaluateThrottleGate(makeInput({ now }));
    expect(result.outcome).toBe("defer_window");
    const verdict = result as { outcome: "defer_window"; retryAfter: Date };
    // Should defer to 09:00 same day - 2 hours later
    const expected = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    expect(verdict.retryAfter.getTime()).toBe(expected.getTime());
  });

  it("defers when outside window hours (too late)", () => {
    // Monday 18:00 UTC - after 17:00 end
    const now = new Date("2026-07-20T18:00:00Z");
    const result = evaluateThrottleGate(makeInput({ now }));
    expect(result.outcome).toBe("defer_window");
    const verdict = result as { outcome: "defer_window"; retryAfter: Date };
    // Next window: Tuesday 09:00 = 15 hours later
    const expected = new Date(now.getTime() + 15 * 60 * 60 * 1000);
    expect(verdict.retryAfter.getTime()).toBe(expected.getTime());
  });

  it("defers when on a weekend day", () => {
    // Saturday 10:00 UTC
    const now = new Date("2026-07-25T10:00:00Z");
    const result = evaluateThrottleGate(makeInput({ now }));
    expect(result.outcome).toBe("defer_window");
    const verdict = result as { outcome: "defer_window"; retryAfter: Date };
    // Next window: Monday 09:00 = Saturday 10:00 -> Sunday midnight (14h) + Monday 09:00 (9h) = ... 
    // Actually: Saturday 10:00 -> next Mon is 2 days away
    // From Sat 10:00: minutes until midnight = 14*60 = 840
    // + 1 full day (Sunday) = 24*60 = 1440
    // + window start on Monday = 9*60 = 540
    // Total = 840 + 1440 + 540 = 2820 minutes = 47 hours
    const expected = new Date(now.getTime() + 2820 * 60 * 1000);
    expect(verdict.retryAfter.getTime()).toBe(expected.getTime());
  });

  it("immediate window_policy skips window check entirely", () => {
    // Saturday 23:00 - outside window, but window_policy = immediate
    const now = new Date("2026-07-25T23:00:00Z");
    const result = evaluateThrottleGate(
      makeInput({ now, windowPolicy: "immediate" }),
    );
    expect(result.outcome).toBe("allow");
  });

  it("respects contact timezone for send window", () => {
    // UTC is Monday 06:00, but in America/New_York it's Monday 02:00 (too early)
    // Window is 09:00-17:00 in contact's local time
    const now = new Date("2026-07-20T06:00:00Z");
    const result = evaluateThrottleGate(
      makeInput({
        now,
        config: { ...THROTTLE_DEFAULTS, send_window_timezone: "contact_local" },
        contactTimezone: "America/New_York",
      }),
    );
    expect(result.outcome).toBe("defer_window");
    const verdict = result as { outcome: "defer_window"; retryAfter: Date };
    // NYC is UTC-4 in July (EDT). Local time is 02:00.
    // Window opens at 09:00 local = 13:00 UTC.
    // Difference: 7 hours from now (06:00 UTC -> 13:00 UTC)
    const expected = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    expect(verdict.retryAfter.getTime()).toBe(expected.getTime());
  });
});

// ---------------------------------------------------------------------------
// Timezone fallback chain
// ---------------------------------------------------------------------------

describe("Timezone fallback chain", () => {
  it("uses contact timezone when valid", () => {
    const tz = resolveTimezone("America/New_York", "Europe/London");
    expect(tz).toBe("America/New_York");
  });

  it("falls back to tenant timezone when contact timezone is null", () => {
    const tz = resolveTimezone(null, "Europe/London");
    expect(tz).toBe("Europe/London");
  });

  it("falls back to tenant timezone when contact timezone is invalid", () => {
    const tz = resolveTimezone("Not/A/Real/Zone", "Europe/London");
    expect(tz).toBe("Europe/London");
  });

  it("falls back to UTC when both are null", () => {
    const tz = resolveTimezone(null, null);
    expect(tz).toBe("UTC");
  });

  it("falls back to UTC when contact is garbage and tenant is null", () => {
    const tz = resolveTimezone("garbage_tz_value", null);
    expect(tz).toBe("UTC");
  });

  it("falls back to UTC when contact is garbage and tenant is also garbage", () => {
    const tz = resolveTimezone("foo/bar/baz", "also_not_valid");
    expect(tz).toBe("UTC");
  });

  it("accepts valid but uncommon IANA zones", () => {
    expect(isValidTimezone("Pacific/Chatham")).toBe(true);
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
  });

  it("rejects empty string", () => {
    const tz = resolveTimezone("", "UTC");
    // Empty string is falsy, so falls through to tenant
    expect(tz).toBe("UTC");
  });
});

// ---------------------------------------------------------------------------
// resolveThrottleConfig
// ---------------------------------------------------------------------------

describe("resolveThrottleConfig", () => {
  it("returns defaults when input is null", () => {
    const config = resolveThrottleConfig(null);
    expect(config).toEqual(THROTTLE_DEFAULTS);
  });

  it("returns defaults when input is undefined", () => {
    const config = resolveThrottleConfig(undefined);
    expect(config).toEqual(THROTTLE_DEFAULTS);
  });

  it("returns defaults when input is a non-object", () => {
    const config = resolveThrottleConfig("garbage");
    expect(config).toEqual(THROTTLE_DEFAULTS);
  });

  it("returns defaults when input is an empty object", () => {
    const config = resolveThrottleConfig({});
    expect(config).toEqual(THROTTLE_DEFAULTS);
  });

  it("merges valid partial overrides", () => {
    const config = resolveThrottleConfig({
      max_emails_per_user_per_day: 3,
      send_window_start: "08:00",
    });
    expect(config.max_emails_per_user_per_day).toBe(3);
    expect(config.send_window_start).toBe("08:00");
    // Other fields remain default
    expect(config.max_emails_per_user_per_week).toBe(2);
    expect(config.send_window_end).toBe("17:00");
  });

  it("ignores invalid field values and uses defaults", () => {
    const config = resolveThrottleConfig({
      max_emails_per_user_per_day: -1, // invalid: below min
      send_window_start: "invalid", // invalid format
      send_window_days: ["mon", "invalid_day", "fri"],
      critical_bypass_throttle: "yes", // wrong type
    });
    expect(config.max_emails_per_user_per_day).toBe(1); // default
    expect(config.send_window_start).toBe("09:00"); // default
    expect(config.send_window_days).toEqual(["mon", "fri"]); // filtered valid only
    expect(config.critical_bypass_throttle).toBe(true); // default
  });

  it("accepts zero as a valid cap value", () => {
    const config = resolveThrottleConfig({
      max_emails_per_user_per_day: 0,
      max_emails_per_user_per_week: 0,
      min_interval_between_emails_hours: 0,
    });
    expect(config.max_emails_per_user_per_day).toBe(0);
    expect(config.max_emails_per_user_per_week).toBe(0);
    expect(config.min_interval_between_emails_hours).toBe(0);
  });

  it("absent config means full default throttling, not unlimited", () => {
    const config = resolveThrottleConfig(null);
    // Should have strict limits, not zeros or Infinity
    expect(config.max_emails_per_user_per_day).toBe(1);
    expect(config.max_emails_per_user_per_week).toBe(2);
    expect(config.min_interval_between_emails_hours).toBe(48);
    expect(config.critical_bypass_throttle).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: full gate with default config and no prior sends
// ---------------------------------------------------------------------------

describe("Full gate integration", () => {
  it("tenant with no throttle config gets default throttling", () => {
    const config = resolveThrottleConfig(null);
    // Send on Monday 10:00 UTC with no prior sends - should allow
    const now = new Date("2026-07-20T10:00:00Z"); // Monday
    const result = evaluateThrottleGate({
      isSuppressed: false,
      flowClass: "nurture",
      windowPolicy: "respect_window",
      config: { ...config, send_window_timezone: "tenant_fixed", tenant_timezone: "UTC" },
      recentSends: { countLast24h: 0, countLast7d: 0, lastSentAt: null },
      contactTimezone: null,
      now,
    });
    expect(result.outcome).toBe("allow");
  });

  it("tenant with no config but recent send gets deferred by default min_interval", () => {
    const config = resolveThrottleConfig(null);
    const now = new Date("2026-07-20T10:00:00Z"); // Monday
    const lastSentAt = new Date("2026-07-20T08:00:00Z"); // 2h ago
    const result = evaluateThrottleGate({
      isSuppressed: false,
      flowClass: "nurture",
      windowPolicy: "respect_window",
      config: { ...config, send_window_timezone: "tenant_fixed", tenant_timezone: "UTC" },
      recentSends: { countLast24h: 0, countLast7d: 0, lastSentAt },
      contactTimezone: null,
      now,
    });
    expect(result.outcome).toBe("defer_frequency");
    const verdict = result as { outcome: "defer_frequency"; retryAfter: Date };
    // Default min_interval = 48h
    const expected = new Date(lastSentAt.getTime() + 48 * 60 * 60 * 1000);
    expect(verdict.retryAfter.getTime()).toBe(expected.getTime());
  });

  it("layer evaluation order: L1 before L2 before L3", () => {
    // A message that fails all three layers should get the L1 verdict
    const now = new Date("2026-07-25T23:00:00Z"); // Saturday night
    const result = evaluateThrottleGate({
      isSuppressed: true,
      flowClass: "nurture",
      windowPolicy: "respect_window",
      config: { ...THROTTLE_DEFAULTS, send_window_timezone: "tenant_fixed" as const, tenant_timezone: "UTC" },
      recentSends: { countLast24h: 5, countLast7d: 10, lastSentAt: new Date("2026-07-25T22:00:00Z") },
      contactTimezone: null,
      now,
    });
    expect(result.outcome).toBe("suppress");
  });
});
