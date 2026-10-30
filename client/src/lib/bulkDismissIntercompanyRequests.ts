/**
 * Dismiss a list of visible intercompany requests through the existing
 * authorization-checked per-request API. A failed or already-processed item
 * must not prevent the remaining pending requests from being handled.
 */
export async function dismissIntercompanyRequestsInBatches(
  requestIds: readonly number[],
  dismissOne: (requestId: number) => Promise<unknown>,
): Promise<{ dismissed: number; failed: number }> {
  const ids = [...new Set(requestIds)].filter(id => Number.isSafeInteger(id) && id > 0);
  let dismissed = 0;
  let failed = 0;
  // Avoid flooding the app with many simultaneous writes.
  for (let offset = 0; offset < ids.length; offset += 4) {
    const settled = await Promise.allSettled(
      ids.slice(offset, offset + 4).map(id => dismissOne(id)),
    );
    for (const result of settled) {
      if (result.status === "fulfilled") dismissed += 1;
      else failed += 1;
    }
  }
  return { dismissed, failed };
}
