import { describe, it, expect } from "vitest";
import {
  DEFAULT_SHARED_DAILY_LIMIT,
  RESEND_API_BASE,
  SENDER_HEALTH_MIN_SENT,
  chooseManagedSender,
  isValidReplyAddress,
  managedSendingConfigFromEnv,
  sanitizeDisplayName,
  senderHealth,
  validateFromLocalPart,
  validateSendingDomain,
} from "../src/index.js";

describe("managedSendingConfigFromEnv", () => {
  it("is off without the operator's Resend key", () => {
    expect(managedSendingConfigFromEnv({}).enabled).toBe(false);
    expect(managedSendingConfigFromEnv({ MAILFORGE_MANAGED_RESEND_API_KEY: "  " }).enabled).toBe(false);
  });

  it("is on with a key, and can be switched off without removing it", () => {
    expect(managedSendingConfigFromEnv({ MAILFORGE_MANAGED_RESEND_API_KEY: "re_x" })).toMatchObject({ enabled: true, apiKey: "re_x" });
    expect(managedSendingConfigFromEnv({ MAILFORGE_MANAGED_RESEND_API_KEY: "re_x", MAILFORGE_MANAGED_SENDING: "false" }).enabled).toBe(false);
  });

  it("never uses the platform's account-email key for customer mail", () => {
    expect(managedSendingConfigFromEnv({ PLATFORM_RESEND_API_KEY: "re_account_mail" }).enabled).toBe(false);
  });

  it("reads the shared sender (lower-cased, must look like an address), the daily cap and the base URL", () => {
    const c = managedSendingConfigFromEnv({
      MAILFORGE_MANAGED_RESEND_API_KEY: "re_x",
      MAILFORGE_MANAGED_SHARED_FROM: " Notifications@Mail.Platform.Test ",
      MAILFORGE_MANAGED_SHARED_DAILY_LIMIT: "250",
      MAILFORGE_MANAGED_RESEND_BASE_URL: "http://127.0.0.1:4030/",
    });
    expect(c).toMatchObject({ sharedFrom: "notifications@mail.platform.test", sharedDailyLimit: 250, baseUrl: "http://127.0.0.1:4030" });
    const d = managedSendingConfigFromEnv({ MAILFORGE_MANAGED_RESEND_API_KEY: "re_x", MAILFORGE_MANAGED_SHARED_FROM: "not an address", MAILFORGE_MANAGED_SHARED_DAILY_LIMIT: "-4" });
    expect(d).toMatchObject({ sharedFrom: null, sharedDailyLimit: DEFAULT_SHARED_DAILY_LIMIT, baseUrl: RESEND_API_BASE });
  });
});

describe("validateSendingDomain", () => {
  const ok = (v: unknown, platform: string[] = []) => {
    const r = validateSendingDomain(v, platform);
    return r.ok ? r.domain : `ERR:${r.error}`;
  };

  it("cleans up what people paste", () => {
    expect(ok("Mail.Acme-Test.dev")).toBe("mail.acme-test.dev");
    expect(ok("https://mail.acme-test.dev/some/page?x=1")).toBe("mail.acme-test.dev");
    expect(ok("hello@mail.acme-test.dev")).toBe("mail.acme-test.dev");
    expect(ok("  mail.acme-test.dev.  ")).toBe("mail.acme-test.dev");
    expect(ok("mail.acme-test.dev:443")).toBe("mail.acme-test.dev");
  });

  it("accepts ordinary domains, subdomains and punycode", () => {
    for (const d of ["acme-test.dev", "a.b.c.acme-test.co.uk", "xn--bcher-kva.example-site.de", "send.acme-test.io"]) expect(ok(d)).toBe(d);
  });

  it("refuses things that are not a domain", () => {
    for (const bad of ["", "   ", "localhost", "acme", "1.2.3.4", "-acme-test.dev", "acme-test-.dev", "ac me.dev", "acme_test.dev", "acme..dev", ".acme.dev", "acme.d", "acme.123", "bücher.example-site.de", "a".repeat(64) + ".dev", null, undefined, 42]) {
      expect(String(ok(bad as unknown)), String(bad)).toMatch(/^ERR:/);
    }
    expect(String(ok(("a".repeat(60) + ".").repeat(5) + "dev"))).toMatch(/^ERR:/);
  });

  it("refuses free email providers and their subdomains: nobody can verify them and sending as them is impersonation", () => {
    for (const d of ["gmail.com", "GMAIL.COM", "outlook.com", "yahoo.com", "mail.gmail.com", "x.protonmail.com", "example.com"]) {
      expect(String(ok(d)), d).toMatch(/free email service|own/i);
    }
  });

  it("refuses the operator's own domains and anything under them", () => {
    expect(String(ok("platform.test", ["platform.test"]))).toMatch(/belongs to this service/);
    expect(String(ok("mail.platform.test", ["platform.test"]))).toMatch(/belongs to this service/);
    expect(ok("notplatform.test", ["platform.test"])).toBe("notplatform.test"); // a different domain that merely ends the same way
    expect(ok("acme-test.dev", ["", "  "])).toBe("acme-test.dev");
  });
});

describe("validateFromLocalPart", () => {
  it("accepts ordinary names, lower-cased", () => {
    for (const [i, o] of [["hello", "hello"], ["Team", "team"], ["no-reply", "no-reply"], ["a.b", "a.b"], ["news+x", "news+x"], ["x", "x"]] as const) {
      expect(validateFromLocalPart(i)).toEqual({ ok: true, local: o });
    }
  });
  it("refuses anything that could change the address or inject a header", () => {
    for (const bad of ["", " ", "a@b", "a b", "a..b", ".a", "a.", "a\r\nBcc: x@y.z", "<x>", "a,b", "é", "x".repeat(65), null, 5]) {
      expect(validateFromLocalPart(bad as unknown).ok, String(bad)).toBe(false);
    }
  });
});

describe("sanitizeDisplayName", () => {
  it("removes line breaks (header injection), quotes and angle brackets, collapses spaces, limits length", () => {
    expect(sanitizeDisplayName("Acme \r\nBcc: evil@x.y")).toBe("Acme Bcc: evil@x.y");
    expect(sanitizeDisplayName('Acme "Inc" <ceo@acme.test>')).toBe("Acme Inc ceo@acme.test");
    expect(sanitizeDisplayName("  Acme   Corp  ")).toBe("Acme Corp");
    expect(sanitizeDisplayName("x".repeat(200))!.length).toBe(64);
    for (const bad of ["", "   ", '""', "<>", null, undefined, 5]) expect(sanitizeDisplayName(bad as unknown), String(bad)).toBeNull();
  });
  it("never leaves a line break or header-breaking character in the result", () => {
    for (const nasty of ["a\nb", "a\rb", "a\r\nb", "a\u0000b", "a\tb", "a\\b"]) expect(sanitizeDisplayName(nasty)).not.toMatch(/[\r\n\0\t\\]/);
  });
});

describe("isValidReplyAddress", () => {
  it("accepts a single plain address and nothing else", () => {
    expect(isValidReplyAddress("support@acme-test.dev")).toBe(true);
    for (const bad of ["", "a@b", "a b@c.d", "Name <a@b.co>", "a@b.co, c@d.co", "a@b.co\r\nBcc: x@y.z", '"a"@b.co', null, 4]) expect(isValidReplyAddress(bad as unknown), String(bad)).toBe(false);
  });
});

describe("chooseManagedSender", () => {
  const base = { domain: null, domainStatus: "none" as const, fromLocal: "hello", fromName: null, fallbackName: "Acme", replyTo: "owner@acme-test.dev", sharedFrom: "notifications@mail.platform.test" };

  it("uses the workspace's own domain once it is verified", () => {
    expect(chooseManagedSender({ ...base, domain: "mail.acme-test.dev", domainStatus: "verified", fromName: "Acme Team" })).toEqual({
      ok: true,
      mode: "domain",
      fromEmail: "hello@mail.acme-test.dev",
      fromName: "Acme Team",
      replyTo: "owner@acme-test.dev",
    });
  });

  it("uses the shared address, with the workspace's name and reply address, until a domain is verified", () => {
    for (const status of ["none", "not_started", "pending", "failed", "temporary_failure"] as const) {
      expect(chooseManagedSender({ ...base, domain: status === "none" ? null : "mail.acme-test.dev", domainStatus: status })).toMatchObject({
        ok: true,
        mode: "shared",
        fromEmail: "notifications@mail.platform.test",
        fromName: "Acme",
        replyTo: "owner@acme-test.dev",
      });
    }
  });

  it("falls back to the shared address if a domain that was verified stops being so", () => {
    expect(chooseManagedSender({ ...base, domain: "mail.acme-test.dev", domainStatus: "failed" })).toMatchObject({ mode: "shared" });
  });

  it("cannot send when there is neither a verified domain nor a shared address", () => {
    expect(chooseManagedSender({ ...base, sharedFrom: null })).toEqual({ ok: false, reason: "needs_domain" });
    expect(chooseManagedSender({ ...base, sharedFrom: null, domain: "mail.acme-test.dev", domainStatus: "pending" })).toEqual({ ok: false, reason: "needs_domain" });
  });

  it("the sender name is cleaned, and never empty", () => {
    expect(chooseManagedSender({ ...base, fromName: "A\r\nBcc: x", fallbackName: "Acme" })).toMatchObject({ fromName: "A Bcc: x" });
    expect(chooseManagedSender({ ...base, fromName: "<>", fallbackName: "" })).toMatchObject({ fromName: "Notifications" });
  });
});

describe("senderHealth", () => {
  it("never judges a workspace with too little volume, however bad it looks", () => {
    expect(senderHealth(SENDER_HEALTH_MIN_SENT - 1, 99, 99)).toMatchObject({ state: "ok", reasons: [] });
    expect(senderHealth(0, 0, 0).state).toBe("ok");
  });

  it("pauses on complaints at 0.3 percent and at least two of them", () => {
    expect(senderHealth(1000, 0, 3).state).toBe("pause"); // 0.3%
    expect(senderHealth(1000, 0, 2).state).toBe("warn"); // 0.2%: warn, not pause
    expect(senderHealth(300, 0, 1).state).toBe("warn"); // 0.33% but a single complaint: warn only
    expect(senderHealth(1000, 0, 1).state).toBe("ok");
  });

  it("pauses on permanent bounces at 5 percent and at least five of them", () => {
    expect(senderHealth(200, 10, 0).state).toBe("pause");
    expect(senderHealth(200, 4, 0).state).toBe("ok"); // 2%
    expect(senderHealth(100, 5, 0).state).toBe("pause");
    expect(senderHealth(200, 5, 0).state).toBe("warn"); // 2.5% = half the pause rate
    expect(senderHealth(2000, 40, 0).state).toBe("ok"); // 2%: below half of 5%
  });

  it("names every reason in plain words with the figures", () => {
    const h = senderHealth(1000, 100, 5);
    expect(h.state).toBe("pause");
    expect(h.reasons).toHaveLength(2);
    expect(h.reasons[0]).toMatch(/5 spam complaints out of 1000 emails \(0\.50%\)/);
    expect(h.reasons[1]).toMatch(/100 addresses that do not exist out of 1000 emails \(10\.0%\)/);
  });

  it("is quiet and exact at the boundaries", () => {
    expect(senderHealth(100, 0, 0)).toMatchObject({ state: "ok", bounceRate: 0, complaintRate: 0 });
    expect(senderHealth(1000, 50, 0).state).toBe("pause"); // exactly 5%
    expect(senderHealth(1000, 49, 0).state).toBe("warn"); // just under
  });
});
