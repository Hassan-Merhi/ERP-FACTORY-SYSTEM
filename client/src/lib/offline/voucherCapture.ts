import { offlineError } from "./offlineError";
import { db } from "../db";
import { queueOfflineOperation, deliverOfflineOperations } from "./durableOutbox";
import type { OfflineActor } from "./operationContract";

/**
 * One explicitly approved end-to-end write path. The original request is
 * persisted before the network attempt. No generic HTTP replay is permitted.
 * A queued write is never represented as a server-posted voucher.
 */
export async function submitDurableVoucherWithEntries(
  actor: OfflineActor,
  payload: unknown,
  clientDate: string
): Promise<Response> {
  const operation = await queueOfflineOperation({
    actor,
    mode: "erp",
    entityType: "voucher-with-entries",
    method: "POST",
    url: "/api/vouchers/with-entries",
    payload,
    clientDate,
  });

  await deliverOfflineOperations();
  const stored = await db.offlineOperations.get(operation.id);
  if (stored?.state === "acknowledged") {
    return new Response(stored.response ?? "{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (stored?.state === "conflict" || stored?.state === "rejected" || stored?.state === "needs_review") {
    const error = offlineError("OFFLINE_VOUCHER_REVIEW_REQUIRED");
    error.name = "OfflineOperationRejected";
    throw error;
  }
  const error = offlineError("OFFLINE_VOUCHER_PENDING");
  error.name = "OfflineQueued";
  throw error;
}
