/**
 * Drizzle configuration for community schema.
 * This config governs the public/community tables only.
 * Private sub-schemas (brain-cloud, billing) have their own configs.
 *
 * For migrations: use `pnpm db:migrate`, which enforces DIRECT_DATABASE_URL
 * (a non-pooled connection) and prompts for confirmation before proceeding.
 * For generate, studio, check, and other commands: DATABASE_URL is sufficient.
 *
 * URL resolution order:
 *   1. DIRECT_DATABASE_URL - required for migrations, set by migrate.sh
 *   2. DATABASE_URL        - sufficient for all other drizzle-kit commands
 */
import { defineConfig } from "drizzle-kit";

const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "No database URL found. Set DATABASE_URL (or DIRECT_DATABASE_URL for migrations)."
  );
}

export default defineConfig({
  schema: "./drizzle/schema/*.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
});
