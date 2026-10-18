/** Warehouse sources, form half: building and reading the settings and credential, and the helper text. */
import { describe, it, expect } from "vitest";
import {
  EXAMPLE_QUERY,
  buildWarehouseConfig,
  buildWarehouseSecret,
  describeInterval,
  emptyWarehouseForm,
  syncState,
  warehouseFormFromConfig,
  type WarehouseForm,
} from "../src/warehouse-sources.js";

const pg = (over: Partial<WarehouseForm> = {}): WarehouseForm => ({ ...emptyWarehouseForm("postgres"), host: "db.example.com", database: "crm", user: "reader", eventValue: "user_synced", ...over });
const built = (f: WarehouseForm) => {
  const r = buildWarehouseConfig(f);
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.value;
};
const problems = (f: WarehouseForm) => {
  const r = buildWarehouseConfig(f);
  return r.ok ? [] : r.problems;
};

describe("buildWarehouseConfig", () => {
  it("builds the settings the API takes for each warehouse", () => {
    expect(built(pg())).toEqual({
      warehouse: "postgres",
      host: "db.example.com",
      port: 5432,
      database: "crm",
      user: "reader",
      ssl_mode: "verify",
      query: EXAMPLE_QUERY.postgres,
      cursor_column: "updated_at",
      cursor_type: "timestamp",
      interval_minutes: 60,
      batch_size: 1000,
      user_id_column: "id",
      email_column: "email",
      event_name: "user_synced",
      trait_columns: { plan: "plan" },
      send_properties: true,
    });
    const sf = built({ ...emptyWarehouseForm("snowflake"), account: "myorg-myaccount", user: "READER", role: "R", sfWarehouse: "WH", eventValue: "e" });
    expect(sf).toMatchObject({ warehouse: "snowflake", account: "myorg-myaccount", user: "READER", role: "R", snowflake_warehouse: "WH" });
    expect(sf).not.toHaveProperty("host");
    const bq = built({ ...emptyWarehouseForm("bigquery"), projectId: "my-project-123", location: "EU", maxGb: "2.5", eventValue: "e" });
    expect(bq).toMatchObject({ warehouse: "bigquery", project_id: "my-project-123", location: "EU", max_bytes_billed: 2_500_000_000 });
  });

  it("passes a CA certificate through for Postgres, and refuses text that is not one", () => {
    const pem = ["-----BEGIN CERTIFICATE-----", "MIIB", "-----END CERTIFICATE-----"].join("\n");
    expect(built(pg({ sslCa: `  ${pem}\n` }))).toMatchObject({ ssl_ca: pem });
    expect(built(pg())).not.toHaveProperty("ssl_ca");
    expect(problems(pg({ sslCa: "just some text" }))[0]).toMatch(/CA certificate must be PEM/);
    expect(warehouseFormFromConfig(built(pg({ sslCa: pem })) as Record<string, unknown>).sslCa).toBe(pem);
    // not sent for other warehouses, even if the field still holds text
    expect(built({ ...emptyWarehouseForm("snowflake"), account: "a-b", user: "U", eventValue: "e", sslCa: pem })).not.toHaveProperty("ssl_ca");
  });

  it("reads the event name from a column, or sets only traits", () => {
    expect(built(pg({ eventMode: "column", eventValue: "kind" }))).toMatchObject({ event_name_column: "kind" });
    expect(built(pg({ eventMode: "column", eventValue: "kind" }))).not.toHaveProperty("event_name");
    const none = built(pg({ eventMode: "none" }));
    expect(none).not.toHaveProperty("event_name");
    expect(none).not.toHaveProperty("event_name_column");
  });

  it("says what is wrong in plain words", () => {
    expect(problems(pg({ host: "" }))).toContain("Give the database host.");
    expect(problems(pg({ port: "99999" }))[0]).toMatch(/port must be a whole number/);
    expect(problems(pg({ cursorColumn: "a b" }))[0]).toMatch(/position column/);
    expect(problems(pg({ userIdColumn: "", emailColumn: "" }))[0]).toMatch(/identifies the person/);
    expect(problems(pg({ eventValue: "" }))).toContain("Give the event a name.");
    expect(problems(pg({ eventMode: "none", traits: [] }))[0]).toMatch(/at least one trait/);
    expect(problems(pg({ traits: [{ name: "plan", column: "" }] }))[0]).toMatch(/both a name and a column/);
    expect(problems(pg({ traits: [{ name: "a", column: "x" }, { name: "a", column: "y" }] }))[0]).toMatch(/listed twice/);
    expect(problems(pg({ intervalMinutes: "2" }))[0]).toMatch(/Run every/);
    expect(problems(pg({ batchSize: "5" }))[0]).toMatch(/Rows per batch/);
    expect(problems({ ...emptyWarehouseForm("snowflake"), account: "bad/acct", user: "", eventValue: "e" })).toEqual([
      "Give the account identifier, such as myorg-myaccount or xy12345.eu-west-1.",
      "Give the Snowflake user.",
    ]);
    expect(problems({ ...emptyWarehouseForm("bigquery"), projectId: "x", eventValue: "e" })[0]).toMatch(/project id/);
  });

  it("skips empty trait rows", () => {
    expect(built(pg({ traits: [{ name: "", column: "" }, { name: "plan", column: "plan" }] }))).toMatchObject({ trait_columns: { plan: "plan" } });
  });
});

describe("buildWarehouseSecret", () => {
  it("needs a credential for a new source and keeps the saved one when editing with the field empty", () => {
    expect(buildWarehouseSecret(pg(), false)).toEqual({ ok: false, problems: ["Enter the database password."] });
    expect(buildWarehouseSecret(pg(), true)).toEqual({ ok: true, value: null });
    expect(buildWarehouseSecret(pg({ password: "pw" }), true)).toEqual({ ok: true, value: { password: "pw" } });
  });
  it("checks the kind of text for a Snowflake key and a BigQuery key file", () => {
    const sf = emptyWarehouseForm("snowflake");
    expect(buildWarehouseSecret({ ...sf, privateKey: "not a key" }, false).ok).toBe(false);
    expect(buildWarehouseSecret({ ...sf, privateKey: " -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- ", passphrase: "pp" }, false)).toEqual({
      ok: true,
      value: { private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", passphrase: "pp" },
    });
    const bq = emptyWarehouseForm("bigquery");
    expect(buildWarehouseSecret({ ...bq, serviceAccountJson: "{nope" }, false).ok).toBe(false);
    expect(buildWarehouseSecret({ ...bq, serviceAccountJson: JSON.stringify({ client_email: "a@b" }) }, false).ok).toBe(false);
    const file = JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----" });
    expect(buildWarehouseSecret({ ...bq, serviceAccountJson: file }, false)).toEqual({ ok: true, value: { service_account_json: file } });
  });
});

describe("warehouseFormFromConfig", () => {
  it("is the inverse of buildWarehouseConfig, with the credential left empty", () => {
    for (const f of [pg(), pg({ eventMode: "column", eventValue: "kind", timestampColumn: "ts" }), { ...emptyWarehouseForm("snowflake"), account: "a-b", user: "U", eventValue: "e" }, { ...emptyWarehouseForm("bigquery"), projectId: "my-project-123", eventValue: "e", maxGb: "3" }]) {
      const config = built(f) as Record<string, unknown>;
      const back = warehouseFormFromConfig(config);
      expect(built(back)).toEqual(config);
      expect(back.password + back.privateKey + back.serviceAccountJson).toBe("");
    }
  });
});

describe("labels", () => {
  it("describes the schedule", () => {
    expect(describeInterval(60)).toBe("Every hour");
    expect(describeInterval(15)).toBe("Every 15 minutes");
    expect(describeInterval(180)).toBe("Every 3 hours");
    expect(describeInterval(1440)).toBe("Every day");
    expect(describeInterval(undefined)).toBe("Every hour");
  });
  it("sums up the state of a source", () => {
    const s = (enabled: boolean, status: string | null, running = false) => syncState({ enabled, sync: { status, running } });
    expect(s(true, null)).toBe("never");
    expect(s(true, "ok")).toBe("ok");
    expect(s(true, "error")).toBe("error");
    expect(s(false, "ok")).toBe("off");
    expect(s(true, "ok", true)).toBe("running");
  });
});
