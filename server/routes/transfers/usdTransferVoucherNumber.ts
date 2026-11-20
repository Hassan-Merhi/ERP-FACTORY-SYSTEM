import { createHash } from "node:crypto";

/**
 * USD voucher number for one side of a transfer. The posting engine includes
 * voucherNumber in its request fingerprint, so a retry with the same
 * clientRequestId must rebuild the same number to replay instead of being
 * refused. Derived from clientRequestId the same way as the Kwacha numbers;
 * only a request without a clientRequestId (no retry identity) falls back to
 * the legacy timestamp.
 */
export function usdTransferVoucherNumber(prefix: string, clientRequestId: string | undefined, timestamp: number) {
  if (!clientRequestId) return `${prefix}-${timestamp}`;
  const digest = createHash("sha256").update(clientRequestId).digest("hex").slice(0, 24);
  return `${prefix}-${digest}`;
}
