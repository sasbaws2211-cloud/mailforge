/**
 * Runs the test fake of Resend as a local stand-in, for trying managed sending without a real
 * Resend account (see guide/SENDING.md). Not for production: nothing here is real.
 *
 *   npx tsx tools/run-fake-resend.ts
 *
 * Resend API   http://0.0.0.0:4030   (set MAILFORGE_MANAGED_RESEND_BASE_URL to it)
 * Control      http://0.0.0.0:4031
 *   /state                     domains and emails the fake has seen
 *   /verify?domain=x.example   mark a domain verified (stands in for DNS being set up)
 *   /fail?domain=x.example     mark a domain failed
 *   /event?type=email.bounced&email_id=ID[&bounce=Permanent]&to=http://127.0.0.1:3010
 *                              send a signed webhook to the app (type: email.bounced, email.complained, email.delivered)
 */
import { createServer } from "node:http";
import { startFakeResend } from "../packages/api/tests/helpers/fake-resend.js";

const API_KEY = process.env.FAKE_RESEND_KEY || "re_fake_local_key";
const SECRET = process.env.FAKE_RESEND_WEBHOOK_SECRET || `whsec_${Buffer.from("fake-resend-local-webhook-secret").toString("base64")}`;
const fake = await startFakeResend({ apiKey: API_KEY, webhookSecret: SECRET, port: 4030 });
fake.addVerifiedDomain(process.env.FAKE_RESEND_SHARED_DOMAIN || "mail.platform.test");

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const out = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  };
  try {
    if (url.pathname === "/state") {
      return out(200, { domains: [...fake.domains.values()].map((d) => ({ name: d.name, status: d.status, verifyRequests: d.verifyRequests })), emails: fake.emails });
    }
    if (url.pathname === "/verify" || url.pathname === "/fail") {
      fake.setStatus(url.searchParams.get("domain") ?? "", url.pathname === "/verify" ? "verified" : "failed");
      return out(200, { ok: true });
    }
    if (url.pathname === "/event") {
      const bounce = url.searchParams.get("bounce");
      const signed = fake.signedWebhook({
        type: url.searchParams.get("type") ?? "email.delivered",
        created_at: new Date().toISOString(),
        data: { email_id: url.searchParams.get("email_id"), ...(bounce ? { bounce: { type: bounce } } : {}) },
      });
      const target = `${url.searchParams.get("to") ?? "http://127.0.0.1:3010"}/webhooks/resend-platform`;
      const r = await fetch(target, { method: "POST", headers: signed.headers, body: signed.body });
      return out(200, { posted_to: target, status: r.status });
    }
    out(404, { error: "see the comment at the top of tools/run-fake-resend.ts" });
  } catch (err) {
    out(500, { error: String(err) });
  }
}).listen(4031, "0.0.0.0", () => console.log("fake resend on :4030, control on :4031"));
