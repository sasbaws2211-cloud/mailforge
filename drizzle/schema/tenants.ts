import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  plan: text("plan").default("free"), // free|pro|enterprise
  settings: jsonb("settings"), // all tenant config (throttle, lifecycle, etc.)
  businessModel: text("business_model"), // preview_free|freemium|time_limited_trial
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
