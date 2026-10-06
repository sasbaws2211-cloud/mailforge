/**
 * Resend domains client: create a sending domain in the operator's Resend account,
 * read the DNS records the customer must add, ask Resend to verify, and remove it.
 *
 * Used only for managed sending, with the operator's own API key and base URL (never
 * anything a customer supplied). Responses are normalised so callers never see
 * Resend's raw shapes, and errors carry a plain kind plus a safe message (never the key).
 *
 * Endpoints (https://resend.com/docs/api-reference/domains):
 *   POST   /domains                 create       -> { id, name, status, records[] }
 *   GET    /domains/{id}            read         -> same shape
 *   POST   /domains/{id}/verify     start verify -> { id }   (asynchronous: read it back later)
 *   DELETE /domains/{id}            remove
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */

export type DomainStatus = "not_started" | "pending" | "verified" | "failed" | "temporary_failure";

const KNOWN_STATUSES: readonly string[] = ["not_started", "pending", "verified", "failed", "temporary_failure"];

/** One DNS record the customer must create at their DNS host. */
export interface DnsRecord {
  /** What it is for: "SPF", "DKIM", "Receiving", ... */
  record: string;
  /** The host name to create. Relative to the domain (Resend's own wording). */
  name: string;
  /** TXT, MX, CNAME. */
  type: string;
  value: string;
  ttl: string;
  /** Resend's state for this one record. */
  status: string;
  priority?: number;
}

export interface ResendDomain {
  id: string;
  name: string;
  status: DomainStatus;
  records: DnsRecord[];
}

export type DomainErrorKind =
  | "exists" // that domain is already registered in the account
  | "invalid" // Resend rejected the request (bad domain)
  | "auth" // the operator's key is wrong or lacks permission
  | "rate_limited"
  | "not_found"
  | "unavailable"; // network or Resend outage

export type DomainsResult<T> = { ok: true; value: T } | { ok: false; kind: DomainErrorKind; message: string; status: number | null };

export interface ResendDomainsClient {
  createDomain(name: string): Promise<DomainsResult<ResendDomain>>;
  getDomain(id: string): Promise<DomainsResult<ResendDomain>>;
  verifyDomain(id: string): Promise<DomainsResult<{ id: string }>>;
  deleteDomain(id: string): Promise<DomainsResult<{ id: string }>>;
}

const TIMEOUT_MS = 15_000;

function normaliseDomain(raw: unknown): ResendDomain | null {
  const d = raw as { id?: unknown; name?: unknown; status?: unknown; records?: unknown } | null;
  if (!d || typeof d.id !== "string" || typeof d.name !== "string") return null;
  const status = typeof d.status === "string" && KNOWN_STATUSES.includes(d.status) ? (d.status as DomainStatus) : "pending";
  const records: DnsRecord[] = Array.isArray(d.records)
    ? d.records
        .map((r): DnsRecord | null => {
          const x = (r ?? {}) as Record<string, unknown>;
          if (typeof x.type !== "string" || typeof x.name !== "string" || typeof x.value !== "string") return null;
          return {
            record: typeof x.record === "string" ? x.record : "",
            name: x.name,
            type: x.type,
            value: x.value,
            ttl: x.ttl === undefined || x.ttl === null ? "Auto" : String(x.ttl),
            status: typeof x.status === "string" ? x.status : "not_started",
            ...(typeof x.priority === "number" ? { priority: x.priority } : {}),
          };
        })
        .filter((r): r is DnsRecord => r !== null)
    : [];
  return { id: d.id, name: d.name, status, records };
}

/** Map an error response to a kind and a message that is safe to show to a customer. */
function classify(status: number, body: { name?: string; message?: string } | null): { kind: DomainErrorKind; message: string } {
  const text = `${body?.name ?? ""} ${body?.message ?? ""}`.toLowerCase();
  if (/already|exist|registered|taken|duplicate/.test(text)) return { kind: "exists", message: "That domain is already registered." };
  if (status === 429) return { kind: "rate_limited", message: "The email service is busy. Try again in a minute." };
  if (status === 404) return { kind: "not_found", message: "That domain is not registered with the email service." };
  if (status === 401 || status === 403) return { kind: "auth", message: "The email service rejected this service's credentials." };
  if (status >= 500) return { kind: "unavailable", message: "The email service is not answering. Try again shortly." };
  const detail = typeof body?.message === "string" ? body.message.replace(/re_[A-Za-z0-9_]+/g, "***").slice(0, 200) : "";
  return { kind: "invalid", message: detail || "The email service did not accept that domain." };
}

export function createResendDomainsClient(config: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch }): ResendDomainsClient {
  const base = (config.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "");
  const doFetch = config.fetchImpl ?? fetch;

  async function call<T>(method: string, path: string, body: unknown, shape: (json: unknown) => T | null): Promise<DomainsResult<T>> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, kind: "unavailable", message: "The email service is not answering. Try again shortly.", status: null };
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const c = classify(res.status, json as { name?: string; message?: string } | null);
      return { ok: false, kind: c.kind, message: c.message, status: res.status };
    }
    let value: T | null = null;
    try {
      value = shape(json);
    } catch {
      value = null;
    }
    if (value === null) return { ok: false, kind: "unavailable", message: "The email service sent an answer we could not read.", status: res.status };
    return { ok: true, value };
  }

  const idOnly = (j: unknown) => (typeof (j as { id?: unknown })?.id === "string" ? { id: (j as { id: string }).id } : null);

  return {
    createDomain: (name) => call("POST", "/domains", { name }, normaliseDomain),
    getDomain: (id) => call("GET", `/domains/${encodeURIComponent(id)}`, undefined, normaliseDomain),
    verifyDomain: (id) => call("POST", `/domains/${encodeURIComponent(id)}/verify`, undefined, idOnly),
    deleteDomain: (id) => call("DELETE", `/domains/${encodeURIComponent(id)}`, undefined, (j) => idOnly(j) ?? { id }),
  };
}
