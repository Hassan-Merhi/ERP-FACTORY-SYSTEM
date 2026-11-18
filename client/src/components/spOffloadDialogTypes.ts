// Extracted from ./SpOffloadDialog.tsx to keep that module under the source-size cap.
export interface ChargeLine {
  chargeType: string;
  description: string;
  amountUsd: string;
  prepaidChargeId: string;
  creditBankAccountId: string;
  creditLedgerAccountId: string;
  parentAgentAccountId: string;
}

export interface SpContainerLine {
  qty?: string | number | null;
  unitRateUsd?: string | number | null;
}

export interface SpPrepaidCharge {
  id: string | number;
  chargeType: string;
  amountPaidUsd: string | number;
}

export interface SpOffloadContainer {
  id: number;
  supplierName?: string | null;
  containerNumber?: string | null;
  invoiceNumber?: string | null;
  discountPct?: string | number | null;
  invoiceTotalUsd?: string | number | null;
  freightEstimateUsd?: string | number | null;
  surchargeUsd?: string | number | null;
  fumigationUsd?: string | number | null;
  documentChargesUsd?: string | number | null;
  lines?: SpContainerLine[];
  prepaid?: SpPrepaidCharge[];
}

export interface SpSetupAccount {
  id: string | number;
  subType: string;
  name?: string | null;
}

export interface SpBankAccount {
  id: string | number;
  bankName: string;
}

export interface SpSetupStatus {
  spAccounts?: SpSetupAccount[];
  bankAccounts?: SpBankAccount[];
}

export interface SpLedgerAccount {
  id: string | number;
  code?: string | null;
  name: string;
}

export interface SpLocationOption {
  id: string | number;
  name: string;
}

export interface ParentAgentOption {
  ledger_account_id: string | number;
  account_name: string;
}
