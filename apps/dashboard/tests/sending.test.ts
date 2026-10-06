/**
 * Tests for how the dashboard talks about managed sending: the sender summary, the domain
 * status wording, DNS record helpers, and the admin audit sentences. Pure functions.
 */
import { describe, it, expect } from "vitest";
import { describeSender, domainIsSettling, domainStatusInfo, recordFullName, recordPurpose, sendingIsActive } from "../src/sending.js";
import { auditSummary } from "../src/admin.js";
import type { SendingView } from "../src/api.js";

type Managed = NonNullable<SendingView["managed"]>;

function view(over: Partial<SendingView> & { managed?: Partial<Managed> | null } = {}): SendingView {
  const { managed, ...rest } = over;
  const base: Managed = {
    enabled: true,
    domain: null,
    domain_status: "none",
    dns_records: [],
    domain_verified_at: null,
    from_local: "hello",
    from_name: null,
    reply_to: null,
    sender: { mode: "shared", from_email: null, from_name: "Acme", reply_to: "owner@acme-test.dev" },
    paused: null,
    needs_domain: false,
  };
  return { available: true, uses: "managed", shared: { offered: true, daily_limit: 100 }, managed: managed === null ? null : { ...base, ...managed }, ...rest };
}

describe("describeSender", () => {
  it("on the shared address: says who it is from, where replies go, the daily cap, and to add a domain", () => {
    const s = describeSender(view());
    expect(s.tone).toBe("info");
    expect(s.headline).toMatch(/shared Mailforge address/);
    expect(s.detail).toContain("Acme");
    expect(s.detail).toContain("owner@acme-test.dev");
    expect(s.detail).toContain("100 emails a day");
    expect(s.detail).toMatch(/Add your own domain/);
  });

  it("never shows the shared address itself", () => {
    expect(JSON.stringify(describeSender(view()))).not.toMatch(/@mail\.|notifications@/);
  });

  it("from the workspace's own domain: success, with the real address", () => {
    const s = describeSender(view({ managed: { domain: "mail.acme-test.dev", domain_status: "verified", sender: { mode: "domain", from_email: "hello@mail.acme-test.dev", from_name: "Acme", reply_to: null } } }));
    expect(s).toMatchObject({ tone: "success", headline: "Sending from your own domain" });
    expect(s.detail).toContain("Acme <hello@mail.acme-test.dev>");
    expect(s.detail).toMatch(/your account email/);
  });

  it("not offered, off, on standby behind their own provider, and needing a domain each have their own plain message", () => {
    expect(describeSender({ available: false, uses: "nothing", shared: { offered: false, daily_limit: null }, managed: null }).headline).toBe("Not available");
    expect(describeSender(view({ uses: "nothing", managed: null })).headline).toBe("Mailforge Sending is off");
    expect(describeSender(view({ managed: { enabled: false } })).headline).toBe("Mailforge Sending is off");
    expect(describeSender(view({ uses: "own_transport" })).headline).toMatch(/own email provider/);
    const needs = describeSender(view({ uses: "nothing", managed: { sender: null, needs_domain: true } }));
    expect(needs).toMatchObject({ tone: "warning", headline: "Add your domain to start sending" });
  });

  it("a paused workspace is told it is paused, why, that its email is safe, and to contact support; automatic pauses say so", () => {
    const manual = describeSender(view({ uses: "nothing", managed: { paused: { at: "2026-10-04T00:00:00Z", reason: "Investigating", automatic: false } } }));
    expect(manual.tone).toBe("warning");
    expect(manual.detail).toMatch(/Investigating/);
    expect(manual.detail).toMatch(/safe and will send once it resumes/);
    expect(manual.detail).toMatch(/Contact support/);
    expect(manual.detail).not.toMatch(/automatically/);
    const auto = describeSender(view({ uses: "nothing", managed: { paused: { at: "2026-10-04T00:00:00Z", reason: "5 spam complaints", automatic: true } } }));
    expect(auto.detail).toMatch(/paused it automatically/);
  });
});

describe("domainStatusInfo", () => {
  it("has a label, a colour and help for every status Resend can report", () => {
    for (const s of ["verified", "pending", "not_started", "temporary_failure", "failed"]) {
      const i = domainStatusInfo(s);
      expect(i.label.length, s).toBeGreaterThan(0);
      expect(i.help.length, s).toBeGreaterThan(10);
    }
    expect(domainStatusInfo("verified").variant).toBe("success");
    expect(domainStatusInfo("failed").variant).toBe("danger");
    expect(domainStatusInfo("none")).toMatchObject({ label: "Not set up", help: "" });
    expect(domainStatusInfo("something new").label).toBe("Not set up");
  });

  it("the failed help names the commonest DNS slip", () => {
    expect(domainStatusInfo("failed").help).toMatch(/domain name again/);
  });
});

describe("domainIsSettling (poll while true)", () => {
  it("is true while a domain is still being set up, false once it is done or absent", () => {
    for (const s of ["not_started", "pending", "temporary_failure"]) expect(domainIsSettling(s), s).toBe(true);
    for (const s of ["verified", "failed", "none", undefined]) expect(domainIsSettling(s), String(s)).toBe(false);
  });
});

describe("DNS record helpers", () => {
  it("builds the full host name from Resend's relative one, without doubling the domain", () => {
    expect(recordFullName({ name: "send" }, "mail.acme-test.dev")).toBe("send.mail.acme-test.dev");
    expect(recordFullName({ name: "resend._domainkey" }, "acme-test.dev")).toBe("resend._domainkey.acme-test.dev");
    expect(recordFullName({ name: "send.mail.acme-test.dev" }, "mail.acme-test.dev")).toBe("send.mail.acme-test.dev");
    expect(recordFullName({ name: "@" }, "acme-test.dev")).toBe("acme-test.dev");
    expect(recordFullName({ name: "" }, "acme-test.dev")).toBe("acme-test.dev");
  });

  it("says in plain words what each record is for", () => {
    expect(recordPurpose({ record: "DKIM", type: "TXT" })).toMatch(/really comes from you/);
    expect(recordPurpose({ record: "SPF", type: "TXT" })).toMatch(/which service may send/);
    expect(recordPurpose({ record: "SPF", type: "MX" })).toMatch(/bounces/);
    expect(recordPurpose({ record: "DMARC", type: "TXT" })).toMatch(/inboxes/);
    expect(recordPurpose({ record: "", type: "TXT" })).toMatch(/verify/);
  });
});

describe("sendingIsActive", () => {
  it("is true only when mail really goes out through Mailforge Sending", () => {
    expect(sendingIsActive(view())).toBe(true);
    expect(sendingIsActive(view({ uses: "own_transport" }))).toBe(false);
    expect(sendingIsActive(view({ uses: "nothing" }))).toBe(false);
    expect(sendingIsActive(undefined)).toBe(false);
  });
});

describe("admin audit wording", () => {
  const e = (action: string) => ({ actor: "a", action, detail: {}, at: null });
  it("describes managed sending pauses and resumes", () => {
    expect(auditSummary(e("managed_sending_pause"))).toBe("Paused managed sending");
    expect(auditSummary(e("managed_sending_resume"))).toBe("Resumed managed sending");
    expect(auditSummary(e("managed_sending_auto_pause"))).toMatch(/paused automatically/);
  });
});
