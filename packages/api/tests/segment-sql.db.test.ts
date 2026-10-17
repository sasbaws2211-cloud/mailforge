/**
 * Segments to SQL, proved against the in-memory audience check.
 *
 * core's audience.ts already says, in memory, whether a contact matches a payment status, plan, trait and so on.
 * The segment compiler (drizzle/segments) says the same thing as SQL, so a segment's members can be found by the
 * database instead of by loading every contact. The two must agree, including on awkward data: missing fields,
 * numbers stored as text, mixed case, empty strings. This test builds such contacts, builds many definitions,
 * works out the members in memory, and requires the database to return exactly the same set.
 *
 * Requires local Postgres (see flows.db.test.ts for DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { tenants, contacts, events } from "@loomail/db/schema";
import { compileSegment, compileSegmentLeaf } from "@loomail/db/segments";
import {
  audienceConditionHolds,
  segmentDefinitionSchema,
  isSegmentGroup,
  type SegmentDefinition,
  type SegmentLeaf,
} from "@loomail/core";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[segment-sql.test] DATABASE_URL is not set (see flows.db.test.ts).");

const SLUG = "test-segment-sql";
const SLUG_OTHER = "test-segment-sql-other";
const DAY = 86_400_000;

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let tenantId: string;
let otherTenantId: string;
const NOW = Date.now();

interface Row {
  id: string;
  lifecycleState: string;
  paymentStatus: string | null;
  engagementDepth: string | null;
  email: string | null;
  properties: unknown;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
}
let rows: Row[] = [];
/** contact id -> event name -> ages in days (always half a day off any whole-day threshold) */
const eventAges = new Map<string, Map<string, number[]>>();

async function cleanup() {
  for (const table of ["events", "contacts"]) {
    await db.execute(sql.raw(`DELETE FROM ${table} WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ('${SLUG}', '${SLUG_OTHER}'))`));
  }
  await db.execute(sql.raw(`DELETE FROM tenants WHERE slug IN ('${SLUG}', '${SLUG_OTHER}')`));
}

// Awkward values on purpose.
const PAYMENT = [null, "free", "trial", "paid", "past_due", "cancelled"];
const DEPTH = [null, "power", "regular", "casual", "minimal"];
const STATES = ["signed_up", "activated", "engaged", "at_risk", "dormant", "churned", "resurrected"];
// Emails are unique per workspace, so each contact gets its own: none, blank (a different number of spaces each, and one
// truly empty), or a real address.
const emailFor = (n: number, owner: string): string | null => {
  const kind = (n * 3) % 5;
  if (kind === 0) return null;
  if (kind === 1) return n === 1 ? "" : " ".repeat(n + 1);
  return `${owner.slice(0, 8)}-${n}@example.com`;
};
const PLANS: unknown[] = ["Pro", " pro ", "PRO", "Growth", 5, null, "", "   ", undefined];
const SEATS: unknown[] = [12, "12", " 12 ", "abc", "", null, 3.5, "3.5", 50, -4, undefined, true];
const COUNTRY: unknown[] = ["Ghana", "ghana", " GHANA ", "Kenya", "", null, undefined, 7];
const TAGS: unknown[] = [["vip", "Early"], ["VIP"], [], ["early", 5, null, { a: 1 }], "vip,early", "Early bird", null, undefined, 42];
const BETA: unknown[] = [true, false, "true", "TRUE", " false ", "no", null, undefined, 1];
const AGES = [0.5, 2.5, 5.5, 9.5, 13.5, 20.5, 40.5, 100.5, 400.5];

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch {
    console.warn("[segment-sql.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  const [t] = await db.insert(tenants).values({ name: "Segment SQL", slug: SLUG, plan: "free" }).returning({ id: tenants.id });
  const [o] = await db.insert(tenants).values({ name: "Segment SQL other", slug: SLUG_OTHER, plan: "free" }).returning({ id: tenants.id });
  tenantId = t!.id;
  otherTenantId = o!.id;

  const build = (n: number, owner: string, ext: string) => {
    const properties: Record<string, unknown> | null = (() => {
      if (n % 17 === 0) return null;
      const p: Record<string, unknown> = {};
      const add = (k: string, v: unknown) => {
        if (v !== undefined) p[k] = v;
      };
      add("plan", PLANS[n % PLANS.length]);
      add("seats", SEATS[(n * 3) % SEATS.length]);
      add("country", COUNTRY[(n * 5) % COUNTRY.length]);
      add("tags", TAGS[(n * 7) % TAGS.length]);
      add("beta", BETA[(n * 11) % BETA.length]);
      add("note", n % 4 === 0 ? "Loves the API" : n % 4 === 1 ? 12345 : null);
      return p;
    })();
    return {
      tenantId: owner,
      externalId: `${ext}-${n}`,
      lifecycleState: STATES[n % STATES.length]!,
      paymentStatus: PAYMENT[n % PAYMENT.length]!,
      engagementDepth: DEPTH[(n * 2) % DEPTH.length]!,
      email: emailFor(n, owner),
      properties,
      firstSeenAt: n % 23 === 0 ? null : new Date(NOW - AGES[(n * 2) % AGES.length]! * DAY),
      lastSeenAt: n % 29 === 0 ? null : new Date(NOW - AGES[(n * 5) % AGES.length]! * DAY),
    };
  };

  const values = Array.from({ length: 360 }, (_, n) => build(n, tenantId, "c"));
  const inserted = await db.insert(contacts).values(values).returning({ id: contacts.id, externalId: contacts.externalId });
  const idByExt = new Map(inserted.map((r) => [r.externalId, r.id]));
  rows = values.map((v) => ({
    id: idByExt.get(v.externalId)!,
    lifecycleState: v.lifecycleState,
    paymentStatus: v.paymentStatus,
    engagementDepth: v.engagementDepth,
    email: v.email,
    properties: v.properties,
    firstSeenAt: v.firstSeenAt,
    lastSeenAt: v.lastSeenAt,
  }));

  // Another workspace with contacts that match everything: they must never appear.
  await db.insert(contacts).values(Array.from({ length: 30 }, (_, n) => build(n, otherTenantId, "o")));

  // Events: logins (0-4 of them at various ages), exports, and an event of another contact's name.
  const eventValues: Array<typeof events.$inferInsert> = [];
  rows.forEach((r, n) => {
    const per = new Map<string, number[]>();
    const add = (name: string, age: number) => {
      per.set(name, [...(per.get(name) ?? []), age]);
      eventValues.push({ tenantId, contactId: r.id, type: "track", eventName: name, timestamp: new Date(NOW - age * DAY) });
    };
    for (let i = 0; i < n % 5; i++) add("login", AGES[(n + i * 3) % 6]!); // 0..4 logins, within the last ~20 days
    if (n % 6 === 0) add("exported", AGES[(n % 4) + 1]!);
    if (n % 9 === 0) add("signed_up", 40.5);
    eventAges.set(r.id, per);
  });
  for (let i = 0; i < eventValues.length; i += 500) await db.insert(events).values(eventValues.slice(i, i + 500));
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
});

// ---------------------------------------------------------------------------
// The oracle: what each check means, worked out in memory
// ---------------------------------------------------------------------------

function holds(rule: SegmentLeaf, r: Row): boolean {
  switch (rule.field) {
    case "lifecycle_state":
      return rule.op === "in" ? rule.value.includes(r.lifecycleState as never) : rule.op === "is" ? r.lifecycleState === rule.value : r.lifecycleState !== rule.value;
    case "first_seen":
    case "last_seen": {
      const at = rule.field === "first_seen" ? r.firstSeenAt : r.lastSeenAt;
      if (at === null) return false;
      const ageDays = (NOW - at.getTime()) / DAY;
      return rule.op === "within_days" ? ageDays <= rule.days : ageDays > rule.days;
    }
    case "event": {
      const ages = (eventAges.get(r.id)?.get(rule.name) ?? []).filter((a) => a <= rule.within_days);
      return rule.op === "performed" ? ages.length >= (rule.min_count ?? 1) : ages.length === 0;
    }
    default:
      return audienceConditionHolds(rule, r);
  }
}

function inMemory(def: SegmentDefinition): Set<string> {
  const members = new Set<string>();
  for (const r of rows) {
    const verdicts = def.rules.map((rule) =>
      isSegmentGroup(rule)
        ? rule.match === "all"
          ? rule.rules.every((l) => holds(l, r))
          : rule.rules.some((l) => holds(l, r))
        : holds(rule, r),
    );
    if (def.match === "all" ? verdicts.every(Boolean) : verdicts.some(Boolean)) members.add(r.id);
  }
  return members;
}

async function inDatabase(def: SegmentDefinition): Promise<Set<string>> {
  const result = await db.execute<{ id: string }>(
    sql`SELECT contacts.id FROM contacts WHERE contacts.tenant_id = ${tenantId} AND ${compileSegment(def)}`,
  );
  return new Set(result.rows.map((r) => r.id));
}

const single = (rule: unknown): SegmentDefinition => segmentDefinitionSchema.parse({ match: "all", rules: [rule] });

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const leaves: Array<[string, unknown]> = [
  ["payment is paid", { field: "payment_status", op: "is", value: "paid" }],
  ["payment is not paid", { field: "payment_status", op: "is_not", value: "paid" }],
  ["payment in trial/paid", { field: "payment_status", op: "in", value: ["trial", "paid"] }],
  ["engagement is power", { field: "engagement_depth", op: "is", value: "power" }],
  ["engagement is not casual", { field: "engagement_depth", op: "is_not", value: "casual" }],
  ["engagement in power/regular", { field: "engagement_depth", op: "in", value: ["power", "regular"] }],
  ["plan is Pro", { field: "plan", op: "is", value: "Pro" }],
  ["plan is pro (case)", { field: "plan", op: "is", value: "pro" }],
  ["plan is not Pro", { field: "plan", op: "is_not", value: "Pro" }],
  ["plan is 5", { field: "plan", op: "is", value: "5" }],
  ["has email", { field: "has_email", op: "is", value: true }],
  ["has no email", { field: "has_email", op: "is", value: false }],
  ["country is Ghana", { field: "trait", key: "country", op: "is", value: "Ghana" }],
  ["country is not Ghana", { field: "trait", key: "country", op: "is_not", value: "Ghana" }],
  ["country is 7", { field: "trait", key: "country", op: "is", value: 7 }],
  ["seats is 12", { field: "trait", key: "seats", op: "is", value: 12 }],
  ["seats is 3.5", { field: "trait", key: "seats", op: "is", value: 3.5 }],
  ["seats is not 12", { field: "trait", key: "seats", op: "is_not", value: 12 }],
  ["seats is the text 12", { field: "trait", key: "seats", op: "is", value: "12" }],
  ["seats > 10", { field: "trait", key: "seats", op: "gt", value: 10 }],
  ["seats < 10", { field: "trait", key: "seats", op: "lt", value: 10 }],
  ["seats > -5", { field: "trait", key: "seats", op: "gt", value: -5 }],
  ["beta is true", { field: "trait", key: "beta", op: "is", value: true }],
  ["beta is false", { field: "trait", key: "beta", op: "is", value: false }],
  ["beta is not true", { field: "trait", key: "beta", op: "is_not", value: true }],
  ["tags contains vip", { field: "trait", key: "tags", op: "contains", value: "vip" }],
  ["tags contains EARLY", { field: "trait", key: "tags", op: "contains", value: "EARLY" }],
  ["tags contains ear", { field: "trait", key: "tags", op: "contains", value: "ear" }],
  ["note contains api", { field: "trait", key: "note", op: "contains", value: "API" }],
  ["note contains 234", { field: "trait", key: "note", op: "contains", value: "234" }],
  ["country is set", { field: "trait", key: "country", op: "is_set" }],
  ["country is not set", { field: "trait", key: "country", op: "is_not_set" }],
  ["beta is set", { field: "trait", key: "beta", op: "is_set" }],
  ["nonexistent trait is set", { field: "trait", key: "nope", op: "is_set" }],
  ["nonexistent trait is not set", { field: "trait", key: "nope", op: "is_not_set" }],
  ["nonexistent trait is x", { field: "trait", key: "nope", op: "is", value: "x" }],
  ["nonexistent trait is not x", { field: "trait", key: "nope", op: "is_not", value: "x" }],
  ["lifecycle is at_risk", { field: "lifecycle_state", op: "is", value: "at_risk" }],
  ["lifecycle is not engaged", { field: "lifecycle_state", op: "is_not", value: "engaged" }],
  ["lifecycle in at_risk/dormant", { field: "lifecycle_state", op: "in", value: ["at_risk", "dormant"] }],
  ["first seen within 30 days", { field: "first_seen", op: "within_days", days: 30 }],
  ["first seen before 30 days", { field: "first_seen", op: "before_days", days: 30 }],
  ["last seen within 7 days", { field: "last_seen", op: "within_days", days: 7 }],
  ["last seen before 14 days", { field: "last_seen", op: "before_days", days: 14 }],
  ["last seen before 0 days", { field: "last_seen", op: "before_days", days: 0 }],
  ["login within 7 days", { field: "event", name: "login", op: "performed", within_days: 7 }],
  ["login within 30 days", { field: "event", name: "login", op: "performed", within_days: 30 }],
  ["login at least 2 in 14 days", { field: "event", name: "login", op: "performed", within_days: 14, min_count: 2 }],
  ["login at least 3 in 30 days", { field: "event", name: "login", op: "performed", within_days: 30, min_count: 3 }],
  ["login at least 5 in 365 days", { field: "event", name: "login", op: "performed", within_days: 365, min_count: 5 }],
  ["no login in 7 days", { field: "event", name: "login", op: "not_performed", within_days: 7 }],
  ["no export in 14 days", { field: "event", name: "exported", op: "not_performed", within_days: 14 }],
  ["export within 14 days", { field: "event", name: "exported", op: "performed", within_days: 14 }],
  ["signed_up within 30 days (older events do not count)", { field: "event", name: "signed_up", op: "performed", within_days: 30 }],
  ["signed_up within 90 days", { field: "event", name: "signed_up", op: "performed", within_days: 90 }],
  ["an event nobody sent", { field: "event", name: "never_sent", op: "performed", within_days: 365 }],
  ["no event nobody sent", { field: "event", name: "never_sent", op: "not_performed", within_days: 365 }],
];

describe("every check selects exactly who the in-memory check selects", () => {
  it.each(leaves)("%s", async (_name, rule) => {
    if (!dbAvailable) return;
    const def = single(rule);
    const expected = inMemory(def);
    const actual = await inDatabase(def);
    const missing = [...expected].filter((id) => !actual.has(id));
    const extra = [...actual].filter((id) => !expected.has(id));
    if (missing.length || extra.length) {
      const show = (id: string) => JSON.stringify(rows.find((r) => r.id === id));
      throw new Error(
        `${JSON.stringify(rule)}\n missing from SQL (${missing.length}): ${missing.slice(0, 3).map(show).join("\n   ")}\n extra in SQL (${extra.length}): ${extra.slice(0, 3).map(show).join("\n   ")}`,
      );
    }
    expect(actual.size).toBe(expected.size);
  });

  it("the checks are not all vacuous: most select some contacts and not everyone", async () => {
    if (!dbAvailable) return;
    let partial = 0;
    for (const [, rule] of leaves) {
      const n = inMemory(single(rule)).size;
      if (n > 0 && n < rows.length) partial++;
    }
    expect(partial).toBeGreaterThan(leaves.length * 0.8);
  });
});

describe("combinations", () => {
  // A small deterministic generator, so a failure can be reproduced.
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  it("all and any over random pairs and triples of checks", async () => {
    if (!dbAvailable) return;
    const rand = rng(2024);
    const pick = () => leaves[Math.floor(rand() * leaves.length)]![1];
    for (let i = 0; i < 80; i++) {
      const count = 2 + Math.floor(rand() * 2);
      const def = segmentDefinitionSchema.parse({ match: rand() < 0.5 ? "all" : "any", rules: Array.from({ length: count }, pick) });
      const expected = inMemory(def);
      const actual = await inDatabase(def);
      expect([...actual].sort(), JSON.stringify(def)).toEqual([...expected].sort());
    }
  });

  it("a group with its own match inside a definition", async () => {
    if (!dbAvailable) return;
    const rand = rng(99);
    const pick = () => leaves[Math.floor(rand() * leaves.length)]![1];
    for (let i = 0; i < 60; i++) {
      const def = segmentDefinitionSchema.parse({
        match: rand() < 0.5 ? "all" : "any",
        rules: [pick(), { match: rand() < 0.5 ? "all" : "any", rules: [pick(), pick(), ...(rand() < 0.5 ? [pick()] : [])] }, ...(rand() < 0.4 ? [pick()] : [])],
      });
      const expected = inMemory(def);
      const actual = await inDatabase(def);
      expect([...actual].sort(), JSON.stringify(def)).toEqual([...expected].sort());
    }
  });

  it("a check and its opposite split the workspace exactly in two", async () => {
    if (!dbAvailable) return;
    const pairs: Array<[unknown, unknown]> = [
      [{ field: "plan", op: "is", value: "Pro" }, { field: "plan", op: "is_not", value: "Pro" }],
      [{ field: "trait", key: "country", op: "is_set" }, { field: "trait", key: "country", op: "is_not_set" }],
      [{ field: "has_email", op: "is", value: true }, { field: "has_email", op: "is", value: false }],
      [{ field: "event", name: "login", op: "performed", within_days: 14 }, { field: "event", name: "login", op: "not_performed", within_days: 14 }],
      [{ field: "payment_status", op: "is", value: "paid" }, { field: "payment_status", op: "is_not", value: "paid" }],
    ];
    for (const [a, b] of pairs) {
      const inA = await inDatabase(single(a));
      const inB = await inDatabase(single(b));
      expect(inA.size + inB.size).toBe(rows.length);
      expect([...inA].some((id) => inB.has(id))).toBe(false);
    }
  });
});

describe("safety", () => {
  it("never returns another workspace's contacts, whatever the rules say", async () => {
    if (!dbAvailable) return;
    const everyone = single({ field: "first_seen", op: "before_days", days: 0 });
    const result = await db.execute<{ tenant_id: string }>(
      sql`SELECT contacts.tenant_id FROM contacts WHERE contacts.tenant_id = ${tenantId} AND ${compileSegment(single({ field: "lifecycle_state", op: "in", value: STATES }))}`,
    );
    expect(result.rows.every((r) => r.tenant_id === tenantId)).toBe(true);
    expect(result.rows.length).toBe(rows.length);
    // an event check only looks at the same workspace's events too: the other tenant has none, but the join key is the tenant
    expect((await inDatabase(everyone)).size).toBeLessThanOrEqual(rows.length);
  });

  it("treats hostile text as data: it is a bound value, and the table survives", async () => {
    if (!dbAvailable) return;
    const nasty = ["x'); DROP TABLE contacts; --", "\" OR 1=1 --", "%", "\\", "'; SELECT pg_sleep(5); --"];
    for (const text of nasty) {
      // call the compiler directly, bypassing the schema that would refuse some of these keys
      for (const leaf of [
        { field: "trait", key: text, op: "is", value: text },
        { field: "trait", key: text, op: "contains", value: text },
        { field: "trait", key: text, op: "gt", value: 1 },
        { field: "trait", key: text, op: "is_set" },
        { field: "plan", op: "is", value: text },
        { field: "event", name: text, op: "performed", within_days: 3 },
      ] as const) {
        const started = Date.now();
        const result = await db.execute(sql`SELECT count(*)::int AS n FROM contacts WHERE contacts.tenant_id = ${tenantId} AND ${compileSegmentLeaf(leaf as never)}`);
        expect(Date.now() - started).toBeLessThan(4000); // pg_sleep never ran
        expect(result.rows).toHaveLength(1);
      }
    }
    const stillThere = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = ${tenantId}`);
    expect(stillThere.rows[0]!.n).toBe(rows.length);
  });

  it("refuses a check it does not know instead of guessing", () => {
    expect(() => compileSegmentLeaf({ field: "hair", op: "is", value: "red" } as never)).toThrow(/unsupported/);
    expect(() => compileSegment({ match: "all", rules: [] })).toThrow(/at least one rule/);
  });

  it("bounds an event count: asking for at least N reads at most N rows per contact", async () => {
    if (!dbAvailable) return;
    const q = compileSegmentLeaf({ field: "event", name: "login", op: "performed", within_days: 365, min_count: 3 });
    const plan = await db.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN SELECT count(*) FROM contacts WHERE contacts.tenant_id = ${tenantId} AND ${q}`);
    expect(JSON.stringify(plan.rows)).toMatch(/Limit/);
  });
});
