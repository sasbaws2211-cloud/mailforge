/**
 * A fake Flutterwave v3 API for tests. It behaves like the parts of the real
 * API that billing uses, records every request it receives, and can be told to
 * fail, so the client and the whole billing flow are tested without real keys.
 *
 * It models the rules that matter: the Bearer key is checked, a payment plan
 * makes a payment card-only and tied to the payer email, and a completed
 * payment under a plan creates a subscription that can be listed and cancelled.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface FakePlan {
  id: number;
  name: string;
  amount: number;
  interval: string;
  currency: string;
}

export interface FakePayment {
  txRef: string;
  amount: number;
  currency: string;
  paymentPlan: string | null;
  email: string;
  name: string;
  redirectUrl: string;
  meta: Record<string, unknown>;
  token: string;
  /** Set once the fake "customer" has paid or failed. */
  transactionId?: number;
  status?: string;
}

export interface FakeSubscription {
  id: number;
  plan: number;
  email: string;
  status: "active" | "cancelled";
  amount: number;
}

export interface FakeFlutterwave {
  baseUrl: string;
  secretKey: string;
  requests: RecordedRequest[];
  plans: FakePlan[];
  payments: FakePayment[];
  subscriptions: FakeSubscription[];
  /** Make the next `count` calls to `path` (prefix match) answer with `status`. */
  failNext(pathPrefix: string, status: number, count?: number): void;
  /** Forget all recorded requests, plans, payments, subscriptions and injected failures. */
  reset(): void;
  /** Simulate the customer finishing the hosted checkout. Returns the transaction. */
  completePayment(
    txRef: string,
    opts?: { status?: string; amount?: number; currency?: string; email?: string },
  ): { transactionId: number; payment: FakePayment };
  /** Simulate a recurring charge Flutterwave makes by itself under a subscription. */
  recurringCharge(
    subscriptionId: number,
    opts?: { status?: string; amount?: number; currency?: string },
  ): { transactionId: number; txRef: string };
  /** Calls made to one path prefix, in order. */
  callsTo(method: string, pathPrefix: string): RecordedRequest[];
  close(): Promise<void>;
}

export async function startFakeFlutterwave(secretKey = "FLWSECK_TEST-fake-secret-key"): Promise<FakeFlutterwave> {
  const requests: RecordedRequest[] = [];
  const plans: FakePlan[] = [];
  const payments: FakePayment[] = [];
  const subscriptions: FakeSubscription[] = [];
  const transactions = new Map<number, Record<string, unknown>>();
  const failures: Array<{ prefix: string; status: number; left: number }> = [];
  let nextPlanId = 40_001;
  let nextTxId = 900_001;
  let nextSubId = 7_001;
  let nextToken = 1;
  let baseUrl = "";

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const ok = (res: http.ServerResponse, data: unknown) => send(res, 200, { status: "success", message: "OK", data });
  const err = (res: http.ServerResponse, status: number, message: string) => send(res, status, { status: "error", message, data: null });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      // The base URL ends in /v3; the server mounts everything under it.
      const path = url.pathname.replace(/^\/v3/, "");
      let body: unknown = null;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      } catch {
        body = null;
      }
      const rec = { method: req.method ?? "GET", path: path + url.search, headers: req.headers, body };
      requests.push(rec);

      // The hosted page the customer would see; recorded but not authenticated.
      if (path.startsWith("/hosted/pay/")) return ok(res, { page: "hosted checkout" });

      if (req.headers.authorization !== `Bearer ${secretKey}`) return err(res, 401, "Invalid authorization key");

      const injected = failures.find((f) => path.startsWith(f.prefix) && f.left > 0);
      if (injected) {
        injected.left -= 1;
        return err(res, injected.status, `injected failure ${injected.status}`);
      }

      const b = (body ?? {}) as Record<string, any>;

      if (req.method === "POST" && path === "/payment-plans") {
        if (!b.name || typeof b.amount !== "number" || !b.interval) return err(res, 400, "name, amount and interval are required");
        const plan: FakePlan = { id: nextPlanId++, name: b.name, amount: b.amount, interval: b.interval, currency: b.currency ?? "NGN" };
        plans.push(plan);
        return ok(res, { ...plan, status: "active", plan_token: `rpp_${plan.id}`, created_at: new Date().toISOString() });
      }

      if (req.method === "POST" && path === "/payments") {
        const c = (b.customer ?? {}) as Record<string, string>;
        if (!b.tx_ref || !b.amount || !b.currency || !b.redirect_url || !c.email) {
          return err(res, 400, "tx_ref, amount, currency, redirect_url and customer.email are required");
        }
        if (payments.some((p) => p.txRef === b.tx_ref)) return err(res, 400, "tx_ref already used");
        let paymentPlan: string | null = null;
        if (b.payment_plan !== undefined && b.payment_plan !== null) {
          const plan = plans.find((p) => String(p.id) === String(b.payment_plan));
          if (!plan) return err(res, 400, "payment plan not found");
          // Real rule: the charge currency must match the plan currency.
          if (plan.currency !== b.currency) return err(res, 400, "currency does not match the payment plan currency");
          paymentPlan = String(plan.id);
        }
        const payment: FakePayment = {
          txRef: b.tx_ref,
          amount: b.amount,
          currency: b.currency,
          paymentPlan,
          email: c.email,
          name: c.name ?? "",
          redirectUrl: b.redirect_url,
          meta: (b.meta ?? {}) as Record<string, unknown>,
          token: `tok${nextToken++}`,
        };
        payments.push(payment);
        return ok(res, { link: `${baseUrl}/hosted/pay/${payment.token}` });
      }

      const verify = req.method === "GET" && path.match(/^\/transactions\/([^/]+)\/verify$/);
      if (verify) {
        const tx = transactions.get(Number(verify[1]));
        if (!tx) return err(res, 404, "No transaction was found for this id");
        return ok(res, tx);
      }

      if (req.method === "GET" && path === "/subscriptions") {
        const email = url.searchParams.get("email");
        const list = subscriptions
          .filter((s) => !email || s.email.toLowerCase() === email.toLowerCase())
          .map((s) => ({ id: s.id, amount: s.amount, customer: { id: 1, customer_email: s.email }, plan: s.plan, status: s.status, created_at: new Date().toISOString() }));
        return ok(res, list);
      }

      const cancel = req.method === "PUT" && path.match(/^\/subscriptions\/([^/]+)\/cancel$/);
      if (cancel) {
        const sub = subscriptions.find((s) => String(s.id) === cancel[1]);
        if (!sub) return err(res, 404, "Subscription not found");
        sub.status = "cancelled";
        return ok(res, { id: sub.id, amount: sub.amount, customer: { id: 1, customer_email: sub.email }, plan: sub.plan, status: "cancelled" });
      }

      return err(res, 404, `no such route: ${req.method} ${path}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const fake: FakeFlutterwave = {
    baseUrl: `${baseUrl}/v3`,
    secretKey,
    requests,
    plans,
    payments,
    subscriptions,
    failNext(pathPrefix, status, count = 1) {
      failures.push({ prefix: pathPrefix, status, left: count });
    },
    reset() {
      requests.length = 0;
      plans.length = 0;
      payments.length = 0;
      subscriptions.length = 0;
      failures.length = 0; // a failure injected by one test must never leak into the next
      transactions.clear();
    },
    completePayment(txRef, opts = {}) {
      const payment = payments.find((p) => p.txRef === txRef);
      if (!payment) throw new Error(`fake flutterwave: no payment with tx_ref ${txRef}`);
      const status = opts.status ?? "successful";
      const transactionId = nextTxId++;
      payment.transactionId = transactionId;
      payment.status = status;
      const amount = opts.amount ?? payment.amount;
      const currency = opts.currency ?? payment.currency;
      const email = opts.email ?? payment.email;
      transactions.set(transactionId, {
        id: transactionId,
        tx_ref: payment.txRef,
        flw_ref: `FLW-${transactionId}`,
        amount,
        charged_amount: amount,
        currency,
        status,
        payment_type: "card",
        customer: { id: 1, email, name: payment.name },
        meta: payment.meta,
        plan: payment.paymentPlan ? Number(payment.paymentPlan) : null,
      });
      if (status === "successful" && payment.paymentPlan) {
        subscriptions.push({ id: nextSubId++, plan: Number(payment.paymentPlan), email, status: "active", amount });
      }
      return { transactionId, payment };
    },
    recurringCharge(subscriptionId, opts = {}) {
      const sub = subscriptions.find((s) => s.id === subscriptionId);
      if (!sub) throw new Error(`fake flutterwave: no subscription ${subscriptionId}`);
      const plan = plans.find((p) => p.id === sub.plan)!;
      const transactionId = nextTxId++;
      const txRef = `RECUR-${transactionId}`;
      transactions.set(transactionId, {
        id: transactionId,
        tx_ref: txRef,
        flw_ref: `FLW-${transactionId}`,
        amount: opts.amount ?? plan.amount,
        charged_amount: opts.amount ?? plan.amount,
        currency: opts.currency ?? plan.currency,
        status: opts.status ?? "successful",
        payment_type: "card",
        customer: { id: 1, email: sub.email },
        meta: null,
        plan: sub.plan,
      });
      return { transactionId, txRef };
    },
    callsTo(method, pathPrefix) {
      return requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
  return fake;
}

/** The body Flutterwave posts to a webhook for a finished charge. */
export function chargeCompletedWebhook(args: {
  transactionId: number;
  txRef: string;
  status?: string;
  amount: number;
  currency: string;
  email: string;
}): Record<string, unknown> {
  return {
    event: "charge.completed",
    data: {
      id: args.transactionId,
      tx_ref: args.txRef,
      flw_ref: `FLW-${args.transactionId}`,
      amount: args.amount,
      currency: args.currency,
      charged_amount: args.amount,
      status: args.status ?? "successful",
      payment_type: "card",
      customer: { id: 1, email: args.email },
    },
  };
}
