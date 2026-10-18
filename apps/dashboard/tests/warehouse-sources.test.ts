/** Warehouse sources, form half: building and reading the settings and credential, and the helper text. */
import { describe, it, expect } from "vitest";
import { ACCESS_DATABASES, accessRequestMessage, accessRequestProblem } from "../src/warehouse-sources.js";
import {
  EXAMPLE_QUERY,
  SSH_FINGERPRINT,
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

const FP = "SHA256:" + "A".repeat(43);
const KEY = ["-----BEGIN OPENSSH PRIVATE KEY-----", "Q".repeat(120), "-----END OPENSSH PRIVATE KEY-----"].join("\n");
const tunnelForm = (over: Partial<WarehouseForm> = {}): WarehouseForm => pg({ sshEnabled: true, sshHost: "bastion.example.com", sshUser: "loomail", sshFingerprint: FP, host: "db.internal", ...over });

describe("an SSH tunnel", () => {
  it("adds nothing to the settings when it is off", () => {
    expect(built(pg())).not.toHaveProperty("ssh_tunnel");
    expect(built(pg({ sshHost: "left-over.example.com", sshUser: "u" }))).not.toHaveProperty("ssh_tunnel"); // text left in hidden fields is ignored
  });

  it("builds the tunnel settings, with the port as a number", () => {
    expect(built(tunnelForm())).toMatchObject({ host: "db.internal", ssh_tunnel: { host: "bastion.example.com", port: 22, user: "loomail", host_fingerprint: FP } });
    expect(built(tunnelForm({ sshPort: "2222", sshHost: "  b.example.com " }))).toMatchObject({ ssh_tunnel: { host: "b.example.com", port: 2222 } });
  });

  it("says what is wrong, in plain words", () => {
    expect(problems(tunnelForm({ sshHost: "" }))).toContain("Give the SSH server's address.");
    expect(problems(tunnelForm({ sshUser: "" }))).toContain("Give the SSH user.");
    expect(problems(tunnelForm({ sshPort: "0" }))[0]).toMatch(/SSH port must be a whole number/);
    for (const bad of ["", "SHA256:short", "MD5:aa:bb", "A".repeat(43), "sha256:" + "A".repeat(43)]) {
      expect(problems(tunnelForm({ sshFingerprint: bad })).join(" "), bad).toMatch(/host key fingerprint/);
    }
    expect(SSH_FINGERPRINT.test(FP + "=")).toBe(true);
  });

  it("needs the key for a new source, and sends only what was typed when editing", () => {
    const need = buildWarehouseSecret(tunnelForm({ password: "pw" }), false);
    expect(need).toEqual({ ok: false, problems: [expect.stringMatching(/SSH private key/)] });
    expect(buildWarehouseSecret(tunnelForm({ password: "pw", sshPrivateKey: KEY, sshPassphrase: "pp" }), false)).toEqual({
      ok: true,
      value: { password: "pw", ssh_private_key: KEY, ssh_passphrase: "pp" },
    });
    // editing a source that already has its key: nothing typed sends nothing, a new password sends only the password
    expect(buildWarehouseSecret(tunnelForm(), true, true)).toEqual({ ok: true, value: null });
    expect(buildWarehouseSecret(tunnelForm({ password: "new" }), true, true)).toEqual({ ok: true, value: { password: "new" } });
    expect(buildWarehouseSecret(tunnelForm({ sshPrivateKey: KEY }), true, true)).toEqual({ ok: true, value: { ssh_private_key: KEY } });
    expect(buildWarehouseSecret(tunnelForm({ sshPassphrase: "only" }), true, true)).toEqual({ ok: true, value: { ssh_passphrase: "only" } });
    // turning a tunnel on for a source that had none needs a key
    expect(buildWarehouseSecret(tunnelForm(), true, false).ok).toBe(false);
  });

  it("refuses text that is not a private key, and sends no SSH fields when the tunnel is off", () => {
    expect(buildWarehouseSecret(tunnelForm({ password: "pw", sshPrivateKey: "just words" }), false).ok).toBe(false);
    expect(buildWarehouseSecret(pg({ password: "pw", sshPrivateKey: KEY, sshPassphrase: "x" }), false)).toEqual({ ok: true, value: { password: "pw" } });
    expect(buildWarehouseSecret(pg(), false)).toEqual({ ok: false, problems: ["Enter the database password."] });
  });

  it("is read back from a saved source, without any key", () => {
    const config = built(tunnelForm({ sshPort: "2222" })) as Record<string, unknown>;
    const back = warehouseFormFromConfig(config);
    expect(back).toMatchObject({ sshEnabled: true, sshHost: "bastion.example.com", sshPort: "2222", sshUser: "loomail", sshFingerprint: FP, host: "db.internal" });
    expect(back.sshPrivateKey + back.sshPassphrase + back.password).toBe("");
    expect(built(back)).toEqual(config);
    expect(warehouseFormFromConfig(built(pg()) as Record<string, unknown>)).toMatchObject({ sshEnabled: false, sshPort: "22" });
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

describe("MySQL and SQL Server", () => {
  const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
  for (const [w, port] of [["mysql", "3306"], ["mssql", "1433"]] as const) {
    it(`${w}: starts with its own port and example query, and builds host settings with a tunnel`, () => {
      const f = emptyWarehouseForm(w);
      expect(f.port).toBe(port);
      expect(f.query).not.toBe(emptyWarehouseForm("postgres").query);
      const filled = { ...f, host: "db.internal", database: "app", user: "loomail", password: "pw", sshEnabled: true, sshHost: "bastion.example.com", sshUser: "loomail", sshFingerprint: "SHA256:" + "A".repeat(43), sshPrivateKey: KEY, eventValue: "user_synced" };
      const c = buildWarehouseConfig(filled);
      expect(c.ok).toBe(true);
      if (c.ok) expect(c.value).toMatchObject({ host: "db.internal", port: Number(port), database: "app", ssh_tunnel: { host: "bastion.example.com", port: 22 } });
      expect(buildWarehouseSecret(filled, false)).toEqual({ ok: true, value: { password: "pw", ssh_private_key: KEY } });
      expect(buildWarehouseSecret({ ...filled, password: "", sshPrivateKey: "" }, true, true)).toEqual({ ok: true, value: null });
      expect(buildWarehouseSecret({ ...filled, password: "" }, false).ok).toBe(false);
    });
    it(`${w}: is read back from a saved source`, () => {
      const back = warehouseFormFromConfig({ warehouse: w, host: "h", port: 4000, database: "d", user: "u", ssh_tunnel: { host: "b", port: 2222, user: "s", host_fingerprint: "SHA256:" + "A".repeat(43) }, query: "SELECT 1" });
      expect(back).toMatchObject({ warehouse: w, port: "4000", sshEnabled: true, sshPort: "2222" });
    });
  }
});

describe("asking Support for warehouse access", () => {
  const ok = { database: "Postgres", size: " about 2 million customers ", refresh: "once a day", notes: "" };

  it("needs the size and the refresh rate, the two things Support must know to price it", () => {
    expect(accessRequestProblem(ok)).toBeNull();
    expect(accessRequestProblem({ ...ok, size: "  " })).toMatch(/how big/);
    expect(accessRequestProblem({ ...ok, refresh: "" })).toMatch(/how often/);
  });

  it("writes the request as a short message Support can read, with the notes only when given", () => {
    expect(accessRequestMessage(ok)).toBe(
      "I would like warehouse sources switched on for my workspace.\n\nDatabase: Postgres\nRoughly how much data: about 2 million customers\nHow often it needs to refresh: once a day",
    );
    expect(accessRequestMessage({ ...ok, notes: " Sync orders too " })).toMatch(/refresh: once a day\n\nSync orders too$/);
    expect(accessRequestMessage({ ...ok, notes: "x".repeat(9000) }).length).toBeLessThanOrEqual(5000);
    expect(ACCESS_DATABASES).toContain("Postgres");
  });
});
