/**
 * Warehouse connectors: pick the client for a kind. See types.ts for the shape and query.ts for the rules on queries.
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import { createBigQueryClient, type BigQueryConfig, type BigQuerySecret } from "./bigquery.js";
import { createPostgresClient, type PostgresConfig, type PostgresSecret } from "./postgres.js";
import { createSnowflakeClient, type SnowflakeConfig, type SnowflakeSecret } from "./snowflake.js";
import type { WarehouseHostPolicy } from "./guard.js";
import type { WarehouseClient, WarehouseKind } from "./types.js";

export type { WarehouseKind, WarehouseClient, WarehouseQuery, WarehouseRows, CellValue } from "./types.js";
export { WarehouseError } from "./types.js";
export { checkQuery, compileQuery, IDENTIFIER, MAX_QUERY_LENGTH } from "./query.js";
export { resolveWarehouseHost, warehouseHostPolicyFromEnv, WAREHOUSE_HOST_NOT_ALLOWED, type WarehouseHostPolicy } from "./guard.js";
export { createPostgresClient, type PostgresConfig, type PostgresSecret } from "./postgres.js";
export { fingerprintOf, normalizeFingerprint, openTunnel, type SshTunnelConfig, type SshTunnelSecret, type Tunnel } from "./ssh-tunnel.js";
export { createSnowflakeClient, snowflakeCell, snowflakeToken, jwtAccount, snowflakeHost, SNOWFLAKE_ACCOUNT, type SnowflakeConfig, type SnowflakeSecret } from "./snowflake.js";
export { createBigQueryClient, bigqueryCell, BIGQUERY_PROJECT, type BigQueryConfig, type BigQuerySecret } from "./bigquery.js";

export type WarehouseConnection =
  | { kind: "postgres"; config: PostgresConfig; secret: PostgresSecret }
  | { kind: "snowflake"; config: SnowflakeConfig; secret: SnowflakeSecret }
  | { kind: "bigquery"; config: BigQueryConfig; secret: BigQuerySecret };

export function createWarehouseClient(conn: WarehouseConnection, opts: { policy?: WarehouseHostPolicy } = {}): WarehouseClient {
  switch (conn.kind) {
    case "postgres":
      return createPostgresClient(conn.config, conn.secret, opts);
    case "snowflake":
      return createSnowflakeClient(conn.config, conn.secret);
    case "bigquery":
      return createBigQueryClient(conn.config, conn.secret);
  }
}
