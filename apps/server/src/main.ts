/**
 * Server entrypoint.
 *
 * Parses --role from argv, creates DB connection, runs startup migrations,
 * runs bootstrap seed check, then starts the appropriate services
 * (API, worker, scheduler).
 *
 * Mirror side: PUBLIC (apps/server is mirrored).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { buildApp } from "@claros/api";
import { tenants, users } from "@claros/db/schema";
import { eq } from "drizzle-orm";
import { createBoss, startWorker } from "@claros/worker";
import { startScheduler } from "@claros/scheduler";

const VALID_ROLES = ["all", "api", "worker", "scheduler"] as const;
type Role = (typeof VALID_ROLES)[number];

function parseRole(): Role {
  const raw = process.argv.find((a) => a.startsWith("--role="))?.split("=")[1] ?? "all";
  if (!VALID_ROLES.includes(raw as Role)) {
    console.error(`Invalid role: ${raw}. Valid: ${VALID_ROLES.join(", ")}`);
    process.exit(1);
  }
  return raw as Role;
}

const role = parseRole();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const edition = process.env.CLAROS_EDITION ?? "community";

/**
 * Bootstrap seed: ensure one default tenant and owner user exist on first boot.
 *
 * Idempotent at the database level: the entire operation runs inside a single
 * transaction. The tenant insert uses ON CONFLICT (slug) DO NOTHING - the
 * UNIQUE constraint on tenants.slug is the serialisation point. If N processes
 * call bootstrapSeed concurrently against an empty database, exactly one will
 * insert the tenant row; the others will receive an empty RETURNING result and
 * fall through to SELECT the winner's id. The user insert similarly uses
 * ON CONFLICT (tenant_id, email) DO NOTHING backed by uq_users_tenant_email.
 * All callers complete without error; exactly one tenant and one user exist.
 *
 * If the database already has any tenants the function returns immediately -
 * the SELECT and the transaction are both skipped.
 *
 * Called only on roles that serve HTTP (api, all). Worker and scheduler skip
 * this entirely - they have no login surface and need no seed tenant.
 */
async function bootstrapSeed(db: ReturnType<typeof drizzle>): Promise<void> {
  const seedEmail = process.env.SEED_ADMIN_EMAIL;
  if (!seedEmail || seedEmail.trim().length === 0) {
    // No seed configured - nothing to do on subsequent boots. On first boot
    // against an empty DB, the API will fail at login time, which is the
    // correct signal: "set SEED_ADMIN_EMAIL and restart."
    // We exit here only if the DB is actually empty, checked inside the tx.
    // But we cannot know that without a query, so we defer to the tx below.
    // If no email is set and no tenants exist, we log and exit after the check.
  }

  const normalizedEmail = seedEmail ? seedEmail.toLowerCase().trim() : null;

  await db.transaction(async (tx) => {
    // Fast-path: if any tenant exists, nothing to do.
    const existing = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .limit(1);
    if (existing.length > 0) return;

    // Empty database. Require SEED_ADMIN_EMAIL.
    if (!normalizedEmail) {
      console.error("");
      console.error("==========================================================");
      console.error("  ERROR: Database has no tenants and SEED_ADMIN_EMAIL is not set.");
      console.error("");
      console.error("  On first boot, set SEED_ADMIN_EMAIL in .env to create the");
      console.error("  default tenant and owner user. Example:");
      console.error("");
      console.error("    SEED_ADMIN_EMAIL='admin@example.com'");
      console.error("");
      console.error("  Then restart the server.");
      console.error("==========================================================");
      console.error("");
      process.exit(1);
    }

    // Attempt to insert the seed tenant. ON CONFLICT (slug) DO NOTHING means
    // exactly one of N concurrent callers inserts; the rest skip silently.
    const inserted = await tx
      .insert(tenants)
      .values({ name: "Default", slug: "default", plan: "free" })
      .onConflictDoNothing()
      .returning({ id: tenants.id });

    // Resolve the tenant id whether we inserted or lost the race.
    const tenantId =
      inserted.length > 0
        ? inserted[0]!.id
        : (
            await tx
              .select({ id: tenants.id })
              .from(tenants)
              .where(eq(tenants.slug, "default"))
              .limit(1)
          )[0]!.id;

    // Insert owner user. ON CONFLICT (tenant_id, email) DO NOTHING means the
    // loser that already found the tenant via SELECT also skips the user insert
    // safely if another process already inserted it.
    await tx
      .insert(users)
      .values({ tenantId, email: normalizedEmail, role: "owner" })
      .onConflictDoNothing();

    if (inserted.length > 0) {
      console.log("");
      console.log("=== Bootstrap Seed ===");
      console.log(`  Tenant ID : ${tenantId}`);
      console.log(`  Owner     : ${normalizedEmail}`);
      console.log("  Seed complete. You can now request a login link.");
      console.log("======================");
      console.log("");
    }
  });
}

async function start(): Promise<void> {
  // Create database connection
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

  // Auto-migrate: apply pending community schema migrations on startup.
  //
  // GATE: only runs when CLAROS_MIGRATE_ON_BOOT=true is explicitly set.
  // This is an opt-in, not an opt-out. The fail-safe direction is CLOSED:
  // if the variable is absent, empty, or any value other than the exact
  // string "true", migration does NOT run.
  //
  // Why this gate matters:
  //   Cloud deploys (Neon) must never have the container apply migrations
  //   autonomously. The expand-contract discipline, target confirmation,
  //   pooler rejection, and Umut-approval flow are all enforced by
  //   scripts/migrate.sh, not by this code path. Removing that control
  //   at scale (multiple pods booting concurrently against Neon) is a
  //   data integrity risk regardless of Drizzle's idempotency claim.
  //
  // Who sets it:
  //   docker/docker-compose.yml sets CLAROS_MIGRATE_ON_BOOT=true.
  //   Cloud deploy (wrangler) does not set it. Local .env can set it for
  //   pnpm dev convenience, but never ships to production.
  //
  // Cases:
  //   - local compose (CLAROS_MIGRATE_ON_BOOT=true):  migrate() runs.
  //   - Cloud production (var absent):                migrate() is skipped.
  //   - Signal absent or any other value:             migrate() is skipped.
  if (process.env.CLAROS_MIGRATE_ON_BOOT === "true") {
    // Migrations folder resolves relative to this compiled file so it
    // works inside the Docker image (/app/drizzle/migrations) and locally.
    // Compiled output: apps/server/dist/main.js - three levels up = repo root.
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const migrationsFolder = path.resolve(__dirname, "../../../drizzle/migrations");
    try {
      await migrate(db, { migrationsFolder });
      console.log("[migrate] community schema up to date");
    } catch (err) {
      console.error("[migrate] failed to apply migrations:", err);
      process.exit(1);
    }
  }

  // Warn (not fail) if ENCRYPTION_KEY is absent. The server can start and
  // serve the quickstart path without it. Flow compilation and LLM config
  // storage will fail at first use with a clear error message.
  if (!process.env.ENCRYPTION_KEY) {
    console.warn("[config] ENCRYPTION_KEY not set - LLM config storage and flow compilation will be unavailable until configured.");
  }

  // Bootstrap seed: only relevant for roles that serve HTTP (api, all).
  // Worker and scheduler have no login surface and no reason to know whether
  // a seed tenant exists. Running seed on every role also introduces a
  // startup race: multiple processes against an empty DB all read count=0
  // simultaneously and each inserts a tenant row, producing duplicates.
  if (role === "all" || role === "api") {
    await bootstrapSeed(db);
  }

  // pg-boss: every role needs at least one boss instance.
  // - role=all: one instance handles enqueue (API), work (worker), and schedule.
  // - role=api: a lightweight instance for enqueue only (no work, no schedule).
  // - role=worker: work handlers only (no schedule).
  // - role=scheduler: cron schedules only (no work).
  const boss = createBoss(databaseUrl, {
    schedule: role === "all" || role === "scheduler",
  });

  boss.on("error", (err) => {
    console.error("[pg-boss] error:", err);
  });

  await boss.start();
  console.log(`[pg-boss] started (role=${role}, schema=pgboss)`);

  // Enqueue function: wraps boss.send() for the API layer.
  const enqueue = async (
    queue: string,
    data: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): Promise<string | null> => {
    return boss.send(queue, data, opts ?? {});
  };

  // API roles: "all" and "api" start the HTTP server.
  if (role === "all" || role === "api") {
    const app = await buildApp({ role, edition, db, enqueue });

    try {
      await app.listen({ port, host });
      app.log.info(`Claros server started (role=${role}) on ${host}:${port}`);
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  }

  // Worker: register job handlers.
  if (role === "all" || role === "worker") {
    await startWorker(boss, db);
    console.log("[pg-boss] worker handlers registered");
  }

  // Scheduler: register cron schedules.
  if (role === "all" || role === "scheduler") {
    await startScheduler(boss);
    console.log("[pg-boss] cron schedules registered");
  }

  // Graceful shutdown: stop pg-boss when the process exits.
  const shutdown = async () => {
    console.log("[pg-boss] stopping...");
    await boss.stop({ graceful: true, timeout: 10000 });
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

start();
