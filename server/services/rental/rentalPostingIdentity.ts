/**
 * Rental payment identities (unified accounting Phase 2).
 *
 * Modern PG2 payment groups have one stable request identity plus a separate
 * fingerprint of the financial payload. A retried request reuses the group;
 * reusing the request key with different financial details is a conflict.
 * Legacy PG-* groups and voucher suffixes remain unchanged.
 */
import { createHash } from "node:crypto";

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function rentalPaymentGroupIdentity(input: {
  companyId: number;
  module: "ERP" | "FACTORY" | "PROPERTIES";
  contractId: number;
  requestId?: string | null;
  financialPayload: Record<string, unknown>;
}): { prefix: string | null; groupId: string | null } {
  const requestId = input.requestId?.trim() || null;
  if (!requestId) return { prefix: null, groupId: null };
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new Error(
      "RENTAL_PAYMENT_REQUEST_ID_INVALID: clientRequestId must be 1-128 letters, numbers, dots, underscores, colons or hyphens"
    );
  }
  const scope = JSON.stringify([input.companyId, input.module, input.contractId, requestId]);
  const prefix = `PG2-${createHash("sha256").update(scope).digest("hex").slice(0, 32)}-`;
  const payloadDigest = createHash("sha256").update(JSON.stringify(input.financialPayload)).digest("hex").slice(0, 20);
  return { prefix, groupId: prefix + payloadDigest };
}

/** Keep older voucher numbers (and their deletion lookups) byte-for-byte stable. */
export function rentalPaymentVoucherSuffix(groupId: string): string {
  return groupId.startsWith("PG2-") ? groupId.slice(-20) : groupId.slice(-6);
}
