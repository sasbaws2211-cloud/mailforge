/**
 * Where a customer-typed warehouse address may point (Postgres, MySQL and SQL Server: Snowflake and BigQuery addresses are built by
 * Loomail from an account name, so the customer never supplies a host for them).
 *
 * Same worry and same rule as the SMTP and webhook guards: the server must not become a way to reach the
 * operator's own network. When the guard is on, the host is resolved, refused if ANY address is loopback,
 * private, link-local, carrier-grade NAT, reserved or multicast, and the connection goes to the address that was
 * checked (DNS rebinding). On by default for a hosted service; LOOMAIL_RESTRICT_WAREHOUSE_HOSTS=true|false overrides,
 * LOOMAIL_WAREHOUSE_ALLOWED_HOSTS exempts trusted hosts.
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isBlockedIp, normalizeHost, type LookupFn } from "../smtp-guard.js";

export interface WarehouseHostPolicy {
  restrict: boolean;
  allowedHosts: readonly string[];
  lookup?: LookupFn;
}

function flag(v: string | undefined): boolean | null {
  if (v === undefined || v.trim() === "") return null;
  const t = v.trim().toLowerCase();
  if (t === "true" || t === "1") return true;
  if (t === "false" || t === "0") return false;
  return null;
}

export function warehouseHostPolicyFromEnv(env: Record<string, string | undefined> = process.env): WarehouseHostPolicy {
  const explicit = flag(env.LOOMAIL_RESTRICT_WAREHOUSE_HOSTS);
  const hosted = env.LOOMAIL_PUBLIC_SITE === "true" || env.LOOMAIL_ENFORCE_PLANS === "true";
  return {
    restrict: explicit ?? hosted,
    allowedHosts: (env.LOOMAIL_WAREHOUSE_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => normalizeHost(h))
      .filter((h) => h !== ""),
  };
}

export const WAREHOUSE_HOST_NOT_ALLOWED = "That address is not allowed on this service. Use a public database address, not a local or private one.";

const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true, verbatim: true });

export type WarehouseTarget = { ok: true; address: string; servername: string } | { ok: false; error: string };

export async function resolveWarehouseHost(host: string, policy: WarehouseHostPolicy): Promise<WarehouseTarget> {
  const name = normalizeHost(host);
  if (name === "") return { ok: false, error: "The database host is empty." };
  if (!policy.restrict || policy.allowedHosts.includes(name)) return { ok: true, address: host, servername: host };
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".internal") || name.endsWith(".local")) {
    return { ok: false, error: WAREHOUSE_HOST_NOT_ALLOWED };
  }
  let addresses: Array<{ address: string; family: number }>;
  if (isIP(name) !== 0) {
    addresses = [{ address: name, family: isIP(name) }];
  } else {
    try {
      addresses = await (policy.lookup ?? defaultLookup)(name);
    } catch {
      return { ok: false, error: "The database host could not be found. Check the spelling." };
    }
  }
  if (addresses.length === 0) return { ok: false, error: "The database host could not be found. Check the spelling." };
  if (addresses.some((a) => isBlockedIp(a.address))) return { ok: false, error: WAREHOUSE_HOST_NOT_ALLOWED };
  const chosen = addresses.find((a) => a.family === 4) ?? addresses[0]!;
  return { ok: true, address: chosen.address, servername: name };
}
