import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";

/**
 * Segments: saved groups of contacts, described by rules (see core's segment.ts).
 *
 * A segment stores its DEFINITION. Who is in it is worked out from the rules when needed, so there is no
 * membership table to keep in sync. member_count is a cache of the last count, refreshed when the segment
 * is saved or viewed; it can be stale and is shown with the time it was counted.
 *
 * Archived segments are kept (a flow that used one still reads its name) but cannot be picked again, and
 * their name can be reused.
 */
export const segments = pgTable(
  "segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    description: text("description"),
    /** The rules: a SegmentDefinition, validated by the API before it is stored. */
    definition: jsonb("definition").notNull(),
    /** Last counted size, and when. Null until first counted. */
    memberCount: integer("member_count"),
    /** True when the count stopped at the counting limit, so the real size is at least member_count. */
    countCapped: boolean("count_capped").notNull().default(false),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    // One live segment per name in a workspace; an archived one frees its name.
    uniqueIndex("uq_segments_tenant_name").on(table.tenantId, table.name).where(sql`archived_at IS NULL`),
    index("idx_segments_tenant").on(table.tenantId, table.createdAt),
  ],
);
