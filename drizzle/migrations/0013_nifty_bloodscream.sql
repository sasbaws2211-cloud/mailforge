-- Migration 0013: Replace case-sensitive suppression email index with case-insensitive
-- functional unique index keyed on lower(email).
--
-- Background: the L1 suppression gate queries suppressions.email with case-sensitive
-- equality against contacts.email. The identify path does not normalize email case,
-- so a contact stored as Alice@EXAMPLE.COM was not blocked by an import of
-- alice@example.com. This migration makes suppression case-insensitive.
--
-- Duplicate handling:
--   If two case variants of the same (tenant_id, email) are already stored
--   (e.g. 'alice@example.com' and 'Alice@Example.COM'), the new unique index
--   would conflict on insertion. We deduplicate first: for each
--   (tenant_id, lower(email)) group, keep the oldest row (lowest created_at)
--   and delete the newer duplicates. Oldest is kept because it is more likely
--   to represent the original suppression event. The deleted rows carry the
--   same semantic meaning (the address is suppressed) so no information is lost.
--
-- Step 1: Delete duplicate case variants, keeping the oldest per (tenant_id, lower(email)).
DELETE FROM suppressions
WHERE id NOT IN (
  SELECT DISTINCT ON (tenant_id, lower(email)) id
  FROM suppressions
  ORDER BY tenant_id, lower(email), created_at ASC
);
--> statement-breakpoint

-- Step 2: Drop the case-sensitive unique index.
DROP INDEX "uq_suppressions_tenant_email";
--> statement-breakpoint

-- Step 3: Create the case-insensitive functional unique index.
-- The index expression lower(email) must match the query expression used in
-- the L1 gate after this migration: lower(email) = lower($contactEmail).
-- Postgres can use the index for a query of the form
--   WHERE tenant_id = $1 AND lower(email) = lower($2)
-- because the index covers (tenant_id, lower(email)) and the query predicate
-- on the indexed expression is an equality.
CREATE UNIQUE INDEX "uq_suppressions_tenant_email_lower" ON "suppressions" (tenant_id, lower(email));
