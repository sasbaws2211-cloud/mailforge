import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

// pgvector column type - vector(1536) for OpenAI-compatible embeddings
const vector1536 = customType<{ data: number[]; driverParam: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: unknown): number[] {
    const str = value as string;
    return str
      .slice(1, -1)
      .split(",")
      .map(Number);
  },
});

export const kbEntries = pgTable(
  "kb_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    title: text("title").notNull(),
    content: text("content").notNull(),
    contentType: text("content_type").default("markdown"), // markdown|html|text
    source: text("source").default("manual"), // manual|crawl|upload
    sourceUrl: text("source_url"), // for crawled content
    tags: text("tags").array(),
    embedding: vector1536("embedding"),
    // [impl] task 22: embedding lifecycle state tracking.
    // Mirrors the compile_status/compile_error pattern on the flows table.
    // null = never enqueued; 'pending' = job enqueued, not yet written;
    // 'failed' = permanently failed (dimensionality mismatch, bad model, etc.)
    // 'failed' entries carry the reason in embedding_error.
    // When embedding is non-NULL, embedding_status is implicitly 'done' (no column
    // needed: the vector itself is the evidence).
    embeddingStatus: text("embedding_status"), // null|pending|failed
    embeddingError: text("embedding_error"),   // human-readable reason when failed
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    // IVFFlat index for semantic search.
    // Note: IVFFlat requires rows for training. See BACKLOG.md for reindex strategy.
    index("idx_kb_embedding").using(
      "ivfflat",
      table.embedding.op("vector_cosine_ops")
    ),
  ]
);
