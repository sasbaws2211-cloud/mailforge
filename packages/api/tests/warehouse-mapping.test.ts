/** Warehouse settings and row mapping: pure, no database. */
import { describe, it, expect } from "vitest";
import { warehouseConfigSchema, warehouseSecretSchema, defaultCursor } from "../src/warehouse/config.js";
import { cursorOf, laterCursor, mapWarehouseRow, rowFingerprint } from "../src/warehouse/mapping.js";
import { missingColumns } from "../src/warehouse/sync.js";

const base = {
  warehouse: "postgres",
  host: "db.example.com",
  database: "app",
  user: "loomail",
  query: "SELECT id, email, plan, updated_at FROM users WHERE updated_at >= :cursor::timestamptz",
  cursor_column: "updated_at",
  user_id_column: "id",
  event_name: "user_synced",
  trait_columns: { plan: "plan" },
};
const parse = (o: unknown) => warehouseConfigSchema.safeParse(o);

describe("warehouseConfigSchema", () => {
  it("fills in defaults", () => {
    const r = parse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ port: 5432, ssl_mode: "verify", cursor_type: "timestamp", interval_minutes: 60, batch_size: 1000, max_batches_per_run: 5, timeout_seconds: 60, send_properties: true });
  });
  it("needs a person and something to record", () => {
    expect(parse({ ...base, user_id_column: undefined }).success).toBe(false);
    expect(parse({ ...base, event_name: undefined, trait_columns: {} }).success).toBe(false);
    expect(parse({ ...base, user_id_column: undefined, email_column: "email" }).success).toBe(true);
    expect(parse({ ...base, event_name: undefined, event_name_column: "kind", trait_columns: {} }).success).toBe(true);
  });
  it("refuses column names that are not plain names, bad bounds and unknown fields", () => {
    expect(parse({ ...base, cursor_column: "a; drop table x" }).success).toBe(false);
    expect(parse({ ...base, trait_columns: { plan: "p lan" } }).success).toBe(false);
    expect(parse({ ...base, interval_minutes: 1 }).success).toBe(false);
    expect(parse({ ...base, batch_size: 9 }).success).toBe(false);
    expect(parse({ ...base, batch_size: 5001 }).success).toBe(false);
    expect(parse({ ...base, port: 0 }).success).toBe(false);
    expect(parse({ ...base, password: "oops" }).success).toBe(false); // the credential never lives in the settings
  });
  it("checks each warehouse's own fields", () => {
    const { host: _h, database: _d, ssl_mode: _s, ...rest } = { ...base, ssl_mode: undefined } as Record<string, unknown>;
    const sf = { ...rest, warehouse: "snowflake", account: "myorg-myaccount", user: "READER" };
    expect(parse(sf).success).toBe(true);
    expect(parse({ ...sf, account: "evil.com/x" }).success).toBe(false);
    const bq = { warehouse: "bigquery", project_id: "my-project-123", query: base.query, cursor_column: "ts", user_id_column: "id", event_name: "e" };
    expect(parse(bq).success).toBe(true);
    expect(parse({ ...bq, project_id: "../x" }).success).toBe(false);
    expect(parse({ ...bq, max_bytes_billed: 10 }).success).toBe(false);
  });
});

describe("warehouseSecretSchema", () => {
  it("takes the credential each warehouse needs", () => {
    expect(warehouseSecretSchema.postgres.safeParse({ password: "x" }).success).toBe(true);
    expect(warehouseSecretSchema.postgres.safeParse({ password: "" }).success).toBe(false);
    const key = "-----BEGIN PRIVATE KEY-----\n" + "A".repeat(120) + "\n-----END PRIVATE KEY-----";
    expect(warehouseSecretSchema.snowflake.safeParse({ private_key: key }).success).toBe(true);
    expect(warehouseSecretSchema.snowflake.safeParse({ private_key: "A".repeat(150) }).success).toBe(false);
  });
  it("reads a BigQuery key file and keeps only what is needed", () => {
    const file = JSON.stringify({ type: "service_account", project_id: "p", client_email: "r@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n", token_uri: "http://evil/" });
    const r = warehouseSecretSchema.bigquery.safeParse({ service_account_json: file });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ client_email: "r@p.iam.gserviceaccount.com", private_key: expect.stringContaining("PRIVATE KEY") });
    expect(warehouseSecretSchema.bigquery.safeParse({ service_account_json: "{ not json ".padEnd(60, " ") }).success).toBe(false);
    expect(warehouseSecretSchema.bigquery.safeParse({ service_account_json: JSON.stringify({ client_email: "x" }).padEnd(60, " ") }).success).toBe(false);
  });
});

describe("mapWarehouseRow", () => {
  const cfg = parse({ ...base, email_column: "email", timestamp_column: "updated_at" });
  if (!cfg.success) throw new Error("fixture");
  const c = cfg.data;
  const row = { id: 42, email: "Ama@Example.com ", plan: "pro", updated_at: "2026-02-03T04:05:06.000Z", note: null, n: 3 };

  it("finds the person, traits, event and properties", () => {
    const r = mapWarehouseRow(c, row, "src1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mapped.actor).toEqual({ userId: "42", email: "ama@example.com" });
    expect(r.mapped.traits).toEqual({ plan: "pro" });
    expect(r.mapped.track).toMatchObject({ event: "user_synced", timestamp: "2026-02-03T04:05:06.000Z", properties: { id: 42, plan: "pro", n: 3 } });
    expect(r.mapped.track!.properties).not.toHaveProperty("note"); // nulls are left out
    expect(r.mapped.track!.messageId).toMatch(/^wh:src1:[0-9a-f]{32}$/);
  });
  it("gives the same message id for the same row and a different one when anything changes", () => {
    const id = (row2: typeof row) => (mapWarehouseRow(c, row2, "s") as { ok: true; mapped: { track: { messageId: string } } }).mapped.track.messageId;
    expect(id(row)).toBe(id({ ...row }));
    expect(id(row)).not.toBe(id({ ...row, plan: "free" }));
    expect(rowFingerprint({ a: 1, b: 2 })).toBe(rowFingerprint({ b: 2, a: 1 }));
  });
  it("skips a row with no person, and does not clear a trait that is null", () => {
    expect(mapWarehouseRow(c, { ...row, id: null, email: "not an email" }, "s")).toEqual({ ok: false, reason: "no user id or email in this row" });
    const r = mapWarehouseRow(c, { ...row, plan: null }, "s");
    expect(r.ok && r.mapped.traits).toEqual({});
  });
  it("reads the event name from a column and falls back to the fixed one", () => {
    const named = parse({ ...base, event_name: "fallback", event_name_column: "kind" });
    if (!named.success) throw new Error("fixture");
    const a = mapWarehouseRow(named.data, { id: 1, kind: "plan_changed" }, "s");
    expect(a.ok && a.mapped.track?.event).toBe("plan_changed");
    const b = mapWarehouseRow(named.data, { id: 1, kind: "" }, "s");
    expect(b.ok && b.mapped.track?.event).toBe("fallback");
  });
  it("ignores a timestamp that is not a date and can leave properties out", () => {
    const quiet = parse({ ...base, timestamp_column: "ts", send_properties: false });
    if (!quiet.success) throw new Error("fixture");
    const r = mapWarehouseRow(quiet.data, { id: 1, ts: "soon" }, "s");
    expect(r.ok && r.mapped.track).toMatchObject({ properties: {} });
    expect(r.ok && r.mapped.track).not.toHaveProperty("timestamp");
  });
  it("matches column names without regard to case", () => {
    const shout = parse({ ...base, user_id_column: "ID", trait_columns: { plan: "PLAN" } });
    if (!shout.success) throw new Error("fixture");
    const r = mapWarehouseRow(shout.data, { id: 7, plan: "x" }, "s");
    expect(r.ok && r.mapped.actor.userId).toBe("7");
  });
});

describe("cursors", () => {
  it("compares by type", () => {
    expect(laterCursor("number", "9", "10")).toBe("10");
    expect(laterCursor("text", "9", "10")).toBe("9");
    expect(laterCursor("timestamp", "2026-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z");
    expect(laterCursor("timestamp", null, "2026-01-01T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z");
    expect(laterCursor("number", "5", null)).toBe("5");
  });
  it("reads the cursor column and starts from the beginning of time", () => {
    const cfg = parse(base);
    if (!cfg.success) throw new Error("fixture");
    expect(cursorOf(cfg.data, { updated_at: "2026-01-01T00:00:00.000Z" })).toBe("2026-01-01T00:00:00.000Z");
    expect(cursorOf(cfg.data, { updated_at: null })).toBeNull();
    expect(defaultCursor("timestamp")).toBe("1970-01-01T00:00:00.000Z");
    expect(Number(defaultCursor("number"))).toBeLessThan(-1e15);
    expect(defaultCursor("text")).toBe("");
  });
  it("names missing columns", () => {
    const cfg = parse({ ...base, email_column: "email" });
    if (!cfg.success) throw new Error("fixture");
    expect(missingColumns(cfg.data, ["id", "plan", "updated_at"])).toEqual(["email"]);
    expect(missingColumns(cfg.data, ["id", "email", "plan", "updated_at"])).toEqual([]);
  });
});
