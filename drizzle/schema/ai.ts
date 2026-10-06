import { pgTable, uuid, text, boolean, integer, bigint, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

/**
 * The operator's own AI provider ("Mailforge AI"), shared by every workspace
 * that has not saved a key of its own. Set in the platform admin console.
 *
 * Two slots: `primary` is used first; `fallback` is tried when the primary
 * fails (network error, rate limit, provider outage, a bad or empty key).
 * `enabled = false` is the kill switch: the slot is skipped without deleting
 * its key. Not tenant data, so it is not exported or erased with a workspace.
 *
 * `config` is the same encrypted envelope as llm_configs.config:
 * { apiKey, baseUrl, model, embedding_model? }.
 *
 * Mirror side: PUBLIC (drizzle/ is mirrored).
 */
export const platformLlmConfigs = pgTable(
  "platform_llm_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** primary | fallback */
    slot: text("slot").notNull(),
    provider: text("provider").notNull(),
    config: text("config").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Email of the platform admin who last saved it. */
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_platform_llm_slot").on(t.slot)],
);

/**
 * One row per AI call a workspace's work made: what it was for, where it was
 * served from, and how many tokens it used. Feeds the monthly allowance, the
 * customer's usage meter and the operator's usage view. Never holds prompts or
 * replies, only counts.
 */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** compile | content | ai_draft | embedding */
    feature: text("feature").notNull(),
    /** byok | platform */
    source: text("source").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    /**
     * What the call cost the operator, in millionths of a US dollar (so 1,000,000 = $1).
     * Only calls on the operator's provider have one, and only when prices were set on it.
     */
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    /** false when the call failed (tokens are then 0). */
    ok: boolean("ok").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_llm_usage_tenant_created").on(t.tenantId, t.createdAt),
    index("idx_llm_usage_source_created").on(t.source, t.createdAt),
  ],
);

/**
 * Remembers which operator alerts have been sent, so one outage sends one email
 * (then a reminder after a cooldown) rather than one every few minutes.
 */
export const platformAlertState = pgTable("platform_alert_state", {
  /** e.g. "ai_failure_rate" */
  key: text("key").primaryKey(),
  /** True while the problem is ongoing; cleared when it recovers so the next one alerts again. */
  active: boolean("active").notNull().default(false),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Operator-wide settings that are not tied to a workspace, set from the admin
 * console. Today: key "ai_budget_usd", value { monthly_usd: number } (absent =
 * no budget). Not tenant data, so it is not exported or erased with a workspace.
 */
export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
