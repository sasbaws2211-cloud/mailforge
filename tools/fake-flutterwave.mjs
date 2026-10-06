#!/usr/bin/env node
/**
 * Fake Flutterwave for local development. NOT for production, and it holds no real
 * money or credentials: it lets you click through the whole billing flow (checkout,
 * webhooks, return page, renewals, cancellation) without a Flutterwave account.
 *
 * It implements the same v3 endpoints Mailforge calls, shows a hosted payment page
 * with Pay / Fail / Cancel buttons, and on "Pay" does what Flutterwave does: records
 * the transaction, creates the subscription, POSTs a signed webhook to the app, and
 * redirects the browser to the app's return URL.
 *
 *   node tools/fake-flutterwave.mjs
 *
 * Environment:
 *   PORT                    listen port                          (default 4010)
 *   FAKE_FW_SECRET          API key the app must send            (default FLWSECK_TEST-local-fake-key)
 *   FAKE_FW_HASH            webhook secret hash (verif-hash)     (default local-fake-webhook-hash)
 *   FAKE_FW_WEBHOOK_URL     where to send webhooks               (default http://localhost:3010/webhooks/flutterwave)
 *   FAKE_FW_PUBLIC_URL      how the BROWSER reaches this server  (default http://localhost:PORT)
 *
 * Open the control page at / to see plans, payments and subscriptions, and to trigger a
 * renewal charge.
 */
import http from "node:http";

const PORT = Number(process.env.PORT ?? 4010);
const SECRET = process.env.FAKE_FW_SECRET ?? "FLWSECK_TEST-local-fake-key";
const HASH = process.env.FAKE_FW_HASH ?? "local-fake-webhook-hash";
const WEBHOOK_URL = process.env.FAKE_FW_WEBHOOK_URL ?? "http://localhost:3010/webhooks/flutterwave";
const PUBLIC_URL = (process.env.FAKE_FW_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");

const plans = [];
const payments = [];
const subscriptions = [];
const transactions = new Map();
let nextPlan = 50001;
let nextTx = 800001;
let nextSub = 6001;
let nextToken = 1;
const log = [];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const note = (m) => { log.unshift(`${new Date().toISOString().slice(11, 19)}  ${m}`); log.length = Math.min(log.length, 30); console.log(m); };

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
const ok = (res, data) => json(res, 200, { status: "success", message: "OK", data });
const fail = (res, status, message) => json(res, status, { status: "error", message, data: null });
function html(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fake Flutterwave</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#222}h1{font-size:20px}h2{font-size:16px;margin-top:28px}
.card{border:1px solid #ddd;border-radius:10px;padding:18px;margin:14px 0}.banner{background:#fff4e5;border:1px solid #f0c27b;border-radius:8px;padding:10px 12px;font-size:13px}
button{font:inherit;padding:9px 16px;border-radius:8px;border:1px solid #bbb;background:#fff;cursor:pointer}button.pay{background:#f5a623;border-color:#f5a623;font-weight:600}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #eee;text-align:left;padding:6px 8px}code{background:#f3f3f3;padding:1px 5px;border-radius:4px}pre{background:#f7f7f7;padding:10px;border-radius:8px;font-size:12px;overflow:auto}</style>${body}`);
}

async function sendWebhook(payload) {
  try {
    const r = await fetch(WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json", "verif-hash": HASH }, body: JSON.stringify(payload) });
    note(`webhook ${payload.event} -> ${r.status}`);
    return r.status;
  } catch (e) {
    note(`webhook ${payload.event} FAILED: ${e.message}`);
    return 0;
  }
}

function makeTransaction(payment, status) {
  const id = nextTx++;
  const tx = {
    id, tx_ref: payment.txRef, flw_ref: `FLW-${id}`, amount: payment.amount, charged_amount: payment.amount, currency: payment.currency,
    status, payment_type: "card", customer: { id: 1, email: payment.email, name: payment.name }, meta: payment.meta, plan: payment.paymentPlan ? Number(payment.paymentPlan) : null,
  };
  transactions.set(id, tx);
  return tx;
}

function chargeWebhook(tx) {
  return { event: "charge.completed", data: { id: tx.id, tx_ref: tx.tx_ref, flw_ref: tx.flw_ref, amount: tx.amount, currency: tx.currency, charged_amount: tx.charged_amount, status: tx.status, payment_type: "card", customer: tx.customer } };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve({ raw, json: raw ? JSON.parse(raw) : null }); } catch { resolve({ raw, json: null }); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", PUBLIC_URL);
  const path = url.pathname.replace(/^\/v3/, "");
  const { json: body } = req.method === "POST" || req.method === "PUT" ? await readBody(req) : { json: null };

  // ---------- Browser pages ----------
  if (req.method === "GET" && path === "/") {
    return html(res, `<h1>Fake Flutterwave</h1><p class="banner">Local development stand-in. No real money, no real cards. Webhooks go to <code>${esc(WEBHOOK_URL)}</code>.</p>
<h2>Subscriptions</h2>${subscriptions.length ? `<table><tr><th>id</th><th>payer</th><th>plan</th><th>status</th><th></th></tr>${subscriptions.map((s) => `<tr><td>${s.id}</td><td>${esc(s.email)}</td><td>${s.plan} ($${s.amount})</td><td>${s.status}</td><td>${s.status === "active" ? `<form method="POST" action="/control/renew/${s.id}" style="margin:0"><button>Run renewal charge</button></form>` : ""}</td></tr>`).join("")}</table>` : "<p>None yet.</p>"}
<h2>Payments</h2>${payments.length ? `<table><tr><th>tx_ref</th><th>amount</th><th>payer</th><th>status</th></tr>${payments.map((p) => `<tr><td><code>${esc(p.txRef)}</code></td><td>${p.amount} ${p.currency}</td><td>${esc(p.email)}</td><td>${p.status ?? "waiting"}</td></tr>`).join("")}</table>` : "<p>None yet.</p>"}
<h2>Recent activity</h2><pre>${esc(log.join("\n") || "nothing yet")}</pre>`);
  }

  const hosted = req.method === "GET" && path.match(/^\/hosted\/pay\/([^/]+)$/);
  if (hosted) {
    const p = payments.find((x) => x.token === hosted[1]);
    if (!p) return html(res, "<h1>Payment link not found</h1>", 404);
    return html(res, `<h1>Pay Mailforge</h1><div class="card"><p><b>${esc(p.name)}</b> &middot; ${esc(p.email)}</p>
<p style="font-size:28px;margin:6px 0"><b>${p.amount} ${esc(p.currency)}</b></p><p>${esc(p.meta?.plan ?? "")} plan, ${esc(p.meta?.interval ?? "")}. Recurring card payment. <code>${esc(p.txRef)}</code></p>
<p class="banner">This is a fake checkout. Pick an outcome:</p>
<form method="POST" action="/hosted/pay/${esc(p.token)}/pay" style="display:inline"><button class="pay">Pay ${p.amount} ${esc(p.currency)}</button></form>
<form method="POST" action="/hosted/pay/${esc(p.token)}/fail" style="display:inline"><button>Card declined</button></form>
<form method="POST" action="/hosted/pay/${esc(p.token)}/cancel" style="display:inline"><button>Cancel</button></form></div>`);
  }

  const act = req.method === "POST" && path.match(/^\/hosted\/pay\/([^/]+)\/(pay|fail|cancel)$/);
  if (act) {
    const p = payments.find((x) => x.token === act[1]);
    if (!p) return html(res, "<h1>Payment link not found</h1>", 404);
    const back = (qs) => { res.writeHead(303, { Location: `${p.redirectUrl}${p.redirectUrl.includes("?") ? "&" : "?"}${new URLSearchParams(qs)}` }); res.end(); };
    if (act[2] === "cancel") { p.status = "cancelled"; note(`customer cancelled ${p.txRef}`); return back({ status: "cancelled", tx_ref: p.txRef }); }
    const status = act[2] === "pay" ? "successful" : "failed";
    const tx = makeTransaction(p, status);
    p.status = status; p.transactionId = tx.id;
    if (status === "successful" && p.paymentPlan) subscriptions.push({ id: nextSub++, plan: Number(p.paymentPlan), email: p.email, status: "active", amount: p.amount });
    note(`customer ${status === "successful" ? "paid" : "was declined on"} ${p.txRef} (transaction ${tx.id})`);
    // Flutterwave sends the webhook and redirects the browser at about the same time.
    sendWebhook(chargeWebhook(tx));
    return back({ status, tx_ref: p.txRef, transaction_id: tx.id });
  }

  const renew = req.method === "POST" && path.match(/^\/control\/renew\/(\d+)$/);
  if (renew) {
    const sub = subscriptions.find((s) => s.id === Number(renew[1]));
    if (!sub || sub.status !== "active") return html(res, "<h1>No such active subscription</h1>", 404);
    const plan = plans.find((p) => p.id === sub.plan);
    const pay = { txRef: `RECUR-${nextTx}`, amount: plan.amount, currency: plan.currency, email: sub.email, name: "", meta: null, paymentPlan: String(plan.id) };
    const tx = makeTransaction(pay, "successful");
    note(`renewal charge ${tx.id} for subscription ${sub.id}`);
    await sendWebhook(chargeWebhook(tx));
    res.writeHead(303, { Location: "/" }); res.end();
    return;
  }

  // ---------- API (v3) ----------
  if (req.headers.authorization !== `Bearer ${SECRET}`) return fail(res, 401, "Invalid authorization key");
  const b = body ?? {};

  if (req.method === "POST" && path === "/payment-plans") {
    if (!b.name || typeof b.amount !== "number" || !b.interval) return fail(res, 400, "name, amount and interval are required");
    const plan = { id: nextPlan++, name: b.name, amount: b.amount, interval: b.interval, currency: b.currency ?? "NGN" };
    plans.push(plan);
    note(`plan created: ${plan.name} ${plan.amount} ${plan.currency}`);
    return ok(res, { ...plan, status: "active", plan_token: `rpp_${plan.id}`, created_at: new Date().toISOString() });
  }

  if (req.method === "POST" && path === "/payments") {
    const c = b.customer ?? {};
    if (!b.tx_ref || !b.amount || !b.currency || !b.redirect_url || !c.email) return fail(res, 400, "tx_ref, amount, currency, redirect_url and customer.email are required");
    if (payments.some((p) => p.txRef === b.tx_ref)) return fail(res, 400, "tx_ref already used");
    let paymentPlan = null;
    if (b.payment_plan != null) {
      const plan = plans.find((p) => String(p.id) === String(b.payment_plan));
      if (!plan) return fail(res, 400, "payment plan not found");
      if (plan.currency !== b.currency) return fail(res, 400, "currency does not match the payment plan currency");
      paymentPlan = String(plan.id);
    }
    const p = { txRef: b.tx_ref, amount: b.amount, currency: b.currency, paymentPlan, email: c.email, name: c.name ?? "", redirectUrl: b.redirect_url, meta: b.meta ?? {}, token: `tok${nextToken++}` };
    payments.push(p);
    note(`checkout created for ${p.email}: ${p.amount} ${p.currency}`);
    return ok(res, { link: `${PUBLIC_URL}/hosted/pay/${p.token}` });
  }

  const verify = req.method === "GET" && path.match(/^\/transactions\/([^/]+)\/verify$/);
  if (verify) {
    const tx = transactions.get(Number(verify[1]));
    return tx ? ok(res, tx) : fail(res, 404, "No transaction was found for this id");
  }

  if (req.method === "GET" && path === "/subscriptions") {
    const email = url.searchParams.get("email");
    return ok(res, subscriptions.filter((s) => !email || s.email.toLowerCase() === email.toLowerCase())
      .map((s) => ({ id: s.id, amount: s.amount, customer: { id: 1, customer_email: s.email }, plan: s.plan, status: s.status, created_at: new Date().toISOString() })));
  }

  const cancel = req.method === "PUT" && path.match(/^\/subscriptions\/([^/]+)\/cancel$/);
  if (cancel) {
    const sub = subscriptions.find((s) => String(s.id) === cancel[1]);
    if (!sub) return fail(res, 404, "Subscription not found");
    sub.status = "cancelled";
    note(`subscription ${sub.id} cancelled`);
    return ok(res, { id: sub.id, amount: sub.amount, customer: { id: 1, customer_email: sub.email }, plan: sub.plan, status: "cancelled" });
  }

  return fail(res, 404, `no such route: ${req.method} ${path}`);
});

server.listen(PORT, "0.0.0.0", () => console.log(`Fake Flutterwave on :${PORT} (browser URL ${PUBLIC_URL}); webhooks -> ${WEBHOOK_URL}`));
