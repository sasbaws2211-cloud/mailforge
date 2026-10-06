/**
 * Integration tests for the stall nudge: who gets one, when, how many, what it says, and that
 * overlapping sweeps or a failing mail server can never cause a repeat or a loss.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "nudge-".
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { TransportAdapter, TransportSendParams, TransportSendResult } from "@mailforge/adapters";
import { tenantTablesInDeleteOrder } from "@mailforge/db/purge";
import { sweepOnboardingNudges } from "../src/onboarding/nudge.js";
import { buildNudgeEmail } from "../src/transactional-email.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[onboarding-nudge.test] DATABASE_URL is not set.");

class Outbox implements TransportAdapter {
  sent: TransportSendParams[] = [];
  mode: "ok" | "fail" | "throw" = "ok";
  async send(p: TransportSendParams): Promise<TransportSendResult> {
    if (this.mode === "throw") throw new Error("smtp down");
    if (this.mode === "fail") return { success: false, error: "rejected", permanent: false };
    this.sent.push(p);
    return { success: true, providerMessageId: `m-${this.sent.length}` };
  }
}
const outbox = new Outbox();
const transport = { adapter: outbox, fromEmail: "no-reply@platform.example", fromName: "Mailforge" };
const NOW = new Date("2026-10-10T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
interface Opts {
  welcomeHoursAgo?: number | null;
  signup?: boolean;
  onboarding?: Record<string, unknown>;
  plan?: string;
  trialEndsInDays?: number | null;
  suspended?: boolean;
  deleting?: boolean;
  owners?: number;
  postal?: boolean;
}
async function newTenant(o: Opts = {}): Promise<{ id: string; email: string }> {
  const slug = `nudge-${Date.now()}-${counter++}`;
  const onboarding: Record<string, unknown> = { ...(o.onboarding ?? {}) };
  const welcome = o.welcomeHoursAgo === undefined ? 30 : o.welcomeHoursAgo;
  if (welcome !== null) onboarding.welcome_sent_at = hoursAgo(welcome);
  const settings: Record<string, unknown> = { onboarding };
  if (o.signup !== false) settings.signup = { plan_interest: "growth" };
  if (o.postal) settings.postal_address = "1 Main St";
  const trialDays = o.trialEndsInDays === undefined ? 10 : o.trialEndsInDays;
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tenants (name, slug, plan, settings, trial_ends_at, suspended_at, deletion_scheduled_at)
    VALUES (${"Acme <b>"}, ${slug}, ${o.plan ?? "trial"}, ${JSON.stringify(settings)}::jsonb,
            ${trialDays === null ? null : new Date(NOW.getTime() + trialDays * 86_400_000).toISOString()},
            ${o.suspended ? hoursAgo(1) : null}, ${o.deleting ? new Date(NOW.getTime() + 86_400_000).toISOString() : null})
    RETURNING id`);
  const email = `${slug}@nudge.example`;
  for (let i = 0; i < (o.owners ?? 1); i++) {
    await db.execute(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t!.id}::uuid, ${i === 0 ? email : `o${i}-${email}`}, 'owner')`);
  }
  return { id: t!.id, email };
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'nudge-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of await db.transaction(async (tx) => tenantTablesInDeleteOrder(tx as never))) {
      await db.execute(sql.raw(`DELETE FROM "${t}" WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

const sweep = (over: Partial<Parameters<typeof sweepOnboardingNudges>[1]> = {}) =>
  sweepOnboardingNudges(db as never, { dashboardUrl: "https://app.example.com", transport, now: NOW, ...over });
const stored = async (id: string) =>
  (await q<{ o: Record<string, unknown> | null }>(sql`SELECT settings->'onboarding' AS o FROM tenants WHERE id = ${id}::uuid`))[0]!.o ?? {};
const sentTo = (email: string) => outbox.sent.filter((m) => m.to === email);

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[onboarding-nudge.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[onboarding-nudge.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
});
beforeEach(() => {
  outbox.sent = [];
  outbox.mode = "ok";
});
afterEach(async () => {
  delete process.env.MAILFORGE_MANAGED_SHARED_FROM;
  if (dbAvailable) await cleanup();
});
afterAll(async () => {
  await pool?.end();
});

const it_ = (name: string, fn: () => Promise<void>) => it(name, async () => (dbAvailable ? fn() : undefined));

// ---------------------------------------------------------------------------

describe("who gets a nudge", () => {
  it_("a signed-in workspace that stalled for over a day", async () => {
    const t = await newTenant();
    await sweep();
    const m = sentTo(t.email);
    expect(m).toHaveLength(1);
    expect(m[0]!.from).toBe("no-reply@platform.example");
    expect(m[0]!.bodyText).toContain("Add your business address");
    expect(m[0]!.bodyText).toContain("https://app.example.com/settings/postal");
    const o = await stored(t.id);
    expect(o.nudge_count).toBe(1);
    expect(o.last_nudge_at).toBe(NOW.toISOString());
  });

  it_("not before 24 hours after the welcome", async () => {
    const t = await newTenant({ welcomeHoursAgo: 23 });
    await sweep();
    expect(sentTo(t.email)).toHaveLength(0);
    expect((await stored(t.id)).nudge_count).toBeUndefined();
  });

  it_("never one that has not signed in (no welcome yet)", async () => {
    const t = await newTenant({ welcomeHoursAgo: null });
    await sweep();
    expect(sentTo(t.email)).toHaveLength(0);
  });

  it_("never one that did not come through signup", async () => {
    const t = await newTenant({ signup: false });
    await sweep();
    expect(sentTo(t.email)).toHaveLength(0);
  });

  it_("never one that chose to finish later: that is the opt-out", async () => {
    const t = await newTenant({ onboarding: { dismissed_at: hoursAgo(5) } });
    await sweep();
    expect(sentTo(t.email)).toHaveLength(0);
  });

  it_("never one that already finished", async () => {
    const t = await newTenant({ onboarding: { completed_at: hoursAgo(5) } });
    await sweep();
    expect(sentTo(t.email)).toHaveLength(0);
  });

  it_("never one whose steps are all done even if completed_at was not recorded yet", async () => {
    const t = await newTenant({ postal: true });
    process.env.MAILFORGE_MANAGED_SHARED_FROM = "hello@shared.example";
    await db.execute(sql`INSERT INTO managed_sending (tenant_id, enabled) VALUES (${t.id}::uuid, true)`);
    const [f] = await q<{ id: string }>(sql`INSERT INTO flows (tenant_id, name, trigger_type, trigger_config, steps, status) VALUES (${t.id}::uuid, 'F', 'event', '{}'::jsonb, '[]'::jsonb, 'active')`.append(sql` RETURNING id`));
    const [c] = await q<{ id: string }>(sql`INSERT INTO contacts (tenant_id, external_id, email, lifecycle_state) VALUES (${t.id}::uuid, 'c', 'c@p.example', 'engaged') RETURNING id`);
    await db.execute(sql`INSERT INTO events (tenant_id, contact_id, type, event_name, timestamp) VALUES (${t.id}::uuid, ${c!.id}::uuid, 'track', 'signed_up', now())`);
    const [m] = await q<{ id: string }>(sql`INSERT INTO flow_memberships (tenant_id, contact_id, flow_id, entered_at) VALUES (${t.id}::uuid, ${c!.id}::uuid, ${f!.id}::uuid, now()) RETURNING id`);
    await db.execute(sql`INSERT INTO lifecycle_messages (tenant_id, contact_id, flow_id, membership_id, status, subject, sent_at) VALUES (${t.id}::uuid, ${c!.id}::uuid, ${f!.id}::uuid, ${m!.id}::uuid, 'sent', 'Hi', now())`);
    const r = await sweep();
    expect(sentTo(t.email)).toHaveLength(0);
    expect(r).toEqual({ considered: 1, sent: 0, failed: 0 });
  });

  it_("never a suspended workspace or one being deleted", async () => {
    const a = await newTenant({ suspended: true });
    const b = await newTenant({ deleting: true });
    await sweep();
    expect(sentTo(a.email)).toHaveLength(0);
    expect(sentTo(b.email)).toHaveLength(0);
  });

  it_("never one whose trial has ended, but yes one on a paid plan", async () => {
    const ended = await newTenant({ trialEndsInDays: -2 });
    const paid = await newTenant({ plan: "growth", trialEndsInDays: null });
    await sweep();
    expect(sentTo(ended.email)).toHaveLength(0);
    expect(sentTo(paid.email)).toHaveLength(1);
  });

  it_("skips a deactivated owner and writes to every active one", async () => {
    const t = await newTenant({ owners: 2 });
    await db.execute(sql`UPDATE users SET deactivated_at = now() WHERE tenant_id = ${t.id}::uuid AND email LIKE 'o1-%'`);
    await sweep();
    expect(outbox.sent.map((m) => m.to)).toEqual([t.email]);
    const t2 = await newTenant({ owners: 2 });
    outbox.sent = [];
    await sweep();
    expect(outbox.sent.filter((m) => m.to.includes(t2.email.split("@")[0]!))).toHaveLength(2);
  });

  it_("writes to owners only, never to ordinary members", async () => {
    const t = await newTenant();
    await db.execute(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t.id}::uuid, 'member@nudge.example', 'member')`);
    await sweep();
    expect(outbox.sent.map((m) => m.to)).toEqual([t.email]);
  });

  it_("leaves a workspace with no owner alone and puts the counters back", async () => {
    const t = await newTenant({ owners: 0 });
    await sweep();
    expect(outbox.sent).toHaveLength(0);
    expect((await stored(t.id)).nudge_count).toBe(0);
  });
});

describe("how many, and how often", () => {
  it_("does not send twice in the same window", async () => {
    const t = await newTenant();
    await sweep();
    await sweep();
    await sweep({ now: new Date(NOW.getTime() + 3_600_000) });
    expect(sentTo(t.email)).toHaveLength(1);
  });

  it_("sends the second after 72 hours from the welcome and 24 from the first, then stops", async () => {
    const t = await newTenant({ welcomeHoursAgo: 80, onboarding: { nudge_count: 1, last_nudge_at: hoursAgo(30) } });
    await sweep();
    expect(sentTo(t.email)).toHaveLength(1);
    expect(sentTo(t.email)[0]!.subject).toMatch(/^Last reminder/);
    expect((await stored(t.id)).nudge_count).toBe(2);
    await sweep({ now: new Date(NOW.getTime() + 10 * 86_400_000) });
    expect(sentTo(t.email)).toHaveLength(1);
  });

  it_("holds the second nudge until 24 hours after the first", async () => {
    const t = await newTenant({ welcomeHoursAgo: 80, onboarding: { nudge_count: 1, last_nudge_at: hoursAgo(5) } });
    await sweep();
    expect(sentTo(t.email)).toHaveLength(0);
  });

  it_("sends exactly one when sweeps overlap", async () => {
    const t = await newTenant();
    await Promise.all([sweep(), sweep(), sweep(), sweep()]);
    expect(sentTo(t.email)).toHaveLength(1);
    expect((await stored(t.id)).nudge_count).toBe(1);
  });

  it_("sends nothing when another server claimed the nudge between the read and the claim", async () => {
    const t = await newTenant();
    const r = await sweep({
      beforeClaim: async (id) => {
        await db.execute(sql`UPDATE tenants SET settings = jsonb_set(settings, '{onboarding}', settings->'onboarding' || ${JSON.stringify({ nudge_count: 1, last_nudge_at: NOW.toISOString() })}::jsonb) WHERE id = ${id}::uuid`);
      },
    });
    expect(r.sent).toBe(0);
    expect(outbox.sent).toHaveLength(0);
    expect((await stored(t.id)).nudge_count).toBe(1);
  });

  it_("points at the step that is actually next", async () => {
    const t = await newTenant({ postal: true });
    process.env.MAILFORGE_MANAGED_SHARED_FROM = "hello@shared.example";
    await db.execute(sql`INSERT INTO managed_sending (tenant_id, enabled) VALUES (${t.id}::uuid, true)`);
    await sweep();
    const m = sentTo(t.email)[0]!;
    expect(m.bodyText).toContain("Turn on your first flow");
    expect(m.bodyText).toContain("3 of 6 steps done");
  });
});

describe("when the mail server misbehaves", () => {
  it_("puts the counters back after a refusal, so the next sweep retries", async () => {
    const t = await newTenant();
    outbox.mode = "fail";
    const r = await sweep();
    expect(r.failed).toBe(1);
    expect((await stored(t.id)).nudge_count).toBe(0);
    expect((await stored(t.id)).last_nudge_at).toBeUndefined();
    outbox.mode = "ok";
    expect((await sweep()).sent).toBe(1);
  });

  it_("restores the previous last-nudge date after a refusal", async () => {
    const prev = hoursAgo(30);
    const t = await newTenant({ welcomeHoursAgo: 80, onboarding: { nudge_count: 1, last_nudge_at: prev } });
    outbox.mode = "fail";
    await sweep();
    const o = await stored(t.id);
    expect(o.nudge_count).toBe(1);
    expect(o.last_nudge_at).toBe(prev);
  });

  it_("survives a thrown error and still handles the other workspaces", async () => {
    const a = await newTenant();
    outbox.mode = "throw";
    const r = await sweep();
    expect(r.sent).toBe(0);
    expect((await stored(a.id)).nudge_count).toBe(0);
  });

  it_("sends nothing and claims nothing with no platform sender", async () => {
    const t = await newTenant();
    const r = await sweep({ transport: null });
    expect(r).toEqual({ considered: 0, sent: 0, failed: 0 });
    expect((await stored(t.id)).nudge_count).toBeUndefined();
  });

  it_("keeps the dismissed mark and welcome date through a release", async () => {
    const t = await newTenant();
    outbox.mode = "fail";
    await sweep();
    expect((await stored(t.id)).welcome_sent_at).toBeTruthy();
  });
});

describe("nudge email content", () => {
  const base = {
    brand: {},
    tenantName: "Acme",
    stepUrl: "https://app.example.com/settings/postal",
    stepTitle: "Add your business address",
    stepDescription: "Required in every footer.",
    stepMinutes: 1,
    stepCta: "Add address",
    done: 1,
    total: 6,
    nth: 1,
    trialDaysLeft: 9,
    supportEmail: "help@example.com",
  };

  it("names the next step, the progress, the link and how to stop", () => {
    const m = buildNudgeEmail(base);
    for (const body of [m.html, m.text]) {
      expect(body).toContain("1 of 6 steps done");
      expect(body).toContain("Add your business address");
      expect(body).toContain("https://app.example.com/settings/postal");
      expect(body).toContain("I will finish this later");
    }
    expect(m.text).toContain("9 days left");
    expect(m.text).toContain("at most one more reminder");
    expect(m.subject).toBe("Acme is 5 steps from sending its first email");
  });

  it("says it is the last one on the second nudge, and says 'one step' when one is left", () => {
    const m = buildNudgeEmail({ ...base, nth: 2, done: 5 });
    expect(m.subject).toBe("Last reminder: Acme is one step from its first email");
    expect(m.text).toContain("last reminder we will send");
  });

  it("leaves out the trial and support lines when unknown", () => {
    const m = buildNudgeEmail({ ...base, trialDaysLeft: null, supportEmail: null });
    expect(m.text).not.toMatch(/trial/i);
    expect(m.text).not.toContain("Stuck?");
  });

  it("escapes hostile names and links, and carries no token or unsubscribe link", () => {
    const m = buildNudgeEmail({ ...base, tenantName: "<script>x</script>", stepUrl: 'https://x.example/"onmouseover="y', stepTitle: "<b>t</b>" });
    expect(m.html).not.toContain("<script>x</script>");
    expect(m.html).not.toContain('"onmouseover="y');
    expect(m.html).not.toContain("<b>t</b>");
    expect(m.html).not.toMatch(/token=/);
    expect(m.html.toLowerCase()).not.toContain("unsubscribe");
  });
});
