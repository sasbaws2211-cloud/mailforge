/**
 * Whether to believe the X-Forwarded-For header, which decides what `request.ip` is.
 *
 * Behind a reverse proxy or load balancer (Render, Fly, nginx, Cloudflare) the connection comes
 * from the proxy, so without this every visitor looks like the same IP and the per-IP limits
 * (signups, admin sign-in) would apply to all visitors together. With it, the real client address
 * is taken from the header the proxy adds.
 *
 *   MAILFORGE_TRUST_PROXY unset, "", "false" or "0"   do not trust (the default: the header is ignored,
 *                                                     so a client cannot pick its own address)
 *   MAILFORGE_TRUST_PROXY=true                         trust every hop in the header
 *   MAILFORGE_TRUST_PROXY=<n> (1 to 10)                trust exactly the last n proxies; the most
 *                                                      precise setting when you know how many sit in front
 *
 * Anything else is read as "do not trust": a typo must never silently turn on header trust.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
export function trustProxyFromEnv(value: string | undefined | null): boolean | number {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "true") return true;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return hops >= 1 && hops <= 10 ? hops : false;
  }
  return false;
}
