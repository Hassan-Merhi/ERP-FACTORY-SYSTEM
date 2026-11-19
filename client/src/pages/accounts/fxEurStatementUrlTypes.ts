// Extracted from ./fxEurStatementUrl.tsx

interface EurOperation {
  id: number;
  date: string;
  kind: string;
  description: string;
  detail: string;
  eurIn: string;
  eurOut: string;
  balance: string;
  rateUsdPerEur: string;
  voucherId: number | null;
  deleted?: boolean;
}

export interface EurStatement {
  accountName: string;
  activatedOn: string;
  fromDate: string | null;
  toDate: string;
  openingEur: string;
  totalEurIn: string;
  totalEurOut: string;
  closingEur: string;
  rows: EurOperation[];
}
