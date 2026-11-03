import type { LedgerSplitFields } from "../factorycustomerstatement/NotInLedgerParts";

export interface Customer extends LedgerSplitFields {
  id: number;
  code: string;
  legalName: string;
  phone: string | null;
  openingBalance: string | null;
  openingBalanceSide: string | null;
  active: boolean;
  paymentTermsDays: number | null;
  /** Combined: ledger balance + amounts not yet in the ledger (see LedgerSplitFields). */
  balance?: number;
  balanceSide?: string;
}

/** Controlled values of the Add / Edit customer dialogs. */
export interface CustomerFormData {
  legalName: string;
  phone: string;
  openingBalance: string;
  openingBalanceSide: string;
  paymentTermsDays: string;
}
