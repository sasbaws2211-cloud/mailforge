/**
 * Full data export of one workspace, streamed as a single JSON document.
 *
 * Streamed in batches (keyset pagination by id) so a workspace with millions of
 * events never has to fit in memory. The result contains the customer's own data:
 * contacts, events, flows, messages, templates, knowledge base, suppressions,
 * team, plan and billing history.
 *
 * It never contains secrets: API key hashes, email provider and LLM credentials,
 * invite tokens, session ids, login tokens and knowledge-base embedding vectors
 * are left out. EXPORT_EXCLUDED lists the tenant tables deliberately not exported,
 * and a test fails if a new tenant table is in neither list.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { sql } from "drizzle-orm";
import type { Db } from "../plugins/db.js";

interface ExportTable {
  /** Key in the JSON document. */
  key: string;
  table: string;
  /** Columns removed from every row (secrets, tokens, vectors). */
  drop?: string[];
  /** Tables with no id column are read in one query, in this order. */
  orderBy?: string;
}

export const EXPORT_TABLES: readonly ExportTable[] = [
  { key: "team", table: "users", drop: ["pending_email", "pending_email_token_hash", "pending_email_expires_at"] },
  { key: "invites", table: "invites", drop: ["token_hash"] },
  { key: "contacts", table: "contacts" },
  { key: "events", table: "events" },
  { key: "lifecycle_transitions", table: "lifecycle_transitions" },
  { key: "contact_conflicts", table: "contact_conflicts" },
  { key: "retention_grid_snapshots", table: "retention_grid_snapshots", orderBy: "snapshot_date, tenure_bucket, recency_bucket" },
  { key: "flows", table: "flows" },
  { key: "flow_memberships", table: "flow_memberships" },
  { key: "messages", table: "lifecycle_messages" },
  { key: "message_events", table: "message_events" },
  { key: "email_templates", table: "templates" },
  { key: "knowledge_base", table: "kb_entries", drop: ["embedding"] },
  { key: "suppressions", table: "suppressions" },
  { key: "api_keys", table: "api_keys", drop: ["key_hash"] },
  { key: "email_transports", table: "transport_configs", drop: ["config"] },
  { key: "llm_providers", table: "llm_configs", drop: ["config"] },
  { key: "managed_sending", table: "managed_sending", orderBy: "created_at" },
  { key: "subscriptions", table: "subscriptions" },
  { key: "payment_attempts", table: "billing_checkouts", drop: ["checkout_url"] },
];

/** Tenant tables not exported on purpose, with the reason. */
export const EXPORT_EXCLUDED: Readonly<Record<string, string>> = {
  sessions: "sign-in sessions: credentials, not customer data",
  magic_link_tokens: "sign-in tokens: credentials, not customer data",
  scan_checkpoints: "internal bookkeeping for background jobs",
  billing_events: "operator-side payment log, kept by the service for accounting",
  admin_audit_log: "operator-side record of admin actions, kept by the service",
  llm_usage: "operator-side AI usage metering (token counts only, no prompts or replies); erased with the workspace",
};

const BATCH = 1000;
const ident = (name: string) => sql.raw(`"${name.replace(/"/g, '""')}"`);
const dropList = (drop: string[] | undefined) =>
  drop && drop.length > 0 ? sql`- ARRAY[${sql.join(drop.map((d) => sql`${d}::text`), sql`, `)}]` : sql``;

async function* rowsOf(db: Db, tenantId: string, t: ExportTable): AsyncGenerator<string> {
  const table = ident(t.table);
  if (t.orderBy) {
    const r = await db.execute<{ row: unknown }>(
      sql`SELECT to_jsonb(x) ${dropList(t.drop)} AS row FROM ${table} x WHERE tenant_id = ${tenantId}::uuid ORDER BY ${sql.raw(t.orderBy)}`,
    );
    for (const row of r.rows) yield JSON.stringify(row.row);
    return;
  }
  let last: string | null = null;
  for (;;) {
    const r: { rows: Array<{ id: string; row: unknown }> } = await db.execute<{ id: string; row: unknown }>(sql`
      SELECT x.id::text AS id, to_jsonb(x) ${dropList(t.drop)} AS row
      FROM ${table} x
      WHERE x.tenant_id = ${tenantId}::uuid ${last === null ? sql`` : sql`AND x.id > ${last}::uuid`}
      ORDER BY x.id LIMIT ${BATCH}`);
    for (const row of r.rows) yield JSON.stringify(row.row);
    if (r.rows.length < BATCH) return;
    last = r.rows[r.rows.length - 1]!.id;
  }
}

/** The whole export as chunks of JSON text. Returns null when the workspace does not exist. */
export async function openWorkspaceExport(db: Db, tenantId: string, now: Date = new Date()): Promise<{ filename: string; chunks: AsyncGenerator<string> } | null> {
  const r = await db.execute<{ w: Record<string, unknown>; slug: string }>(sql`
    SELECT jsonb_build_object(
             'id', id, 'name', name, 'slug', slug, 'plan', plan, 'created_at', created_at,
             'trial_ends_at', trial_ends_at, 'plan_paid_through', plan_paid_through, 'settings', settings
           ) AS w, slug
    FROM tenants WHERE id = ${tenantId}::uuid`);
  const head = r.rows[0];
  if (!head) return null;

  async function* chunks(): AsyncGenerator<string> {
    yield `{"export_version":1,"exported_at":${JSON.stringify(now.toISOString())},`;
    yield `"about":${JSON.stringify(
      "All data held for this workspace. Left out on purpose: passwords and tokens (API key hashes, email and AI provider credentials, invite and sign-in tokens, sessions) and knowledge-base embedding vectors.",
    )},`;
    yield `"workspace":${JSON.stringify(head!.w)}`;
    for (const t of EXPORT_TABLES) {
      yield `,${JSON.stringify(t.key)}:[`;
      let first = true;
      for await (const row of rowsOf(db, tenantId, t)) {
        yield (first ? "" : ",") + row;
        first = false;
      }
      yield "]";
    }
    yield "}\n";
  }
  const stamp = now.toISOString().slice(0, 10);
  return { filename: `${head.slug}-export-${stamp}.json`, chunks: chunks() };
}
