/**
 * Settings and credentials of a warehouse source. No database, no network: schemas and small helpers only.
 *
 * A warehouse source is an `inbound_sources` row of kind "warehouse":
 *   config        { warehouse, <connection details>, query, cursor_column, schedule, mapping }  (not secret)
 *   secret_sealed JSON of the credential, sealed like a webhook secret (never returned by the API)
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { z } from "zod";
import type { WarehouseConnection } from "@loomail/adapters";
import { IDENTIFIER, MAX_QUERY_LENGTH, SNOWFLAKE_ACCOUNT, BIGQUERY_PROJECT } from "@loomail/adapters";

export const MAX_WAREHOUSE_SOURCES = 5;
export const MIN_INTERVAL_MINUTES = 5;

const column = z.string().trim().regex(IDENTIFIER, "A column name: letters, numbers and underscores, starting with a letter or underscore.");
const optionalName = (max: number) =>
  z.string().trim().min(1).max(max).regex(/^[A-Za-z0-9_$.\- ]+$/, "Letters, numbers, spaces and _ $ . - only.").optional();

const common = {
  /** One SELECT. `:cursor` is the sync position. */
  query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
  /** Column the batch is ordered by and the next position is read from. Must be in the query's output. */
  cursor_column: column,
  cursor_type: z.enum(["timestamp", "number", "text"]).default("timestamp"),
  /** Where the very first run starts. Default: the beginning of time (everything). */
  initial_cursor: z.string().trim().min(1).max(100).optional(),
  interval_minutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(1440).default(60),
  batch_size: z.number().int().min(10).max(5000).default(1000),
  max_batches_per_run: z.number().int().min(1).max(20).default(5),
  timeout_seconds: z.number().int().min(5).max(300).default(60),

  user_id_column: column.optional(),
  email_column: column.optional(),
  event_name: z.string().trim().min(1).max(100).optional(),
  event_name_column: column.optional(),
  timestamp_column: column.optional(),
  trait_columns: z
    .record(column)
    .refine((t) => Object.keys(t).length <= 30 && Object.keys(t).every((k) => k.length >= 1 && k.length <= 64), { message: "Up to 30 traits, with names of 1 to 64 characters." })
    .default({}),
  /** Record the row's values as the event's properties. */
  send_properties: z.boolean().default(true),
};

const postgres = z.object({
  warehouse: z.literal("postgres"),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().trim().min(1).max(63),
  user: z.string().trim().min(1).max(63),
  ssl_mode: z.enum(["verify", "no-verify", "disable"]).default("verify"),
  /**
   * Reach the database through an SSH server (a bastion). `host` and `port` are then the database's address as the SSH
   * server sees it. The SSH key goes in the credential (ssh_private_key). The server's host key must be pinned.
   */
  ssh_tunnel: z
    .object({
      host: z.string().trim().min(1).max(253),
      port: z.number().int().min(1).max(65535).default(22),
      user: z.string().trim().min(1).max(64),
      host_fingerprint: z
        .string()
        .trim()
        .regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/, "The SSH server's host key fingerprint, as ssh-keygen -lf prints it: SHA256: followed by 43 characters."),
    })
    .strict()
    .optional(),
  /** The CA that signed the server's certificate, when it is not a public one (Amazon RDS, Supabase, a private CA). */
  ssl_ca: z
    .string()
    .trim()
    .max(400_000)
    .refine((v) => /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(v), "Paste the CA certificate as PEM text, including the BEGIN CERTIFICATE and END CERTIFICATE lines.")
    .optional(),
  ...common,
});

const snowflake = z.object({
  warehouse: z.literal("snowflake"),
  account: z.string().trim().regex(SNOWFLAKE_ACCOUNT, "The account identifier, such as myorg-myaccount or xy12345.eu-west-1."),
  user: z.string().trim().min(1).max(255),
  snowflake_warehouse: optionalName(255),
  role: optionalName(255),
  database: optionalName(255),
  schema: optionalName(255),
  ...common,
});

const bigquery = z.object({
  warehouse: z.literal("bigquery"),
  project_id: z.string().trim().regex(BIGQUERY_PROJECT, "The Google Cloud project id."),
  location: z.string().trim().regex(/^[A-Za-z0-9-]{2,40}$/, "A location such as US, EU or europe-west2.").optional(),
  /** Queries that would read more than this many bytes are refused. */
  max_bytes_billed: z.number().int().min(1_000_000).max(1_000_000_000_000).default(10_000_000_000),
  ...common,
});

export const warehouseConfigSchema = z
  .discriminatedUnion("warehouse", [postgres.strict(), snowflake.strict(), bigquery.strict()])
  .superRefine((c, ctx) => {
    if (!c.user_id_column && !c.email_column) {
      ctx.addIssue({ code: "custom", path: ["user_id_column"], message: "Say which column identifies the person: a user id column or an email column." });
    }
    if (!c.event_name && !c.event_name_column && Object.keys(c.trait_columns).length === 0) {
      ctx.addIssue({ code: "custom", path: ["event_name"], message: "Give an event name (or a column that holds it), or at least one trait to set." });
    }
  });

export type WarehouseConfig = z.infer<typeof warehouseConfigSchema>;

/** The credential each warehouse needs, as the dashboard sends it. */
export const warehouseSecretSchema = {
  postgres: z
    .object({
      password: z.string().min(1).max(500),
      /** The private key for the SSH tunnel, when the settings use one. */
      ssh_private_key: z.string().trim().min(100).max(10_000).refine((k) => /PRIVATE KEY/.test(k), "Paste the whole SSH private key, including the BEGIN and END lines.").optional(),
      ssh_passphrase: z.string().max(500).optional(),
    })
    .strict(),
  snowflake: z
    .object({
      private_key: z.string().trim().min(100).max(10_000).refine((k) => /PRIVATE KEY/.test(k), "Paste the whole private key, including the BEGIN and END lines."),
      passphrase: z.string().max(500).optional(),
    })
    .strict(),
  bigquery: z
    .object({ service_account_json: z.string().trim().min(50).max(20_000) })
    .strict()
    .transform((v, ctx) => {
      try {
        const j = JSON.parse(v.service_account_json) as { client_email?: unknown; private_key?: unknown };
        if (typeof j.client_email !== "string" || typeof j.private_key !== "string" || !/PRIVATE KEY/.test(j.private_key)) throw new Error("shape");
        return { client_email: j.client_email, private_key: j.private_key };
      } catch {
        ctx.addIssue({ code: "custom", message: "Paste the whole service-account key file (the JSON that Google gives you).", path: ["service_account_json"] });
        return z.NEVER;
      }
    }),
} as const;

/** What may be changed without repeating the rest of the credential: Postgres fields are merged over the saved ones. */
export const postgresSecretPatchSchema = warehouseSecretSchema.postgres.partial();

export type WarehouseSecret = { password: string; ssh_private_key?: string; ssh_passphrase?: string } | { private_key: string; passphrase?: string } | { client_email: string; private_key: string };

/** Turn stored settings and credential into what the adapters take. */
export function toConnection(config: WarehouseConfig, secret: WarehouseSecret): WarehouseConnection {
  switch (config.warehouse) {
    case "postgres":
      return { kind: "postgres", config: { host: config.host, port: config.port, database: config.database, user: config.user, ssl_mode: config.ssl_mode, ...(config.ssl_ca ? { ssl_ca: config.ssl_ca } : {}), ...(config.ssh_tunnel ? { ssh: config.ssh_tunnel } : {}) }, secret: secret as { password: string; ssh_private_key?: string; ssh_passphrase?: string } };
    case "snowflake":
      return {
        kind: "snowflake",
        config: {
          account: config.account,
          user: config.user,
          ...(config.snowflake_warehouse ? { warehouse: config.snowflake_warehouse } : {}),
          ...(config.role ? { role: config.role } : {}),
          ...(config.database ? { database: config.database } : {}),
          ...(config.schema ? { schema: config.schema } : {}),
        },
        secret: secret as { private_key: string; passphrase?: string },
      };
    case "bigquery":
      return {
        kind: "bigquery",
        config: { project_id: config.project_id, ...(config.location ? { location: config.location } : {}), max_bytes_billed: config.max_bytes_billed },
        secret: secret as { client_email: string; private_key: string },
      };
  }
}

/** Where the first run starts when the customer did not say. Compared with `>=`, so it reads everything. */
export function defaultCursor(type: WarehouseConfig["cursor_type"]): string {
  return type === "timestamp" ? "1970-01-01T00:00:00.000Z" : type === "number" ? "-9007199254740991" : "";
}
