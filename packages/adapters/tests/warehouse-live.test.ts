/**
 * Snowflake and BigQuery against the real services (a trial account / the BigQuery sandbox). Skipped unless set:
 *
 *   Snowflake: SNOWFLAKE_TEST_ACCOUNT, SNOWFLAKE_TEST_USER, SNOWFLAKE_TEST_PRIVATE_KEY_FILE (PKCS8 PEM),
 *              optional SNOWFLAKE_TEST_PASSPHRASE, SNOWFLAKE_TEST_WAREHOUSE, SNOWFLAKE_TEST_ROLE
 *   BigQuery:  BIGQUERY_TEST_KEY_FILE (service-account JSON), optional BIGQUERY_TEST_LOCATION
 *
 * The queries read nothing from any table: they select constants, so they need no data and cost nothing measurable.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createSnowflakeClient } from "../src/warehouse/snowflake.js";
import { createBigQueryClient } from "../src/warehouse/bigquery.js";
import { WarehouseError } from "../src/warehouse/types.js";

const env = process.env;
const snowflakeOn = !!(env.SNOWFLAKE_TEST_ACCOUNT && env.SNOWFLAKE_TEST_USER && env.SNOWFLAKE_TEST_PRIVATE_KEY_FILE);
const bigqueryOn = !!env.BIGQUERY_TEST_KEY_FILE;
const failure = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as WarehouseError);

(snowflakeOn ? describe : describe.skip)("Snowflake (the real service)", () => {
  const client = (over: Record<string, unknown> = {}) =>
    createSnowflakeClient(
      {
        account: env.SNOWFLAKE_TEST_ACCOUNT!,
        user: env.SNOWFLAKE_TEST_USER!,
        ...(env.SNOWFLAKE_TEST_WAREHOUSE ? { warehouse: env.SNOWFLAKE_TEST_WAREHOUSE } : {}),
        ...(env.SNOWFLAKE_TEST_ROLE ? { role: env.SNOWFLAKE_TEST_ROLE } : {}),
        ...over,
      },
      { private_key: readFileSync(env.SNOWFLAKE_TEST_PRIVATE_KEY_FILE!, "utf8"), ...(env.SNOWFLAKE_TEST_PASSPHRASE ? { passphrase: env.SNOWFLAKE_TEST_PASSPHRASE } : {}) },
    );
  const q = { sql: "SELECT 1 AS id, 'a@x.test' AS email, CURRENT_TIMESTAMP() AS updated_at WHERE CURRENT_TIMESTAMP() >= TO_TIMESTAMP_TZ(:cursor)", cursor: "1970-01-01T00:00:00.000Z", cursorColumn: "updated_at", maxRows: 10, timeoutMs: 60_000 };

  it("signs in with the key pair and reads a row, with a bound :cursor", async () => {
    const out = await client().query(q);
    expect(out.columns).toEqual(["id", "email", "updated_at"]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ id: 1, email: "a@x.test" });
    expect(String(out.rows[0]!.updated_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it("returns no rows when the cursor is in the future", async () => {
    expect((await client().query({ ...q, cursor: "2999-01-01T00:00:00.000Z" })).rows).toHaveLength(0);
  });
  it("says what is wrong for a bad query", async () => {
    const e = await failure(client().query({ ...q, sql: "SELECT nope FROM definitely_not_a_table" }));
    expect(e).toBeInstanceOf(WarehouseError);
  });
  it("refuses a user the key does not belong to", async () => {
    const e = await failure(client({ user: "NOT_A_REAL_USER_" + Date.now() }).query(q));
    expect(e).toBeInstanceOf(WarehouseError);
  });
});

(bigqueryOn ? describe : describe.skip)("BigQuery (the real service / sandbox)", () => {
  const key = () => JSON.parse(readFileSync(env.BIGQUERY_TEST_KEY_FILE!, "utf8")) as { project_id: string; client_email: string; private_key: string };
  const client = (over: Record<string, unknown> = {}) =>
    createBigQueryClient(
      { project_id: key().project_id, ...(env.BIGQUERY_TEST_LOCATION ? { location: env.BIGQUERY_TEST_LOCATION } : {}), max_bytes_billed: 10_000_000_000, ...over },
      { client_email: key().client_email, private_key: key().private_key },
    );
  const q = { sql: "SELECT 1 AS id, 'a@x.test' AS email, CURRENT_TIMESTAMP() AS updated_at FROM UNNEST([1]) WHERE CURRENT_TIMESTAMP() >= TIMESTAMP(:cursor)", cursor: "1970-01-01T00:00:00.000Z", cursorColumn: "updated_at", maxRows: 10, timeoutMs: 60_000 };

  it("signs in with the service account and reads a row, with a bound :cursor", async () => {
    const out = await client().query(q);
    expect(out.columns).toEqual(["id", "email", "updated_at"]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ id: 1, email: "a@x.test" });
    expect(String(out.rows[0]!.updated_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it("returns no rows when the cursor is in the future", async () => {
    expect((await client().query({ ...q, cursor: "2999-01-01T00:00:00.000Z" })).rows).toHaveLength(0);
  });
  it("refuses a query that would read more than the byte limit", async () => {
    const e = await failure(client({ max_bytes_billed: 1_000_000 }).query({ ...q, sql: "SELECT repository_name AS id, CURRENT_TIMESTAMP() AS updated_at FROM `bigquery-public-data.github_repos.sample_repos` WHERE CURRENT_TIMESTAMP() >= TIMESTAMP(:cursor)" }));
    expect(e).toBeInstanceOf(WarehouseError);
  });
  it("says what is wrong for a bad query", async () => {
    const e = await failure(client().query({ ...q, sql: "SELECT nope FROM `no_such_dataset.no_such_table`" }));
    expect(e).toBeInstanceOf(WarehouseError);
  });
});
