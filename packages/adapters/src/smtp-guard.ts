/**
 * SMTP destination guard: keeps a customer-supplied mail server from being
 * used to reach the operator's own network.
 *
 * On a hosted service a customer types the SMTP host and port, and the server
 * connects to them (to verify the settings, and on every send). Without a
 * guard that is a way to probe anything the server can reach: the database,
 * other containers, the cloud metadata address (169.254.169.254), localhost.
 *
 * The rule, when the guard is on:
 *   - the host is resolved to its real addresses, and the connection is refused
 *     if ANY of them is loopback, private, link-local, carrier-grade NAT,
 *     reserved or multicast (IPv4 and IPv6, including IPv4 hidden inside
 *     IPv6 forms). Odd spellings of an address (decimal, hex, short forms)
 *     are caught because the check is on the resolved address, not the text.
 *   - the connection then goes to the address that was checked (and TLS still
 *     verifies the original name), so a hostname that changes its answer
 *     between the check and the connection cannot slip through (DNS rebinding).
 *   - only the usual mail submission ports are allowed.
 *
 * The operator can exempt hosts they trust (for example a mail relay on their
 * own network) with MAILFORGE_SMTP_ALLOWED_HOSTS. Exempt hosts skip both checks.
 *
 * On by default for a hosted service (public site or plan enforcement on) and
 * off for a self-hosted install, where a local relay is normal.
 * MAILFORGE_RESTRICT_SMTP_HOSTS=true|false overrides either way.
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Ports a customer may use for SMTP when the guard is on. */
export const DEFAULT_ALLOWED_SMTP_PORTS: readonly number[] = [25, 465, 587, 2465, 2525];

export type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;

export interface SmtpHostPolicy {
  /** When false nothing is checked. */
  restrict: boolean;
  /** Hostnames or addresses the operator trusts; they skip the address and port checks. Lower case. */
  allowedHosts: readonly string[];
  allowedPorts: readonly number[];
  /** Test hook: replaces DNS. */
  lookup?: LookupFn;
}

function flag(v: string | undefined): boolean | null {
  if (v === undefined || v.trim() === "") return null;
  const t = v.trim().toLowerCase();
  if (t === "true" || t === "1") return true;
  if (t === "false" || t === "0") return false;
  return null;
}

/** The policy for this process, from environment variables. */
export function smtpHostPolicyFromEnv(env: Record<string, string | undefined> = process.env): SmtpHostPolicy {
  const explicit = flag(env.MAILFORGE_RESTRICT_SMTP_HOSTS);
  const hosted = env.MAILFORGE_PUBLIC_SITE === "true" || env.MAILFORGE_ENFORCE_PLANS === "true";
  const ports = (env.MAILFORGE_SMTP_ALLOWED_PORTS ?? "")
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
  return {
    restrict: explicit ?? hosted,
    allowedHosts: (env.MAILFORGE_SMTP_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => normalizeHost(h))
      .filter((h) => h !== ""),
    allowedPorts: ports.length > 0 ? ports : DEFAULT_ALLOWED_SMTP_PORTS,
  };
}

/** Lower case, no brackets around an IPv6 literal, no trailing dot. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h.replace(/\.$/, "");
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

function v4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** [network, prefix length] pairs that are never a legitimate public mail server. */
const BLOCKED_V4: ReadonlyArray<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including the cloud metadata address
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including broadcast
];

function blockedV4(n: number): boolean {
  for (const [net, bits] of BLOCKED_V4) {
    const base = v4ToInt(net)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((base & mask) >>> 0)) return true;
  }
  return false;
}

/** Expand an IPv6 address to eight 16-bit groups, or null if it is not valid. */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // A dotted IPv4 tail (::ffff:1.2.3.4) is two groups.
  const dot = s.lastIndexOf(".");
  if (dot >= 0) {
    const colon = s.lastIndexOf(":");
    const v4 = v4ToInt(s.slice(colon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, colon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function blockedV6(g: number[]): boolean {
  const [a, b, c, d, e, f, x, y] = g as [number, number, number, number, number, number, number, number];
  const embeddedV4 = ((x << 16) | y) >>> 0;
  if (g.every((v) => v === 0)) return true; // ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && x === 0 && y === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge by the IPv4 inside.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) return blockedV4(embeddedV4);
  // NAT64 (64:ff9b::/96): judge by the IPv4 inside.
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return blockedV4(embeddedV4);
  // 6to4 (2002::/16) embeds an IPv4 in the next 32 bits.
  if (a === 0x2002) return blockedV4(((b << 16) | c) >>> 0);
  if ((a & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((a & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((a & 0xff00) === 0xff00) return true; // multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x2001 && b === 0) return true; // Teredo
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return true; // discard-only
  return false;
}

/** Is this IP address one a customer must not be able to make the server connect to? Unparseable counts as blocked. */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip.includes("%") ? ip.slice(0, ip.indexOf("%")) : ip);
  if (kind === 4) {
    const n = v4ToInt(ip);
    return n === null ? true : blockedV4(n);
  }
  if (kind === 6) {
    const g = expandV6(ip);
    return g === null ? true : blockedV6(g);
  }
  return true;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export type SmtpTargetResult =
  | { ok: true; /** Connect here. Same as the host when nothing was resolved. */ address: string; /** Name for TLS verification. */ servername: string }
  | { ok: false; error: string };

export const SMTP_HOST_NOT_ALLOWED =
  "That mail server address is not allowed on this service. Use a public SMTP server (for example from your email provider), not a local or private address.";

const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * Decide whether the server may connect to host:port, and to which address.
 * With the guard off, or for an exempt host, the host is used as given.
 */
export async function resolveSmtpTarget(host: string, port: number, policy: SmtpHostPolicy): Promise<SmtpTargetResult> {
  const name = normalizeHost(host);
  if (!policy.restrict || policy.allowedHosts.includes(name)) return { ok: true, address: host, servername: host };

  if (!policy.allowedPorts.includes(port)) {
    return { ok: false, error: `That port is not allowed on this service. Mail servers use one of: ${policy.allowedPorts.join(", ")}.` };
  }
  if (name === "" || name === "localhost" || name.endsWith(".localhost") || name.endsWith(".internal") || name.endsWith(".local")) {
    return { ok: false, error: SMTP_HOST_NOT_ALLOWED };
  }

  let addresses: Array<{ address: string; family: number }>;
  if (isIP(name) !== 0) {
    addresses = [{ address: name, family: isIP(name) }];
  } else {
    try {
      addresses = await (policy.lookup ?? defaultLookup)(name);
    } catch {
      return { ok: false, error: "That mail server name could not be found. Check the spelling." };
    }
  }
  if (addresses.length === 0) return { ok: false, error: "That mail server name could not be found. Check the spelling." };
  if (addresses.some((a) => isBlockedIp(a.address))) return { ok: false, error: SMTP_HOST_NOT_ALLOWED };

  // Prefer IPv4: it is what most mail servers listen on and it avoids dual-stack surprises.
  const chosen = addresses.find((a) => a.family === 4) ?? addresses[0]!;
  return { ok: true, address: chosen.address, servername: name };
}
