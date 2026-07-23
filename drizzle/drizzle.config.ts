/**
 * Drizzle configuration for community schema.
 * This config governs the public/community tables only.
 * Private sub-schemas (brain-cloud, billing) have their own configs.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./schema/*",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://claros:claros@localhost:5432/claros",
  },
});
