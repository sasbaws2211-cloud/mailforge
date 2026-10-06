import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

/**
 * LLM provider credentials, encrypted at rest with ENCRYPTION_KEY.
 *
 * [impl] Added in task 11. BYO LLM key for flow compilation and content drafting.
 * Follows the transport_configs pattern: one active config per tenant.
 *
 * The `config` column stores an encrypted JSON envelope (see @mailforge/adapters crypto module).
 * Decrypted shape: { "apiKey": "sk-...", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o" }
 *
 * provider values: openai | anthropic | ollama | custom
 *   - "openai" and "anthropic" imply their standard base URLs if not overridden.
 *   - "ollama" implies http://localhost:11434/v1 if not overridden.
 *   - "custom" requires an explicit baseUrl.
 *   All providers use the OpenAI-compatible chat completions API shape.
 */
export const llmConfigs = pgTable("llm_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  provider: text("provider").notNull(), // openai|anthropic|ollama|custom
  config: text("config").notNull(), // encrypted JSON envelope (EncryptedEnvelope)
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
