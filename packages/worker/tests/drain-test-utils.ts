/**
 * drain-test-utils.ts
 *
 * Shared helpers for drain worker tests. The core export is makeDrainRunner,
 * which returns an isolated drain tick function scoped to a single test tenant.
 *
 * WHY ISOLATION IS REQUIRED
 * --------------------------
 * processDrainTick discovers tenants by querying ALL approved messages across
 * the database. When multiple test files run concurrently against the same
 * Postgres instance (the default with Vitest's parallel file execution), a
 * foreign test tenant's messages can enter this test's drain tick.
 *
 * Scoping only the transport resolver is insufficient. The resolver can return
 * null for foreign tenants, which causes their messages to be counted as
 * skippedNoTransport. But a foreign tenant that has transport configured in the
 * DB will resolve to a non-null adapter and then enter the pipeline. If that
 * tenant has no postal address, its messages increment skippedNoPostalAddress.
 * If it has transport AND postal address, its messages can inflate sent counts.
 * Any of these corrupts exact-count assertions.
 *
 * The fix: scope both the transport resolver AND the fetch batch to the test
 * tenant ID. With both scoped:
 *   - step 1 (tenant discovery) finds the foreign tenant
 *   - step 2 (transport resolution) returns non-null for the foreign tenant
 *   - step 3 (fetchBatch) receives the foreign tenant in tenantIds but the
 *     scoped wrapper filters it out before calling fetchDrainBatchSimple
 *   - zero foreign messages enter the processing loop
 *   - all count assertions reflect only this test's data
 *
 * USAGE
 * -----
 * const runDrain = makeDrainRunner(db, testTenantId, adapter);
 * const result = await runDrain(now);
 *
 * For tests that need to swap the adapter per call:
 * const runDrain = makeDrainRunner(db, testTenantId);
 * const result = await runDrain(now, { adapter });
 *
 * For tests that exercise the no-transport path (adapter = null), the scoped
 * fetch still applies: the tenant's own messages are correctly not claimed
 * because fetchDrainBatchSimple receives an empty tenantIds array after the
 * foreign-tenant filter runs (testTenantId is also excluded because the
 * resolver returned null for it). This matches the intended behavior.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { processDrainTick, fetchDrainBatchSimple } from "../src/drain.js";
import type { TransportAdapter } from "../src/transport.js";
import type { FetchDrainBatch, DrainTickResult } from "../src/drain.js";

// Db is not exported from drain.ts; mirror its inferred type here.
type Db = ReturnType<typeof drizzle>;

export interface DrainRunnerOpts {
  adapter?: TransportAdapter | null;
  batchLimit?: number;
  signingKey?: string | null;
  baseUrl?: string;
  isProduction?: boolean;
}

/**
 * Returns a drain tick function that is isolated to a single test tenant.
 *
 * Both the transport resolver and the fetch batch are scoped to tenantId.
 * No foreign test tenant's messages can enter the pipeline.
 *
 * @param db          - Drizzle database instance.
 * @param tenantId    - The test tenant to scope to.
 * @param adapter     - Default adapter to use (can be overridden per call).
 * @param signingKey  - Default unsubscribe signing key.
 * @param baseUrl     - Default base URL.
 */
export function makeDrainRunner(
  db: Db,
  tenantId: string,
  defaultAdapter: TransportAdapter | null = null,
  defaultSigningKey: string = "test-unsubscribe-signing-key-do-not-use",
  defaultBaseUrl: string = "http://localhost:3000",
): (now: Date, opts?: DrainRunnerOpts) => Promise<DrainTickResult> {
  return async function runDrain(now: Date, opts: DrainRunnerOpts = {}): Promise<DrainTickResult> {
    const adapter = "adapter" in opts ? opts.adapter ?? null : defaultAdapter;
    const signingKeyOverride =
      opts.signingKey === undefined ? defaultSigningKey : (opts.signingKey ?? undefined);
    const baseUrl = opts.baseUrl !== undefined ? opts.baseUrl : defaultBaseUrl;

    const resolver = async (tid: string): Promise<TransportAdapter | null> =>
      tid === tenantId ? adapter : null;

    // Scope the batch fetch to this tenant only.
    //
    // processDrainTick passes ALL tenants-with-transport into fetchBatch.
    // If a concurrent test has given its tenant a transport config, that tenant
    // will appear in tenantIds here. Without this filter it would claim the
    // concurrent test's messages, inflating candidatesFetched and any stat that
    // is incremented per-message (sent, skippedNoPostalAddress, etc.).
    const scopedFetch: FetchDrainBatch = (db, now, limit, tenantIds) =>
      fetchDrainBatchSimple(db, now, limit, tenantIds.filter((id) => id === tenantId));

    return processDrainTick(
      db,
      now,
      resolver,
      scopedFetch,
      opts.batchLimit ?? 50,
      baseUrl,
      signingKeyOverride,
      opts.isProduction,
    );
  };
}
