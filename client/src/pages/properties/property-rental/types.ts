/**
 * Types for the PropertyRentalPage page.
 *
 * Extracted from PropertyRentalPage.tsx during the Phase 4 god-file split.
 */

export // ── Types ──────────────────────────────────────────────────
type Unit = {
  id: number;
  unitType: string;
  locationGroup: string;
  unitNumber: string;
  size: string | null;
  dimensions: string | null;
  notes: string | null;
  contract: Contract | null;
  outstanding: number | null;
  totalPaid?: number | null;
  scheduledAmount?: number | null;
  prepaidCredit?: number | null;
  billingDay?: number | null;
  nextBillingDate?: string | null;
  isShared?: boolean;
  ownerCompanyName?: string | null;
  guaranteeRemaining?: number | string | null;
};

export type Contract = {
  id: number;
  unitId: number;
  tenantName: string;
  guaranteePeriod: string | null;
  guaranteeAmount: string;
  guaranteePostedAmount: string | null;
  rentalAmount: string;
  startDate: string;
  status: string;
  notes: string | null;
  statementNote: string | null;
  guaranteePostedToStatement: boolean;
  isInternal: boolean;
  linkedCompanyId?: number | null;
  currency: string;
  guaranteeRemaining?: number | null;
};

export type CashAccount = { id: number; name: string; code: string; accountType: string };

export type LedgerRow = {
  id: number;
  year: number;
  month: number;
  expectedAmount: string;
  paidAmount: string;
  notes?: string | null;
  accrualVoucherId?: number | null;
  // FIX #7: backend-calculated fields from detail endpoint
  dueDate?: string;
  isDue?: boolean;
  expectedAsOf?: number;
  effectivePaidAmount?: number;
  /** All POSTED payments for this row regardless of payment_date — used by the statement PAID column. */
  allPostedPaid?: number;
  scheduledAmount?: number;
  outstanding?: number;
  prepaidCredit?: number;
  status?: "SCHEDULED" | "NOT_DUE" | "PREPAID" | "DUE" | "PARTIALLY_PAID" | "PAID" | "OVERPAID";
};

export type Payment = {
  id: number;
  amount: string;
  paymentDate: string;
  forYear: number;
  forMonth: number;
  cashAccountId: number | null;
  notes: string | null;
  postingStatus?: string;
  paymentGroupId?: string;
};

export // ── Props ──────────────────────────────────────────────────
interface Props {
  unitType: "WAREHOUSE" | "SHOP";
  pageTitle: string;
  pageIcon: React.ReactNode;
  testIdPrefix: string;
  apiBase?: string;
  paymentsLogUrl?: string;
}
