/**
 * Database plugin - decorates the Fastify instance with a Drizzle DB client.
 *
 * The Drizzle instance is created externally (by apps/server) and passed
 * to buildApp as an option. This plugin simply decorates it so routes
 * and hooks can access it via `app.db`.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type Db = NodePgDatabase<Record<string, never>>;

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
}

/**
 * Decorate the Fastify instance with the drizzle DB client.
 * Must be called on the root instance before route registration.
 */
export function registerDbPlugin(app: FastifyInstance, db: Db): void {
  app.decorate("db", db);
}
