/**
 * Tests for the platform mailer configuration. Pure: builds adapters from an
 * env object and never sends anything.
 */
import { describe, it, expect } from "vitest";
import { ResendTransportAdapter, SmtpTransportAdapter } from "@mailforge/adapters";
import { getPlatformTransport } from "../src/platform-mailer.js";

describe("getPlatformTransport", () => {
  it("is null when nothing is configured (self-hosted default)", () => {
    expect(getPlatformTransport({})).toBeNull();
  });

  it("is null without a from-address, even if a provider is set", () => {
    expect(getPlatformTransport({ PLATFORM_SMTP_HOST: "smtp.example.com" })).toBeNull();
    expect(getPlatformTransport({ PLATFORM_RESEND_API_KEY: "re_x", PLATFORM_FROM_EMAIL: "  " })).toBeNull();
  });

  it("is null with a from-address but no provider", () => {
    expect(getPlatformTransport({ PLATFORM_FROM_EMAIL: "no-reply@x.com" })).toBeNull();
  });

  it("builds a Resend sender from an API key", () => {
    const t = getPlatformTransport({ PLATFORM_FROM_EMAIL: "no-reply@x.com", PLATFORM_FROM_NAME: "Acme", PLATFORM_RESEND_API_KEY: "re_abc" });
    expect(t?.adapter).toBeInstanceOf(ResendTransportAdapter);
    expect(t?.fromEmail).toBe("no-reply@x.com");
    expect(t?.fromName).toBe("Acme");
  });

  it("builds an SMTP sender from a host, with a null name when none is given", () => {
    const t = getPlatformTransport({ PLATFORM_FROM_EMAIL: "no-reply@x.com", PLATFORM_SMTP_HOST: "smtp.example.com", PLATFORM_SMTP_PORT: "465" });
    expect(t?.adapter).toBeInstanceOf(SmtpTransportAdapter);
    expect(t?.fromName).toBeNull();
  });

  it("prefers Resend when both are configured", () => {
    const t = getPlatformTransport({
      PLATFORM_FROM_EMAIL: "no-reply@x.com",
      PLATFORM_RESEND_API_KEY: "re_abc",
      PLATFORM_SMTP_HOST: "smtp.example.com",
    });
    expect(t?.adapter).toBeInstanceOf(ResendTransportAdapter);
  });

  it("rejects an invalid SMTP port rather than guessing", () => {
    for (const port of ["0", "70000", "abc", "-1"]) {
      expect(getPlatformTransport({ PLATFORM_FROM_EMAIL: "a@x.com", PLATFORM_SMTP_HOST: "h", PLATFORM_SMTP_PORT: port })).toBeNull();
    }
  });

  it("defaults the SMTP port to 587 when unset", () => {
    expect(getPlatformTransport({ PLATFORM_FROM_EMAIL: "a@x.com", PLATFORM_SMTP_HOST: "h" })).not.toBeNull();
  });
});
