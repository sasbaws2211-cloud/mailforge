/**
 * Warehouse sources, the form half: turning what a person types into the settings and credential the API takes, and
 * back. No React, no network. Mirrors the API's warehouseConfigSchema (packages/api/src/warehouse/config.ts), which
 * has the last word.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */

export type Warehouse = "postgres" | "snowflake" | "bigquery";

export const WAREHOUSE_LABEL: Record<Warehouse, string> = {
  postgres: "Postgres (also Redshift, Supabase, Neon, RDS...)",
  snowflake: "Snowflake",
  bigquery: "Google BigQuery",
};
export const WAREHOUSE_SHORT: Record<Warehouse, string> = { postgres: "Postgres", snowflake: "Snowflake", bigquery: "BigQuery" };

export interface TraitRow {
  name: string;
  column: string;
}

export interface WarehouseForm {
  warehouse: Warehouse;
  // connection
  host: string;
  port: string;
  database: string;
  user: string;
  sslMode: "verify" | "no-verify" | "disable";
  account: string;
  sfWarehouse: string;
  role: string;
  schema: string;
  projectId: string;
  location: string;
  maxGb: string;
  // credential (never filled in from a saved source)
  password: string;
  privateKey: string;
  passphrase: string;
  serviceAccountJson: string;
  // the query
  query: string;
  cursorColumn: string;
  cursorType: "timestamp" | "number" | "text";
  initialCursor: string;
  intervalMinutes: string;
  batchSize: string;
  // mapping
  userIdColumn: string;
  emailColumn: string;
  eventMode: "fixed" | "column" | "none";
  eventValue: string;
  timestampColumn: string;
  traits: TraitRow[];
  sendProperties: boolean;
}

/** A starting query for each warehouse. `:cursor` is the sync position; it is the only parameter. */
export const EXAMPLE_QUERY: Record<Warehouse, string> = {
  postgres: "SELECT id, email, plan, updated_at\nFROM users\nWHERE updated_at >= :cursor::timestamptz",
  snowflake: "SELECT id, email, plan, updated_at\nFROM analytics.public.users\nWHERE updated_at >= TO_TIMESTAMP_TZ(:cursor)",
  bigquery: "SELECT id, email, plan, updated_at\nFROM `my-project.crm.users`\nWHERE updated_at >= TIMESTAMP(:cursor)",
};

export function emptyWarehouseForm(warehouse: Warehouse = "postgres"): WarehouseForm {
  return {
    warehouse,
    host: "",
    port: "5432",
    database: "",
    user: "",
    sslMode: "verify",
    account: "",
    sfWarehouse: "",
    role: "",
    schema: "",
    projectId: "",
    location: "",
    maxGb: "10",
    password: "",
    privateKey: "",
    passphrase: "",
    serviceAccountJson: "",
    query: EXAMPLE_QUERY[warehouse],
    cursorColumn: "updated_at",
    cursorType: "timestamp",
    initialCursor: "",
    intervalMinutes: "60",
    batchSize: "1000",
    userIdColumn: "id",
    emailColumn: "email",
    eventMode: "fixed",
    eventValue: "",
    timestampColumn: "",
    traits: [{ name: "plan", column: "plan" }],
    sendProperties: true,
  };
}

const COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,98}[A-Za-z0-9]$/;
const PROJECT = /^[a-z][a-z0-9.:-]{4,61}[a-z0-9]$/;

export type Built<T> = { ok: true; value: T } | { ok: false; problems: string[] };

function whole(raw: string, name: string, min: number, max: number, problems: string[]): number | undefined {
  const t = raw.trim();
  if (!/^\d+$/.test(t) || Number(t) < min || Number(t) > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max}.`);
    return undefined;
  }
  return Number(t);
}

/** The settings the API takes, or what is wrong with the form. */
export function buildWarehouseConfig(f: WarehouseForm): Built<Record<string, unknown>> {
  const problems: string[] = [];
  const w = f.warehouse;
  const need = (v: string, msg: string) => {
    if (!v.trim()) problems.push(msg);
  };

  let connection: Record<string, unknown> = {};
  if (w === "postgres") {
    need(f.host, "Give the database host.");
    need(f.database, "Give the database name.");
    need(f.user, "Give the database user.");
    const port = whole(f.port, "The port", 1, 65535, problems);
    connection = { host: f.host.trim(), ...(port !== undefined ? { port } : {}), database: f.database.trim(), user: f.user.trim(), ssl_mode: f.sslMode };
  } else if (w === "snowflake") {
    if (!ACCOUNT.test(f.account.trim())) problems.push("Give the account identifier, such as myorg-myaccount or xy12345.eu-west-1.");
    need(f.user, "Give the Snowflake user.");
    connection = {
      account: f.account.trim(),
      user: f.user.trim(),
      ...(f.sfWarehouse.trim() ? { snowflake_warehouse: f.sfWarehouse.trim() } : {}),
      ...(f.role.trim() ? { role: f.role.trim() } : {}),
      ...(f.database.trim() ? { database: f.database.trim() } : {}),
      ...(f.schema.trim() ? { schema: f.schema.trim() } : {}),
    };
  } else {
    if (!PROJECT.test(f.projectId.trim())) problems.push("Give the Google Cloud project id, such as my-project-123.");
    const gb = Number(f.maxGb.trim());
    if (!Number.isFinite(gb) || gb < 0.001 || gb > 1000) problems.push("The data limit per query must be between 0.001 and 1000 GB.");
    connection = {
      project_id: f.projectId.trim(),
      ...(f.location.trim() ? { location: f.location.trim() } : {}),
      max_bytes_billed: Math.round(gb * 1_000_000_000),
    };
  }

  if (!f.query.trim()) problems.push("Write the query.");
  if (!COLUMN.test(f.cursorColumn.trim())) problems.push("The position column must be a plain column name (letters, numbers and underscores).");
  const interval = whole(f.intervalMinutes, "Run every (minutes)", 5, 1440, problems);
  const batch = whole(f.batchSize, "Rows per batch", 10, 5000, problems);

  const userId = f.userIdColumn.trim();
  const email = f.emailColumn.trim();
  if (!userId && !email) problems.push("Say which column identifies the person: a user id column or an email column.");
  for (const [label, v] of [["The user id column", userId], ["The email column", email], ["The time column", f.timestampColumn.trim()]] as const) {
    if (v && !COLUMN.test(v)) problems.push(`${label} must be a plain column name.`);
  }

  const trait_columns: Record<string, string> = {};
  for (const row of f.traits) {
    const name = row.name.trim();
    const column = row.column.trim();
    if (!name && !column) continue;
    if (!name || !column) {
      problems.push("Each trait needs both a name and a column.");
      continue;
    }
    if (name.length > 64) problems.push(`The trait name "${name.slice(0, 20)}..." is longer than 64 characters.`);
    if (!COLUMN.test(column)) problems.push(`"${column.slice(0, 20)}" is not a plain column name.`);
    if (name in trait_columns) problems.push(`The trait "${name}" is listed twice.`);
    trait_columns[name] = column;
  }
  if (Object.keys(trait_columns).length > 30) problems.push("A source can set at most 30 traits.");

  const ev = f.eventValue.trim();
  if (f.eventMode !== "none" && !ev) problems.push(f.eventMode === "fixed" ? "Give the event a name." : "Say which column holds the event name.");
  if (f.eventMode === "column" && ev && !COLUMN.test(ev)) problems.push("The event column must be a plain column name.");
  if (f.eventMode === "none" && Object.keys(trait_columns).length === 0) problems.push("With no event, add at least one trait to set.");

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      warehouse: w,
      ...connection,
      query: f.query.trim(),
      cursor_column: f.cursorColumn.trim(),
      cursor_type: f.cursorType,
      ...(f.initialCursor.trim() ? { initial_cursor: f.initialCursor.trim() } : {}),
      interval_minutes: interval,
      batch_size: batch,
      ...(userId ? { user_id_column: userId } : {}),
      ...(email ? { email_column: email } : {}),
      ...(f.eventMode === "fixed" ? { event_name: ev } : {}),
      ...(f.eventMode === "column" ? { event_name_column: ev } : {}),
      ...(f.timestampColumn.trim() ? { timestamp_column: f.timestampColumn.trim() } : {}),
      trait_columns,
      send_properties: f.sendProperties,
    },
  };
}

/**
 * The credential the API takes. Null when the field was left empty and a saved one exists (editing keeps it).
 * A problem when it is needed and missing or not the right kind of text.
 */
export function buildWarehouseSecret(f: WarehouseForm, hasSaved: boolean): Built<Record<string, unknown> | null> {
  const w = f.warehouse;
  const given = w === "postgres" ? f.password !== "" : w === "snowflake" ? f.privateKey.trim() !== "" : f.serviceAccountJson.trim() !== "";
  if (!given) {
    if (hasSaved) return { ok: true, value: null };
    return { ok: false, problems: [w === "postgres" ? "Enter the database password." : w === "snowflake" ? "Paste the private key." : "Paste the service-account key file."] };
  }
  if (w === "postgres") return { ok: true, value: { password: f.password } };
  if (w === "snowflake") {
    if (!/PRIVATE KEY/.test(f.privateKey)) return { ok: false, problems: ["That does not look like a private key. Paste the whole text, including the BEGIN and END lines."] };
    return { ok: true, value: { private_key: f.privateKey.trim(), ...(f.passphrase ? { passphrase: f.passphrase } : {}) } };
  }
  try {
    const j = JSON.parse(f.serviceAccountJson) as { client_email?: unknown; private_key?: unknown };
    if (typeof j.client_email !== "string" || typeof j.private_key !== "string") throw new Error("shape");
  } catch {
    return { ok: false, problems: ["That is not a service-account key file. Paste the whole JSON file that Google gives you."] };
  }
  return { ok: true, value: { service_account_json: f.serviceAccountJson.trim() } };
}

/** The form for a stored source (the inverse of buildWarehouseConfig). Credentials are never sent back, so they are empty. */
export function warehouseFormFromConfig(config: Record<string, unknown>): WarehouseForm {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const w: Warehouse = config.warehouse === "snowflake" || config.warehouse === "bigquery" ? config.warehouse : "postgres";
  const base = emptyWarehouseForm(w);
  const traits = config.trait_columns && typeof config.trait_columns === "object" ? Object.entries(config.trait_columns as Record<string, unknown>).map(([name, column]) => ({ name, column: str(column) })) : [];
  return {
    ...base,
    host: str(config.host),
    port: typeof config.port === "number" ? String(config.port) : base.port,
    database: str(config.database),
    user: str(config.user),
    sslMode: config.ssl_mode === "no-verify" || config.ssl_mode === "disable" ? config.ssl_mode : "verify",
    account: str(config.account),
    sfWarehouse: str(config.snowflake_warehouse),
    role: str(config.role),
    schema: str(config.schema),
    projectId: str(config.project_id),
    location: str(config.location),
    maxGb: typeof config.max_bytes_billed === "number" ? String(config.max_bytes_billed / 1_000_000_000) : base.maxGb,
    query: str(config.query) || base.query,
    cursorColumn: str(config.cursor_column) || base.cursorColumn,
    cursorType: config.cursor_type === "number" || config.cursor_type === "text" ? config.cursor_type : "timestamp",
    initialCursor: str(config.initial_cursor),
    intervalMinutes: typeof config.interval_minutes === "number" ? String(config.interval_minutes) : base.intervalMinutes,
    batchSize: typeof config.batch_size === "number" ? String(config.batch_size) : base.batchSize,
    userIdColumn: str(config.user_id_column),
    emailColumn: str(config.email_column),
    eventMode: typeof config.event_name_column === "string" ? "column" : typeof config.event_name === "string" ? "fixed" : "none",
    eventValue: str(config.event_name_column) || str(config.event_name),
    timestampColumn: str(config.timestamp_column),
    traits,
    sendProperties: config.send_properties !== false,
  };
}

/** "Every hour", "Every 15 minutes", "Every 2 hours". */
export function describeInterval(minutes: unknown): string {
  const m = typeof minutes === "number" ? minutes : 60;
  if (m % 1440 === 0) return m === 1440 ? "Every day" : `Every ${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
  return `Every ${m} minutes`;
}

export type SyncState = "never" | "running" | "ok" | "error" | "off";

export function syncState(s: { enabled: boolean; sync: { status: string | null; running: boolean } }): SyncState {
  if (s.sync.running) return "running";
  if (!s.enabled) return "off";
  if (s.sync.status === "ok") return "ok";
  if (s.sync.status === "error") return "error";
  return "never";
}

export const SYNC_STATE_LABEL: Record<SyncState, string> = { never: "Not run yet", running: "Running", ok: "Up to date", error: "Failing", off: "Off" };

/** What the credential field is called for each warehouse. */
export const CREDENTIAL_HELP: Record<Warehouse, string> = {
  postgres: "Use a read-only user. Loomail only ever reads, inside a read-only transaction, but a read-only user means the database enforces it too.",
  snowflake: "Key-pair sign-in. Create a key pair, run ALTER USER <name> SET RSA_PUBLIC_KEY='...' in Snowflake with the public half, and paste the private half here. Use a role that can only SELECT.",
  bigquery: "Create a service account, give it BigQuery Job User on the project and BigQuery Data Viewer on the dataset, create a JSON key for it and paste the whole file here.",
};
