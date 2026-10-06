/**
 * Tests for the SMTP destination guard: which addresses a customer-supplied
 * mail server may resolve to, and that the adapter really refuses (and never
 * connects) when it should. Nodemailer is mocked, so no connection is ever made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendMail = vi.fn();
const mockVerify = vi.fn();
const mockClose = vi.fn();
const mockCreateTransport = vi.fn((_opts: unknown) => ({ sendMail: mockSendMail, verify: mockVerify, close: mockClose }));

vi.mock("nodemailer", () => ({
  createTransport: (opts: unknown) => mockCreateTransport(opts),
}));

import { SmtpTransportAdapter } from "../src/smtp.js";
import {
  DEFAULT_ALLOWED_SMTP_PORTS,
  SMTP_HOST_NOT_ALLOWED,
  isBlockedIp,
  normalizeHost,
  resolveSmtpTarget,
  smtpHostPolicyFromEnv,
  type LookupFn,
  type SmtpHostPolicy,
} from "../src/smtp-guard.js";

const lookupOf = (...addrs: string[]): LookupFn => async () => addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
const policy = (over: Partial<SmtpHostPolicy> = {}): SmtpHostPolicy => ({
  restrict: true,
  allowedHosts: [],
  allowedPorts: DEFAULT_ALLOWED_SMTP_PORTS,
  lookup: lookupOf("93.184.216.34"),
  ...over,
});

const params = { to: "a@example.com", from: "b@example.com", subject: "s", bodyHtml: "<p>x</p>", bodyText: "x", messageId: "m1" };

beforeEach(() => {
  mockSendMail.mockReset().mockResolvedValue({ messageId: "<id@x>" });
  mockVerify.mockReset().mockResolvedValue(true);
  mockClose.mockReset();
  mockCreateTransport.mockClear();
});

describe("isBlockedIp", () => {
  it("blocks every private, loopback, link-local and reserved IPv4 range", () => {
    for (const ip of [
      "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
      "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.5", "192.168.0.1", "192.168.255.255",
      "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public IPv4 addresses, including those next to a blocked range", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.1.1", "11.0.0.1", "192.169.0.1", "198.17.255.255", "198.20.0.1"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks IPv6 loopback, unspecified, unique-local, link-local, multicast, documentation and Teredo", () => {
    for (const ip of ["::", "::1", "0:0:0:0:0:0:0:1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "2001:db8::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "100::1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("looks inside IPv6 forms that hide an IPv4 address (mapped, compatible, NAT64, 6to4)", () => {
    for (const ip of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.1.2.3", "::ffff:169.254.169.254", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2002:a9fe:a9fe::1", "[::1]"]) {
      expect(isBlockedIp(ip.replace(/^\[|\]$/g, "")), ip).toBe(true);
    }
    for (const ip of ["::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("allows ordinary public IPv6", () => {
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e"]) expect(isBlockedIp(ip), ip).toBe(false);
  });

  it("treats anything that is not an IP address as blocked (it never reaches here with a name)", () => {
    for (const ip of ["", "abc", "999.1.1.1", "1.2.3", "1.2.3.4.5", "::g", "1::2::3"]) expect(isBlockedIp(ip), ip).toBe(true);
  });
});

describe("smtpHostPolicyFromEnv", () => {
  it("is off for a self-hosted install and on for a hosted one", () => {
    expect(smtpHostPolicyFromEnv({}).restrict).toBe(false);
    expect(smtpHostPolicyFromEnv({ MAILFORGE_PUBLIC_SITE: "true" }).restrict).toBe(true);
    expect(smtpHostPolicyFromEnv({ MAILFORGE_ENFORCE_PLANS: "true" }).restrict).toBe(true);
    expect(smtpHostPolicyFromEnv({ MAILFORGE_PUBLIC_SITE: "false", MAILFORGE_ENFORCE_PLANS: "false" }).restrict).toBe(false);
  });

  it("an explicit setting wins either way", () => {
    expect(smtpHostPolicyFromEnv({ MAILFORGE_PUBLIC_SITE: "true", MAILFORGE_RESTRICT_SMTP_HOSTS: "false" }).restrict).toBe(false);
    expect(smtpHostPolicyFromEnv({ MAILFORGE_RESTRICT_SMTP_HOSTS: "true" }).restrict).toBe(true);
    expect(smtpHostPolicyFromEnv({ MAILFORGE_PUBLIC_SITE: "true", MAILFORGE_RESTRICT_SMTP_HOSTS: "garbage" }).restrict).toBe(true);
  });

  it("reads the exempt hosts and ports, normalised, ignoring junk", () => {
    const p = smtpHostPolicyFromEnv({ MAILFORGE_SMTP_ALLOWED_HOSTS: " Mailpit , relay.INTERNAL.example. ,, [::1]", MAILFORGE_SMTP_ALLOWED_PORTS: "1025, 587, x, 70000" });
    expect(p.allowedHosts).toEqual(["mailpit", "relay.internal.example", "::1"]);
    expect(p.allowedPorts).toEqual([1025, 587]);
    expect(smtpHostPolicyFromEnv({}).allowedPorts).toEqual([...DEFAULT_ALLOWED_SMTP_PORTS]);
  });
});

describe("normalizeHost", () => {
  it("lower-cases, drops IPv6 brackets and a trailing dot", () => {
    expect(normalizeHost(" SMTP.Example.COM. ")).toBe("smtp.example.com");
    expect(normalizeHost("[2001:db8::1]")).toBe("2001:db8::1");
  });
});

describe("resolveSmtpTarget", () => {
  it("does nothing when the guard is off: the host is used as typed, even a private one", async () => {
    expect(await resolveSmtpTarget("127.0.0.1", 5432, policy({ restrict: false }))).toEqual({ ok: true, address: "127.0.0.1", servername: "127.0.0.1" });
  });

  it("lets a public host through and returns the address that was checked", async () => {
    expect(await resolveSmtpTarget("smtp.example.com", 587, policy())).toEqual({ ok: true, address: "93.184.216.34", servername: "smtp.example.com" });
  });

  it("refuses names and addresses that point at the inside", async () => {
    for (const host of ["localhost", "LOCALHOST", "db.localhost", "service.internal", "printer.local", "127.0.0.1", "10.0.0.5", "169.254.169.254", "[::1]", "::ffff:10.0.0.1", ""]) {
      const r = await resolveSmtpTarget(host, 587, policy());
      expect(r, host).toEqual({ ok: false, error: SMTP_HOST_NOT_ALLOWED });
    }
  });

  it("catches odd spellings of an address, because it judges the resolved address (decimal, hex, short form)", async () => {
    // The system resolver turns these into 127.0.0.1 / 169.254.169.254; the guard sees that.
    for (const [host, resolvesTo] of [["2130706433", "127.0.0.1"], ["0x7f.1", "127.0.0.1"], ["127.1", "127.0.0.1"], ["2852039166", "169.254.169.254"]] as const) {
      const r = await resolveSmtpTarget(host, 587, policy({ lookup: lookupOf(resolvesTo) }));
      expect(r.ok, host).toBe(false);
    }
  });

  it("refuses a public-looking name whose DNS answer is private", async () => {
    expect(await resolveSmtpTarget("mail.evil.example", 587, policy({ lookup: lookupOf("10.1.2.3") }))).toEqual({ ok: false, error: SMTP_HOST_NOT_ALLOWED });
  });

  it("refuses when ANY of several answers is private (a public address next to a private one is still a way in)", async () => {
    expect((await resolveSmtpTarget("mail.example", 587, policy({ lookup: lookupOf("93.184.216.34", "192.168.1.9") }))).ok).toBe(false);
    expect((await resolveSmtpTarget("mail.example", 587, policy({ lookup: lookupOf("93.184.216.34", "fe80::1") }))).ok).toBe(false);
  });

  it("prefers an IPv4 address when both kinds are public", async () => {
    const r = await resolveSmtpTarget("mail.example", 587, policy({ lookup: lookupOf("2606:4700::1111", "93.184.216.34") }));
    expect(r).toMatchObject({ ok: true, address: "93.184.216.34" });
  });

  it("explains a name that does not exist or answers nothing", async () => {
    const boom: LookupFn = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await resolveSmtpTarget("nope.example", 587, policy({ lookup: boom }))).toMatchObject({ ok: false, error: expect.stringMatching(/could not be found/) });
    expect(await resolveSmtpTarget("nope.example", 587, policy({ lookup: lookupOf() }))).toMatchObject({ ok: false });
  });

  it("allows only the usual mail ports, and names them", async () => {
    for (const port of [25, 465, 587, 2465, 2525]) expect((await resolveSmtpTarget("smtp.example.com", port, policy())).ok, String(port)).toBe(true);
    for (const port of [22, 80, 443, 3306, 5432, 6379, 8080, 9200, 11211]) {
      const r = await resolveSmtpTarget("smtp.example.com", port, policy());
      expect(r, String(port)).toMatchObject({ ok: false, error: expect.stringMatching(/25, 465, 587, 2465, 2525/) });
    }
  });

  it("an exempt host skips both checks (the operator's own relay)", async () => {
    const p = policy({ allowedHosts: ["mailpit", "10.9.8.7"] });
    expect(await resolveSmtpTarget("mailpit", 1025, p)).toMatchObject({ ok: true, address: "mailpit" });
    expect(await resolveSmtpTarget("MailPit.", 1025, p)).toMatchObject({ ok: true });
    expect(await resolveSmtpTarget("10.9.8.7", 25, p)).toMatchObject({ ok: true });
    expect((await resolveSmtpTarget("10.9.8.8", 25, p)).ok).toBe(false); // only the listed one
  });
});

describe("the adapter with the guard on", () => {
  const cfg = (host: string, over: Record<string, unknown> = {}) => ({ host, port: 587, secure: false, username: "u", password: "p", hostPolicy: policy(), ...over });

  it("never builds a connection to a refused destination: send is refused as a settings problem (not permanent) and verify says why", async () => {
    const a = new SmtpTransportAdapter(cfg("127.0.0.1"));
    expect(mockCreateTransport).not.toHaveBeenCalled();
    const r = await a.send(params);
    expect(r).toMatchObject({ success: false, permanent: false });
    expect((r as { error: string }).error).toMatch(/destination refused/);
    expect(await a.verify()).toEqual({ ok: false, error: SMTP_HOST_NOT_ALLOWED });
    expect(mockCreateTransport).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("connects to the address it checked and still verifies the certificate against the original name, then closes", async () => {
    const a = new SmtpTransportAdapter(cfg("smtp.example.com"));
    expect((await a.send(params)).success).toBe(true);
    const opts = mockCreateTransport.mock.calls[0]![0] as { host: string; tls: { servername: string; rejectUnauthorized: boolean } };
    expect(opts.host).toBe("93.184.216.34");
    expect(opts.tls).toMatchObject({ servername: "smtp.example.com", rejectUnauthorized: true });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("checks again on every send, so a name that turns private later (DNS rebinding) is refused", async () => {
    let answer = "93.184.216.34";
    const lookup: LookupFn = async () => [{ address: answer, family: 4 }];
    const a = new SmtpTransportAdapter(cfg("smtp.example.com", { hostPolicy: policy({ lookup }) }));
    expect((await a.send(params)).success).toBe(true);
    answer = "169.254.169.254";
    const r = await a.send(params);
    expect(r).toMatchObject({ success: false, permanent: false });
    expect(mockCreateTransport).toHaveBeenCalledTimes(1); // the second call never connected
  });

  it("closes the connection even when sending fails", async () => {
    mockSendMail.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "ECONNRESET" }));
    const a = new SmtpTransportAdapter(cfg("smtp.example.com"));
    expect((await a.send(params)).success).toBe(false);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("refuses a port outside the mail ports without connecting", async () => {
    const a = new SmtpTransportAdapter(cfg("smtp.example.com", { port: 5432 }));
    expect(await a.verify()).toMatchObject({ ok: false, error: expect.stringMatching(/port is not allowed/) });
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });
});

describe("the adapter with the guard off or exempt: behaves exactly as before", () => {
  it("builds its connection up front, to the host as typed", async () => {
    const a = new SmtpTransportAdapter({ host: "127.0.0.1", port: 1025, secure: false });
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect((mockCreateTransport.mock.calls[0]![0] as { host: string }).host).toBe("127.0.0.1");
    expect((await a.send(params)).success).toBe(true);
    expect(mockClose).not.toHaveBeenCalled(); // reused, closed only by close()
    a.close();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("with the guard explicitly off, a private host is allowed", async () => {
    const a = new SmtpTransportAdapter({ host: "10.0.0.5", port: 25, secure: false, hostPolicy: policy({ restrict: false }) });
    expect((await a.verify()).ok).toBe(true);
  });

  it("an exempt host is allowed even with the guard on", async () => {
    const a = new SmtpTransportAdapter({ host: "mailpit", port: 1025, secure: false, hostPolicy: policy({ allowedHosts: ["mailpit"] }) });
    expect((await a.send(params)).success).toBe(true);
    expect((mockCreateTransport.mock.calls[0]![0] as { host: string }).host).toBe("mailpit");
  });
});
