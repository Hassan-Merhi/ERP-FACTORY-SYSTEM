// Response shapes of the open-item reconciliation endpoints (moved out of AccountingOpenItems.tsx).
export type Domain = "customer" | "supplier" | "factory_supplier" | "rentals";
export interface Allocation {
  matchId: number;
  otherEntryId: number;
  amount: string;
}
export interface OpenItem {
  entryId: number;
  voucherId: number;
  voucherNumber: string;
  voucherType: string;
  businessDate: string;
  dueDate: string | null;
  overdueDays: number | null;
  side: "charge" | "settlement";
  currency: string;
  originalAmount: string;
  matchedAmount: string;
  outstandingAmount: string;
  currencyVerified: boolean;
  status: string;
  allocations: Allocation[];
}
export interface PartyView {
  items: OpenItem[];
  openingBalance: { amount: string; side: string | null; includedInMatching: false };
  currencies: Record<
    string,
    {
      charges: string;
      settlements: string;
      unapplied: string;
      outstanding: string;
    }
  >;
}
export interface RentalView {
  currency: string;
  items: Array<{
    year: number;
    month: number;
    dueDate: string;
    expectedAmount: string;
    paidAmount: string;
    outstandingAmount: string;
    status: string;
    paymentIds: number[];
  }>;
  totals: { expected: string; paidAgainstDue: string; outstanding: string; advanceForOtherMonths: string };
}
export type Result = PartyView | RentalView;
