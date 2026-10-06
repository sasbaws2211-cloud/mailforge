/**
 * Permanent erasure of one workspace.
 *
 * The set of tables is DISCOVERED from the database (every real table with a
 * tenant_id column) and ordered by foreign keys, children first, so a table added
 * by a later migration is erased too without anyone remembering to list it. A test
 * asserts that nothing carrying the tenant id survives.
 *
 * Two tables are kept on purpose, detached from the workspace:
 *   billing_events   payment records, kept for accounting. tenant_id is cleared.
 *   admin_audit_log  what operators did. tenant_id is cleared and the workspace
 *                    name and slug are written into each row so it stays readable.
 * Everything else, including sessions, keys, contacts, events, messages and the
 * workspace row itself, is deleted in one transaction: it all happens or none of it.
 * A small tombstone (deleted_workspaces) records that it happened.
 *
 * Mirror side: PUBLIC (drizzle/ is mirrored).
 */
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";

/** The little of a database handle this needs, so callers can pass their own Db type. */
export interface PurgeTx {
  execute(query: SQL): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface PurgeDb {
  transaction<T>(fn: (tx: PurgeTx) => Promise<T>): Promise<T>;
  execute(query: SQL): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** Tables whose rows outlive the workspace, detached from it. */
export const KEPT_DETACHED = ["billing_events", "admin_audit_log"] as const;

export type PurgeHow = "grace_expired" | "admin_immediate";

export interface PurgeResult {
  tenantId: string;
  name: string;
  slug: string;
  rowCounts: Record<string, number>;
}

/** Tables with a tenant_id, children before parents. Throws if the foreign keys form a cycle. */
export async function tenantTablesInDeleteOrder(tx: PurgeTx): Promise<string[]> {
  const tables = await tx.execute(sql`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
      AND c.relname <> 'tenants'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      )`);
  const names: string[] = tables.rows.map((r) => r.name as string);
  const set = new Set(names);

  const fks = await tx.execute(sql`
    SELECT child.relname AS child, parent.relname AS parent
    FROM pg_constraint k
    JOIN pg_class child ON child.oid = k.conrelid
    JOIN pg_class parent ON parent.oid = k.confrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    WHERE k.contype = 'f' AND n.nspname = 'public' AND child.oid <> parent.oid`);

  // A child must be deleted before its parent.
  const blockers = new Map<string, Set<string>>(names.map((t) => [t, new Set<string>()]));
  for (const { child, parent } of fks.rows as Array<{ child: string; parent: string }>) {
    if (set.has(child) && set.has(parent)) blockers.get(parent)!.add(child);
  }
  const order: string[] = [];
  const remaining = new Set(names);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((t) => [...blockers.get(t)!].every((c) => !remaining.has(c)));
    if (ready.length === 0) throw new Error(`purge: foreign key cycle among ${[...remaining].join(", ")}`);
    for (const t of ready.sort()) {
      order.push(t);
      remaining.delete(t);
    }
  }
  return order;
}

const ident = (name: string) => sql.raw(`"${name.replace(/"/g, '""')}"`);

/**
 * Erase a workspace. Returns null when it does not exist (already gone).
 * With `onlyIfDueAt`, does nothing unless the workspace is still scheduled and
 * due, so a cancelled request or a second worker cannot cause a deletion.
 */
export async function purgeWorkspace(
  db: PurgeDb,
  tenantId: string,
  how: PurgeHow,
  opts: { onlyIfDueAt?: Date } = {},
): Promise<PurgeResult | null> {
  return db.transaction(async (tx) => {
    const found = await tx.execute(sql`
      SELECT id, name, slug, plan, created_at, deletion_requested_at, deletion_scheduled_at,
             (SELECT u.email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' ORDER BY u.created_at LIMIT 1) AS owner_email
      FROM tenants t WHERE id = ${tenantId}::uuid FOR UPDATE`);
    const t = found.rows[0];
    if (!t) return null;
    if (opts.onlyIfDueAt) {
      const due = t.deletion_scheduled_at ? new Date(t.deletion_scheduled_at) : null;
      if (!due || due.getTime() > opts.onlyIfDueAt.getTime()) return null;
    }

    // Detach what must be kept.
    await tx.execute(sql`UPDATE billing_events SET tenant_id = NULL WHERE tenant_id = ${tenantId}::uuid`);
    await tx.execute(sql`
      UPDATE admin_audit_log
      SET tenant_id = NULL,
          detail = COALESCE(detail, '{}'::jsonb) || jsonb_build_object('workspace_name', ${t.name}::text, 'workspace_slug', ${t.slug}::text, 'workspace_deleted', true)
      WHERE tenant_id = ${tenantId}::uuid`);

    // A workspace's sending domain lives in the operator's Resend account, outside this database. Queue it
    // for removal (the queue has no tenant_id, so it survives the erase below) before its row goes.
    await tx.execute(sql`
      INSERT INTO managed_domain_cleanup (resend_domain_id, domain)
      SELECT resend_domain_id, domain FROM managed_sending
      WHERE tenant_id = ${tenantId}::uuid AND resend_domain_id IS NOT NULL
      ON CONFLICT (resend_domain_id) DO NOTHING`);

    const rowCounts: Record<string, number> = {};
    for (const table of await tenantTablesInDeleteOrder(tx)) {
      if ((KEPT_DETACHED as readonly string[]).includes(table)) continue;
      const r = await tx.execute(sql`DELETE FROM ${ident(table)} WHERE tenant_id = ${tenantId}::uuid`);
      if ((r.rowCount ?? 0) > 0) rowCounts[table] = r.rowCount!;
    }
    await tx.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}::uuid`);

    const ownerHash = t.owner_email ? createHash("sha256").update(String(t.owner_email).trim().toLowerCase()).digest("hex") : null;
    await tx.execute(sql`
      INSERT INTO deleted_workspaces (id, name, slug, owner_email_hash, plan, created_at, requested_at, how, row_counts)
      VALUES (${tenantId}::uuid, ${t.name}, ${t.slug}, ${ownerHash}, ${t.plan},
              ${t.created_at ? new Date(t.created_at).toISOString() : null}::timestamptz,
              ${t.deletion_requested_at ? new Date(t.deletion_requested_at).toISOString() : null}::timestamptz,
              ${how}, ${JSON.stringify(rowCounts)}::jsonb)`);
    return { tenantId, name: t.name as string, slug: t.slug as string, rowCounts };
  });
}

/** Erase every workspace whose grace period has run out. One failure does not stop the rest. */
export async function purgeDueWorkspaces(
  db: PurgeDb,
  now: Date = new Date(),
): Promise<{ purged: PurgeResult[]; failed: Array<{ tenantId: string; error: string }> }> {
  const due = await db.execute(sql`
    SELECT id FROM tenants WHERE deletion_scheduled_at IS NOT NULL AND deletion_scheduled_at <= ${now.toISOString()}::timestamptz
    ORDER BY deletion_scheduled_at LIMIT 20`);
  const purged: PurgeResult[] = [];
  const failed: Array<{ tenantId: string; error: string }> = [];
  for (const row of due.rows as Array<{ id: string }>) {
    try {
      const r = await purgeWorkspace(db, row.id, "grace_expired", { onlyIfDueAt: now });
      if (r) purged.push(r);
    } catch (err) {
      failed.push({ tenantId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { purged, failed };
}
