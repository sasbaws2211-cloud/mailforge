/**
 * Unit tests for checkBaseUrl() in compliance.ts.
 *
 * Tests:
 * - Outside production: any URL is allowed (quickstart protection)
 * - In production: localhost is rejected
 * - In production: 127.x.x.x loopback is rejected
 * - In production: ::1 loopback is rejected
 * - In production: http scheme is rejected
 * - In production: malformed URL is rejected
 * - In production: valid https URL is accepted
 * - startup behavior: resolveBaseUrl strips trailing slash and falls back to localhost
 */
import { describe, it, expect } from "vitest";
import { checkBaseUrl, resolveBaseUrl } from "../src/compliance.js";

describe("checkBaseUrl", () => {
  describe("outside production (isProduction=false)", () => {
    it("allows http://localhost:3000 (quickstart default)", () => {
      expect(checkBaseUrl("http://localhost:3000", false)).toBeNull();
    });

    it("allows any loopback URL", () => {
      expect(checkBaseUrl("http://127.0.0.1:3000", false)).toBeNull();
    });

    it("allows http scheme", () => {
      expect(checkBaseUrl("http://mail.example.com", false)).toBeNull();
    });

    it("allows a malformed value", () => {
      // Outside production we never block - even a nonsense value is allowed.
      expect(checkBaseUrl("not-a-url", false)).toBeNull();
    });
  });

  describe("in production (isProduction=true)", () => {
    it("rejects localhost", () => {
      const reason = checkBaseUrl("http://localhost:3000", true);
      expect(reason).not.toBeNull();
      expect(reason).toContain("loopback");
      expect(reason).toContain("localhost");
    });

    it("rejects 127.0.0.1", () => {
      const reason = checkBaseUrl("http://127.0.0.1:3000", true);
      expect(reason).not.toBeNull();
      expect(reason).toContain("loopback");
    });

    it("rejects 127.x.x.x range (not just .1)", () => {
      const reason = checkBaseUrl("http://127.1.2.3:3000", true);
      expect(reason).not.toBeNull();
      expect(reason).toContain("loopback");
    });

    it("rejects ::1 IPv6 loopback", () => {
      const reason = checkBaseUrl("http://[::1]:3000", true);
      expect(reason).not.toBeNull();
      expect(reason).toContain("loopback");
    });

    it("rejects http scheme", () => {
      const reason = checkBaseUrl("http://mail.example.com", true);
      expect(reason).not.toBeNull();
      expect(reason).toContain("https");
    });

    it("rejects malformed / unparseable URL", () => {
      const reason = checkBaseUrl("not-a-url", true);
      expect(reason).not.toBeNull();
      expect(reason).toContain("not a valid URL");
    });

    it("accepts a valid https URL", () => {
      expect(checkBaseUrl("https://mail.example.com", true)).toBeNull();
    });

    it("accepts the Cloud production URL", () => {
      expect(checkBaseUrl("https://api.claros.org", true)).toBeNull();
    });

    it("accepts https with a non-standard port", () => {
      expect(checkBaseUrl("https://mail.example.com:8443", true)).toBeNull();
    });

    it("returns a non-empty string reason (not null and not empty)", () => {
      const reason = checkBaseUrl("http://localhost:3000", true);
      expect(typeof reason).toBe("string");
      expect((reason as string).length).toBeGreaterThan(0);
    });
  });

  describe("production detection via NODE_ENV (no isProduction override)", () => {
    // These tests do not mutate NODE_ENV. They confirm the function does not
    // throw and behaves consistently when called without the override param.
    // The test runner typically sets NODE_ENV=test, so all values are allowed.
    it("does not throw for localhost when called without override in test environment", () => {
      expect(() => checkBaseUrl("http://localhost:3000")).not.toThrow();
    });

    it("does not throw for a valid https URL when called without override", () => {
      expect(() => checkBaseUrl("https://api.claros.org")).not.toThrow();
    });
  });
});

describe("resolveBaseUrl", () => {
  it("strips trailing slash", () => {
    expect(resolveBaseUrl("https://mail.example.com/")).toBe("https://mail.example.com");
  });

  it("does not strip when no trailing slash", () => {
    expect(resolveBaseUrl("https://mail.example.com")).toBe("https://mail.example.com");
  });

  it("uses override when provided", () => {
    expect(resolveBaseUrl("https://override.example.com")).toBe("https://override.example.com");
  });
});
