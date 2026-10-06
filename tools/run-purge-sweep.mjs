#!/usr/bin/env node
/**
 * Run the workspace-erasure sweep once, now: the same function the worker runs on its
 * hourly tick. Erases every workspace whose deletion date has passed.
 *
 *   docker compose exec -T app sh -c "cd /app/packages/worker && node --input-type=module" < tools/run-purge-sweep.mjs
 *
 * (Piped in because the tools folder is not mounted in the container, and it must run
 * from a package that can resolve @mailforge/db.) Needs DATABASE_URL, which the compose
 * app container already has. Prints what was erased. The worker does this by itself
 * every hour; this is for checking it, or for running it right after a legal request.
 */
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { purgeDueWorkspaces } from "@mailforge/db/purge";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const result = await purgeDueWorkspaces(drizzle(pool));
  for (const p of result.purged) console.log(`erased ${p.slug} (${p.tenantId}):`, JSON.stringify(p.rowCounts));
  for (const f of result.failed) console.error(`FAILED ${f.tenantId}: ${f.error}`);
  if (result.purged.length === 0 && result.failed.length === 0) console.log("nothing due");
  process.exitCode = result.failed.length > 0 ? 1 : 0;
} finally {
  await pool.end();
}
