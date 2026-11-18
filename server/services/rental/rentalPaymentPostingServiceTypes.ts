// Extracted from ./rentalPaymentPostingService.ts to keep that module under the source-size cap.
import type { RentalModule } from "../../routes/rental/shared";

/** The rental contract fields this posting flow reads. */
export type RentalContractRef = {
  id: number;
  companyId: number;
  unitId: number;
  tenantName?: string | null;
  rentalAmount: string;
  startDate: string;
};

/** The rental unit fields this posting flow reads. */
export type RentalUnitRef = {
  unitNumber: string;
  unitType: string | null;
  locationGroup: string | null;
};

/** A posting failure that carries the HTTP status the route should return. */
export type RentalPostingError = Error & { status?: number };

export interface RentalPaymentGroupOptions {
  companyId: number;
  contractCompanyId: number;
  module: RentalModule;
  contract: RentalContractRef;
  unit: RentalUnitRef | null;
  cashAccountId: number | null;
  amount: string;
  paymentDate: string;
  clientDate: string;
  scheduleFuturePayment?: boolean;
  currency: string;
  exchangeRate: string;
  notes: string | null;
  shopExpenseAccountName: string;
  incomeAccountName: string;
  isSharedPayment?: boolean;
  /** Stable client identity for retries; omitted by legacy callers. */
  clientRequestId?: string | null;
  /** Phase 19 (B): the request's actor, audited with the posting. */
  audit?: { actor: { userId: string; username: string }; trigger: string };
}

/** Deterministic int64 advisory-lock key for a payment group ID. */
export function hashGroupId(groupId: string): bigint {
  let h = 5381n;
  for (let i = 0; i < groupId.length; i++) {
    h = ((h << 5n) + h + BigInt(groupId.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  if (h > 9223372036854775807n) h -= 18446744073709551616n;
  return h;
}
