// ── Bulk-run dedup guard ──────────────────────────────────────────────────────
// Prevents two "Track All Now" runs from overlapping.  The flag is cleared as
// soon as the background loop finishes (or errors out).

// ── Bulk-run progress tracking ────────────────────────────────────────────────
export type BulkTrackingProgress = {
  running: boolean;
  total: number;
  processed: number;
  current: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

const _bulkProgress: BulkTrackingProgress = {
  running: false,
  total: 0,
  processed: 0,
  current: null,
  startedAt: null,
  completedAt: null,
};

/** Returns a snapshot of the current bulk-tracking progress. */
export function getBulkProgress(): BulkTrackingProgress {
  return { ..._bulkProgress };
}

/**
 * Manually trigger tracking for a single container by ID.
 * Used by the "Track Now" API endpoint.
 *
 * Rejects:
 *   - inactive containers (any casing of Offloaded/Closed/Completed)
 *   - exhausted ParcelsApp quota (when ParcelsApp would be the only provider)
 *
 * Allows with warning if quota is low but remaining > 0.
 */
