/**
 * The trial clock and trial reminders: the 7 days restart once on the first real event (never
 * past 14 days from signup, never for the dashboard's sample event), and two reminder emails go
 * out at most once each: when the trial is about to end and after it has ended.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "trialclock-".
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { TransportAdapter, TransportSendParams, TransportSendResult } from "@loomail/adapters";
import { tenantTablesInDeleteOrder } from "@loomail/db/purge";
import { rebaseTrialOnFirstEvent, resetTrialRebaseCache, SAMPLE_EVENT_USER_ID } from "../src/onboarding/trial.js";
import { sweepTrialReminders } from "../src/onboarding/trial-reminders.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[trial-clock.test] DATABASE_URL is not set.");

class Outbox implements TransportAdapter {
  sent: TransportSendParams[] = [];
  mode: "ok" | "fail" = "ok";
  async send(p: TransportSendParams): Promise<TransportSendResult> {
    if (this.mode === "fail") return { success: false, error: "rejected", permanent: false };
    this.sent.push(p);
    return { success: true, providerMessageId: `m-${this.sent.length}` };
  }
}
const outbox = new Outbox();
const transport = { adapter: outbox, fromEmail: "no-reply@platform.example", fromName: "Loomail" };
const DAY = 86_400_000;
const NOW = new Date("2026-10-10T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString();

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let counter = 0;

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

/** A signup workspace: created `ageDays` ago, trial ending `endsInDays` from NOW. */
async function newTenant(o: { ageDays: number; endsInDays: number; plan?: string; suspended?: boolean }): Promise<{ id: string; email: string }> {
  const slug = `trialclock-${Date.now()}-${counter++}`;
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tenants (name, slug, plan, settings, trial_ends_at, created_at, suspended_at)
    VALUES (${"Acme"}, ${slug}, ${o.plan ?? "trial"}, ${JSON.stringify({ signup: { plan_interest: "essential" }, onboarding: {} })}::jsonb,
            ${days(o.endsInDays)}, ${days(-o.ageDays)}, ${o.suspended ? days(-1) : null})
    RETURNING id`);
  const email = `${slug}@trial.example`;
  await db.execute(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t!.id}::uuid, ${email}, 'owner')`);
  return { id: t!.id, email };
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'trialclock-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of await db.transaction(async (tx) => tenantTablesInDeleteOrder(tx as never))) {
      await db.execute(sql.raw(`DELETE FROM "${t}" WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

const trialEnd = async (id: string) =>
  new Date((await q<{ e: string }>(sql`SELECT trial_ends_at AS e FROM tenants WHERE id = ${id}::uuid`))[0]!.e).getTime();
const stored = async (id: string) =>
  (await q<{ o: Record<string, unknown> | null }>(sql`SELECT settings->'onboarding' AS o FROM tenants WHERE id = ${id}::uuid`))[0]!.o ?? {};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[trial-clock.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[trial-clock.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
});
beforeEach(() => {
  outbox.sent = [];
  outbox.mode = "ok";
  resetTrialRebaseCache();
});
afterEach(async () => {
  if (dbAvailable) await cleanup();
});
afterAll(async () => {
  await pool?.end();
});

describe("the trial clock restarts on the first real event", () => {
  it("gives a fresh 7 days from the event, when that is later than the current end", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ ageDays: 5, endsInDays: 2 });
    expect(await rebaseTrialOnFirstEvent(db as never, t.id, "user-1", NOW)).toBe(true);
    expect(await trialEnd(t.id)).toBe(new Date(days(7)).getTime());
    expect((await stored(t.id)).trial_rebased_at).toBeTruthy();
  });

  it("never runs past 14 days from signup", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ ageDays: 10, endsInDays: 1 });
    await rebaseTrialOnFirstEvent(db as never, t.id, "user-1", NOW);
    // signup was 10 days ago, so the cap is 4 days from now
    expect(await trialEnd(t.id)).toBe(new Date(days(4)).getTime());
  });

  it("happens once only", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ ageDays: 5, endsInDays: 2 });
    await rebaseTrialOnFirstEvent(db as never, t.id, "user-1", NOW);
    const first = await trialEnd(t.id);
    resetTrialRebaseCache();
    const later = new Date(NOW.getTime() + DAY);
    expect(await rebaseTrialOnFirstEvent(db as never, t.id, "user-2", later)).toBe(false);
    expect(await trialEnd(t.id)).toBe(first);
  });

  it("ignores the dashboard's sample event", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ ageDays: 5, endsInDays: 2 });
    expect(await rebaseTrialOnFirstEvent(db as never, t.id, SAMPLE_EVENT_USER_ID, NOW)).toBe(false);
    expect(await trialEnd(t.id)).toBe(new Date(days(2)).getTime());
  });

  it("does nothing for a paid workspace or a trial that already ended", async () => {
    if (!dbAvailable) return;
    const paid = await newTenant({ ageDays: 5, endsInDays: 2, plan: "essential" });
    expect(await rebaseTrialOnFirstEvent(db as never, paid.id, "u", NOW)).toBe(false);
    const ended = await newTenant({ ageDays: 9, endsInDays: -1 });
    expect(await rebaseTrialOnFirstEvent(db as never, ended.id, "u", NOW)).toBe(false);
    expect(await trialEnd(ended.id)).toBe(new Date(days(-1)).getTime());
  });
});

describe("trial reminders", () => {
  const sweep = () => sweepTrialReminders(db as never, { dashboardUrl: "https://app.example.com", transport, now: NOW });
  // Other test files share this database, so only look at the workspaces created here.
  const mine = () => outbox.sent.filter((m) => m.to.includes("trialclock-"));

  it("sends the 'ending' email when 2 days or fewer remain, once", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ ageDays: 5, endsInDays: 1.5 });
    const far = await newTenant({ ageDays: 1, endsInDays: 6 });
    await sweep();
    expect(mine()).toHaveLength(1);
    expect(mine()[0]!.to).toBe(t.email);
    expect(mine()[0]!.subject).toMatch(/trial ends in/i);
    expect(mine()[0]!.bodyText).toContain("https://app.example.com/settings/plan");
    expect(mine().some((m) => m.to === far.email)).toBe(false);
    // A second sweep adds nothing.
    await sweep();
    expect(mine()).toHaveLength(1);
  });

  it("sends the 'ended' email within 3 days after the end, once, and says the data is safe", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ ageDays: 9, endsInDays: -1 });
    const long = await newTenant({ ageDays: 20, endsInDays: -10 });
    await sweep();
    expect(mine()).toHaveLength(1);
    expect(mine()[0]!.to).toBe(t.email);
    expect(mine()[0]!.subject).toMatch(/trial has ended/i);
    expect(mine()[0]!.bodyText).toMatch(/safe/i);
    expect(mine().some((m) => m.to === long.email)).toBe(false);
    await sweep();
    expect(mine()).toHaveLength(1);
  });

  it("leaves paid, suspended and non-signup workspaces alone", async () => {
    if (!dbAvailable) return;
    await newTenant({ ageDays: 5, endsInDays: 1, plan: "essential" });
    await newTenant({ ageDays: 5, endsInDays: 1, suspended: true });
    const noSignup = await newTenant({ ageDays: 5, endsInDays: 1 });
    await db.execute(sql`UPDATE tenants SET settings = settings - 'signup' WHERE id = ${noSignup.id}::uuid`);
    await sweep();
    // Other test files share this database, so only look at the workspaces created here.
    expect(outbox.sent.filter((m) => m.to.includes("trialclock-"))).toHaveLength(0);
  });

  it("puts the claim back when delivery fails, so the next sweep tries again", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ ageDays: 5, endsInDays: 1 });
    outbox.mode = "fail";
    await sweep();
    expect((await stored(t.id)).trial_ending_sent_at).toBeUndefined();
    outbox.mode = "ok";
    await sweep();
    expect(mine().filter((m) => m.to === t.email)).toHaveLength(1);
  });
});
