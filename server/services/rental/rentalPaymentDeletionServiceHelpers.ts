// Extracted from ./rentalPaymentDeletionService.ts
import { type VoucherRetirementActor } from "../accounting/voucherRetirement";
import { rentalPaymentVoucherSuffix } from "./rentalPostingIdentity";

export type RentalModule = "PROPERTIES" | "ERP" | "FACTORY";

export interface DeleteRentalPaymentInput {
  companyId: number;
  module: RentalModule;
  paymentId: number;
  /** Phase 21 (B): the user deleting the payment, recorded on the transfer legs' retirement audit. */
  actor?: VoucherRetirementActor | null;
}

export interface DeleteRentalPaymentResult {
  found: boolean;
  paymentGroupId: string | null;
  deletedPaymentIds: number[];
  deletedCount: number;
}

/** Must remain identical to rentalPaymentPostingService.hashGroupId. */
export function hashPaymentGroupId(groupId: string): bigint {
  let hash = 5381n;
  for (let index = 0; index < groupId.length; index += 1) {
    hash = ((hash << 5n) + hash + BigInt(groupId.charCodeAt(index))) & 0xffffffffffffffffn;
  }
  if (hash > 9223372036854775807n) hash -= 18446744073709551616n;
  return hash;
}

export function recognitionVoucherNumber(paymentDate: string, paymentGroupId: string): string {
  return `ADV-REC-${paymentDate.replace(/-/g, "")}-${rentalPaymentVoucherSuffix(paymentGroupId)}`;
}
