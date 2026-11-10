#!/usr/bin/env node
/**
 * Send a signed AppSumo-style webhook to a running Loomail, to try the lifetime flow without AppSumo.
 *
 *   APPSUMO_API_KEY=... node tools/appsumo-sim.mjs http://localhost:3010 purchase --key LIC-123 --tier 2
 *
 * Events: purchase | activate | upgrade | downgrade | deactivate
 * Options: --key <licence key> (required) --tier <1-3> --prev <previous key, for upgrade/downgrade> --test (a test ping)
 */
import { createHmac } from "node:crypto";

const args = process.argv.slice(2);
const [base, event] = args;
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
if (!base || !event || !opt("key")) {
  console.error("Usage: node tools/appsumo-sim.mjs <base-url> <event> --key <licence key> [--tier 1] [--prev <key>] [--test]");
  process.exit(1);
}
const apiKey = process.env.APPSUMO_API_KEY ?? "";
if (!apiKey) {
  console.error("Set APPSUMO_API_KEY (the same value the server uses).");
  process.exit(1);
}
const body = JSON.stringify({
  event,
  license_key: opt("key"),
  tier: Number(opt("tier", "1")),
  prev_license_key: opt("prev", null),
  test: args.includes("--test"),
  license_status: event,
});
const ts = String(Date.now());
const sig = createHmac("sha256", apiKey).update(ts).update(body).digest("hex");
const res = await fetch(`${base.replace(/\/+$/, "")}/webhooks/appsumo`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Appsumo-Timestamp": ts, "X-Appsumo-Signature": sig },
  body,
});
console.log(res.status, await res.text());
