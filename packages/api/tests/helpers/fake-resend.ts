/**
 * A fake Resend for tests and local checks: the domains API, the send API and
 * signed webhooks, with just enough of Resend's behaviour to exercise managed
 * sending end to end.
 *
 * Behaviour copied from Resend's docs: creating a domain returns an id, a status
 * and DNS records; verifying is asynchronous (the status stays "pending" until the
 * test, standing in for DNS, calls setStatus); a domain can be registered once per
 * account; sending from a domain that is not verified is refused with 403.
 *
 * Not Resend: nothing here is checked against real DNS or real delivery.
 */
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeDomain {
  id: string;
  name: string;
  status: string;
  records: Array<Record<string, unknown>>;
  verifyRequests: number;
}

export interface FakeEmail {
  id: string;
  key: string;
  idempotencyKey: string | null;
  from: string;
  to: string[];
  subject: string;
  headers: Record<string, string>;
  replyTo: string | null;
}

export interface FakeResend {
  baseUrl: string;
  apiKey: string;
  webhookSecret: string;
  domains: Map<string, FakeDomain>;
  emails: FakeEmail[];
  requests: Array<{ method: string; path: string }>;
  /** Mark a domain verified (or any status), standing in for DNS being set up. */
  setStatus(domainName: string, status: string): void;
  /** Make a domain count as verified from the start (the operator's own shared domain). */
  addVerifiedDomain(name: string): void;
  /** The next request to this path prefix answers this error. */
  failNext(pathPrefix: string, status: number, name: string, message: string, times?: number): void;
  /** Take the whole fake offline (connections refused) or bring it back. */
  setDown(down: boolean): void;
  /** Headers and body for a webhook event signed like Resend (Svix). */
  signedWebhook(event: Record<string, unknown>, opts?: { secret?: string; timestamp?: number; id?: string }): { body: string; headers: Record<string, string> };
  close(): Promise<void>;
}

function records(domain: string): Array<Record<string, unknown>> {
  return [
    { record: "SPF", name: "send", type: "MX", value: "feedback-smtp.us-east-1.amazonses.com", ttl: "Auto", status: "not_started", priority: 10 },
    { record: "SPF", name: "send", type: "TXT", value: "v=spf1 include:amazonses.com ~all", ttl: "Auto", status: "not_started" },
    { record: "DKIM", name: "resend._domainkey", type: "TXT", value: `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ-${domain}`, ttl: "Auto", status: "not_started" },
  ];
}

export async function startFakeResend(opts: { apiKey?: string; webhookSecret?: string; port?: number } = {}): Promise<FakeResend> {
  const apiKey = opts.apiKey ?? "re_fake_managed_key";
  const webhookSecret = opts.webhookSecret ?? `whsec_${Buffer.from("fake-resend-webhook-secret-0123456789").toString("base64")}`;
  const domains = new Map<string, FakeDomain>(); // by id
  const emails: FakeEmail[] = [];
  const requests: Array<{ method: string; path: string }> = [];
  const failures: Array<{ prefix: string; status: number; name: string; message: string; left: number }> = [];
  let down = false;

  const byName = (name: string) => [...domains.values()].find((d) => d.name === name);
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (down) {
      req.socket.destroy();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      const method = req.method ?? "GET";
      requests.push({ method, path });

      if ((req.headers.authorization ?? "") !== `Bearer ${apiKey}`) {
        return json(res, 401, { name: "restricted_api_key", message: "API key is invalid", statusCode: 401 });
      }
      const fail = failures.find((f) => path.startsWith(f.prefix) && f.left > 0);
      if (fail) {
        fail.left--;
        return json(res, fail.status, { name: fail.name, message: fail.message, statusCode: fail.status });
      }
      let body: Record<string, unknown> = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return json(res, 400, { name: "invalid_json", message: "bad json", statusCode: 400 });
      }

      if (method === "POST" && path === "/domains") {
        const name = String(body.name ?? "").toLowerCase();
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(name)) return json(res, 422, { name: "validation_error", message: "The domain name is invalid.", statusCode: 422 });
        if (byName(name)) return json(res, 403, { name: "validation_error", message: "This domain has already been registered.", statusCode: 403 });
        const d: FakeDomain = { id: randomUUID(), name, status: "not_started", records: records(name), verifyRequests: 0 };
        domains.set(d.id, d);
        return json(res, 200, { id: d.id, name: d.name, status: d.status, records: d.records, region: "us-east-1", created_at: new Date().toISOString() });
      }
      const m = /^\/domains\/([^/]+)(\/verify)?$/.exec(path);
      if (m) {
        const d = domains.get(decodeURIComponent(m[1]!));
        if (!d) return json(res, 404, { name: "not_found", message: "Domain not found", statusCode: 404 });
        if (method === "GET" && !m[2]) return json(res, 200, { object: "domain", id: d.id, name: d.name, status: d.status, records: d.records });
        if (method === "POST" && m[2]) {
          d.verifyRequests++;
          if (d.status === "not_started") d.status = "pending";
          return json(res, 200, { object: "domain", id: d.id });
        }
        if (method === "DELETE" && !m[2]) {
          domains.delete(d.id);
          return json(res, 200, { object: "domain", id: d.id, deleted: true });
        }
      }
      if (method === "POST" && path === "/emails") {
        const from = String(body.from ?? "");
        const addr = (/<([^>]+)>/.exec(from)?.[1] ?? from).toLowerCase();
        const domain = addr.split("@")[1] ?? "";
        const known = byName(domain);
        if (!known || known.status !== "verified") {
          return json(res, 403, { name: "validation_error", message: `The ${domain} domain is not verified. Please, add and verify your domain.`, statusCode: 403 });
        }
        const to = Array.isArray(body.to) ? (body.to as string[]) : [String(body.to ?? "")];
        if (to.some((t) => !t.includes("@"))) return json(res, 422, { name: "validation_error", message: "Invalid `to` field.", statusCode: 422 });
        const e: FakeEmail = {
          id: randomUUID(),
          key: String(req.headers.authorization),
          idempotencyKey: (req.headers["idempotency-key"] as string | undefined) ?? null,
          from,
          to,
          subject: String(body.subject ?? ""),
          headers: (body.headers as Record<string, string>) ?? {},
          replyTo: typeof body.reply_to === "string" ? body.reply_to : null,
        };
        emails.push(e);
        return json(res, 200, { id: e.id });
      }
      json(res, 404, { name: "not_found", message: "Route not found", statusCode: 404 });
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey,
    webhookSecret,
    domains,
    emails,
    requests,
    setStatus(name, status) {
      const d = byName(name);
      if (!d) throw new Error(`fake resend: no domain ${name}`);
      d.status = status;
      for (const r of d.records) r.status = status === "verified" ? "verified" : status === "failed" ? "failed" : r.status;
    },
    addVerifiedDomain(name) {
      const d: FakeDomain = { id: randomUUID(), name, status: "verified", records: records(name), verifyRequests: 0 };
      domains.set(d.id, d);
    },
    failNext(pathPrefix, status, name, message, times = 1) {
      failures.push({ prefix: pathPrefix, status, name, message, left: times });
    },
    setDown(v) {
      down = v;
    },
    signedWebhook(event, o = {}) {
      const body = JSON.stringify(event);
      const id = o.id ?? `msg_${randomUUID()}`;
      const ts = String(o.timestamp ?? Math.floor(Date.now() / 1000));
      const secret = o.secret ?? webhookSecret;
      const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
      const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
      return { body, headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` } };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
