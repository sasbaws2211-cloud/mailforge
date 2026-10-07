/**
 * The polling that notices a payment has finished, and what the page says at each stage of an
 * in-page payment. Pure functions with an injected clock: no network, no browser.
 */
import { describe, it, expect } from "vitest";
import { pollCheckoutUntilDone } from "../src/paystack-popup.js";
import { checkoutPhaseNotice, CLOSE_GRACE_MS, type CheckoutPhase } from "../src/plan.js";

/** A clock the test controls: sleeping just moves time forward. */
function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("pollCheckoutUntilDone", () => {
  it("returns as soon as the server says paid, and stops asking", async () => {
    const c = clock();
    const answers = ["pending", "pending", "paid", "pending"];
    let calls = 0;
    const out = await pollCheckoutUntilDone(async () => ({ status: answers[calls++]! }), { sleep: c.sleep, now: c.now, intervalMs: 2500 });
    expect(out).toBe("paid");
    expect(calls).toBe(3);
    expect(c.sleeps).toEqual([2500, 2500]);
  });

  it("passes failed and cancelled through as final answers", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const c = clock();
      expect(await pollCheckoutUntilDone(async () => ({ status }), { sleep: c.sleep, now: c.now })).toBe(status);
    }
  });

  it("checks right away, before the first wait", async () => {
    const c = clock();
    await pollCheckoutUntilDone(async () => ({ status: "paid" }), { sleep: c.sleep, now: c.now });
    expect(c.sleeps).toEqual([]);
  });

  it("treats a failed request as 'not yet', not as a verdict, and carries on", async () => {
    const c = clock();
    let calls = 0;
    const out = await pollCheckoutUntilDone(
      async () => {
        calls += 1;
        if (calls <= 3) throw new Error("network down");
        return { status: "paid" };
      },
      { sleep: c.sleep, now: c.now },
    );
    expect(out).toBe("paid");
    expect(calls).toBe(4);
  });

  it("an unknown status word keeps waiting rather than ending", async () => {
    const c = clock();
    const answers = ["weird", "processing", "paid"];
    let calls = 0;
    expect(await pollCheckoutUntilDone(async () => ({ status: answers[calls++]! }), { sleep: c.sleep, now: c.now })).toBe("paid");
  });

  it("gives up with 'timeout' after the time limit, never looping forever", async () => {
    const c = clock();
    let calls = 0;
    const out = await pollCheckoutUntilDone(async () => (calls++, { status: "pending" }), { sleep: c.sleep, now: c.now, intervalMs: 1000, timeoutMs: 5000 });
    expect(out).toBe("timeout");
    expect(calls).toBeGreaterThanOrEqual(5);
    expect(calls).toBeLessThanOrEqual(7);
  });

  it("a request that keeps failing still ends at the time limit", async () => {
    const c = clock();
    const out = await pollCheckoutUntilDone(async () => Promise.reject(new Error("down")), { sleep: c.sleep, now: c.now, intervalMs: 1000, timeoutMs: 3000 });
    expect(out).toBe("timeout");
  });

  it("stops when told to, without another request", async () => {
    const c = clock();
    let calls = 0;
    let stop = false;
    const out = await pollCheckoutUntilDone(
      async () => {
        calls += 1;
        if (calls === 2) stop = true;
        return { status: "pending" };
      },
      { sleep: c.sleep, now: c.now, shouldStop: () => stop },
    );
    expect(out).toBe("stopped");
    expect(calls).toBe(2);
  });

  it("stopping is checked before the very first request", async () => {
    let calls = 0;
    const out = await pollCheckoutUntilDone(async () => (calls++, { status: "paid" }), { shouldStop: () => true });
    expect(out).toBe("stopped");
    expect(calls).toBe(0);
  });

  it("a payment confirmed inside the grace period after the popup closes is still seen", async () => {
    // Models the page: the customer closes the popup at t=1000, the payment landed a moment before,
    // and the next check (t=2500) finds it. Stopping only applies once the grace has passed.
    const c = clock();
    let closedAt: number | null = null;
    let calls = 0;
    const out = await pollCheckoutUntilDone(
      async () => {
        calls += 1;
        if (calls === 1) closedAt = c.now();
        return { status: calls >= 2 ? "paid" : "pending" };
      },
      { sleep: c.sleep, now: c.now, intervalMs: 2500, shouldStop: () => closedAt !== null && c.now() - closedAt > CLOSE_GRACE_MS },
    );
    expect(out).toBe("paid");
  });

  it("with nothing arriving after the popup closes it stops once the grace period is over", async () => {
    const c = clock();
    let closedAt: number | null = null;
    let calls = 0;
    const out = await pollCheckoutUntilDone(
      async () => {
        calls += 1;
        if (calls === 1) closedAt = c.now();
        return { status: "pending" };
      },
      { sleep: c.sleep, now: c.now, intervalMs: 2500, shouldStop: () => closedAt !== null && c.now() - closedAt > CLOSE_GRACE_MS },
    );
    expect(out).toBe("stopped");
    expect(c.now()).toBeGreaterThan(CLOSE_GRACE_MS);
    expect(c.now()).toBeLessThanOrEqual(CLOSE_GRACE_MS + 2500);
  });
});

describe("checkoutPhaseNotice", () => {
  it("says nothing before and while setting up", () => {
    expect(checkoutPhaseNotice("idle")).toBeNull();
    expect(checkoutPhaseNotice("starting")).toBeNull();
  });

  it("tells the customer what to do while the popup is open", () => {
    const n = checkoutPhaseNotice("popup")!;
    expect(n.tone).toBe("info");
    expect(n.message).toMatch(/Paystack window/);
    expect(n.message).toMatch(/updates by itself/);
  });

  it("confirms a paid plan, warns on a failure, and explains a closed popup and a long wait", () => {
    expect(checkoutPhaseNotice("paid")).toMatchObject({ tone: "success", message: expect.stringContaining("Your plan is active") });
    expect(checkoutPhaseNotice("failed")).toMatchObject({ tone: "warning", message: expect.stringContaining("have not been charged") });
    expect(checkoutPhaseNotice("closed")).toMatchObject({ tone: "info", message: expect.stringContaining("Nothing was charged") });
    expect(checkoutPhaseNotice("timeout")).toMatchObject({ tone: "info", message: expect.stringContaining("confirming your payment") });
  });

  it("covers every phase", () => {
    const phases: CheckoutPhase[] = ["idle", "starting", "popup", "paid", "failed", "closed", "timeout"];
    for (const p of phases) expect(() => checkoutPhaseNotice(p)).not.toThrow();
  });
});
