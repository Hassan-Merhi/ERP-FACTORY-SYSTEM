// Extracted from ./IntercompanyLinks.tsx to keep that module under the source-size cap.

export interface ICLink {
  id: number;
  label: string | null;
  sourceCompanyId: number;
  sourceCompanyName: string;
  sourceLedgerAccountId: number;
  sourceLedgerName: string;
  destCompanyId: number;
  destCompanyName: string;
  destLedgerAccountId: number;
  destLedgerName: string;
  active: boolean;
  createdAt: string;
}

export interface ICRecipient {
  id: number;
  userId: string;
  username: string | null;
}

export interface Company {
  id: number;
  name: string;
}

export interface LedgerAccount {
  id: number;
  name: string;
  companyId: number;
}

export interface User {
  id: string;
  username: string;
}

export const EMPTY_FORM = {
  label: "",
  sourceCompanyId: "",
  sourceLedgerAccountId: "",
  destCompanyId: "",
  destLedgerAccountId: "",
};
