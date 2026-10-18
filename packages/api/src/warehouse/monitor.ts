/**
 * Runs due warehouse sources inside the server, once a minute. Does nothing when there are none.
 *
 * Several servers can run this at once: each source is claimed with a lease before it is read, so only one wins.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { Db } from "../plugins/db.js";
import { syncDueSources, type SyncDeps } from "./sync.js";

export function startWarehouseSyncMonitor(
  db: Db,
  enqueue: SyncDeps["enqueue"],
  opts: { log?: SyncDeps["log"]; intervalMs?: number; firstCheckMs?: number } = {},
): () => void {
  let busy = false;
  const tick = () => {
    if (busy) return; // a slow warehouse must not stack runs up
    busy = true;
    syncDueSources(db, { enqueue, ...(opts.log ? { log: opts.log } : {}) })
      .catch((err) => opts.log?.error({ err }, "[warehouse] sync tick failed"))
      .finally(() => {
        busy = false;
      });
  };
  const first = setTimeout(tick, opts.firstCheckMs ?? 30_000);
  const every = setInterval(tick, opts.intervalMs ?? 60_000);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
