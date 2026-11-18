// Extracted from ./OffloadDialog.tsx to keep that module under the source-size cap.
export interface AdditionalCharge {
  id: string;
  description: string;
  amount: string;
  ledgerAccountId: string;
}

export interface LedgerAccountOption {
  id: string | number;
  name: string;
}

export interface SpSetupAccountOption {
  id: string | number;
  subType: string;
  name?: string | null;
}

export interface SpSetupStatusData {
  spAccounts?: SpSetupAccountOption[];
}

export interface ParentAgentOption {
  ledger_account_id: string | number;
  account_name: string;
}

export interface ContainerCharge {
  amount?: string | number | null;
}

export interface ContainerOffloadData {
  charges?: ContainerCharge[];
}
