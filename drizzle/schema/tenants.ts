import { pgTable, uuid, text, timestamp, jsonb, integer, boolean } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  plan: text("plan").default("free"), // trial|free|starter|growth|scale (see @loomail/core plans)
  /** End of the signup trial. Set only for tenants created through public signup. */
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  /**
   * When a paid plan runs out of paid time. Set by billing on every successful
   * charge. Null means the plan was granted by hand and never lapses. Once this
   * date plus the grace period has passed the workspace is entitled to Free.
   */
  planPaidThrough: timestamp("plan_paid_through", { withTimezone: true }),
  /**
   * Set by a platform admin to switch a workspace off (abuse, non-payment, request).
   * While set: nobody in the workspace can use the dashboard, the ingest API
   * refuses its keys, and nothing is sent. Nothing is deleted.
   */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedReason: text("suspended_reason"),
  /**
   * Set when the owner (or a platform admin) asks to delete the workspace. The
   * workspace stops sending and accepting data at once, and everything is erased
   * for good at deletion_scheduled_at unless the request is cancelled first.
   */
  deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
  deletionScheduledAt: timestamp("deletion_scheduled_at", { withTimezone: true }),
  /** Email of whoever asked (the owner, or the platform admin acting for them). */
  deletionRequestedBy: text("deletion_requested_by"),
  /**
   * Set by a platform admin to give this workspace its own monthly Loomail AI token
   * allowance instead of the plan's. Null = use the plan's. A negative number = no cap.
   * Only has an effect when plan enforcement is on.
   */
  aiAllowanceOverride: integer("ai_allowance_override"),
  /**
   * Set by a platform admin once a workspace has asked for warehouse sources (Postgres, MySQL, SQL Server pulled on a schedule) through
   * Support. Off by default: a warehouse can mean a lot of data and may need its own pricing or database. While off, the workspace
   * cannot create, test or run a warehouse source, and none of its existing ones sync.
   */
  warehouseAccess: boolean("warehouse_access").notNull().default(false),
  settings: jsonb("settings"), // all tenant config (throttle, lifecycle, etc.)
  businessModel: text("business_model"), // preview_free|freemium|time_limited_trial
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
