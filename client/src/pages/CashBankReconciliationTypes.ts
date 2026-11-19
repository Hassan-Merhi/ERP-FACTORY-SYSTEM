// Extracted from ./CashBankReconciliation.tsx to keep that module under the source-size cap.

type Kind = "bank" | "ledger";

export type Account = { accountKind: Kind; accountId: number; name: string };

export type Statement = {
  id: number;
  currency: string;
  period_start: string;
  period_end: string;
  opening_balance: string;
  closing_balance: string;
  file_name: string;
  imported_at: string;
};

type Line = {
  id: number;
  rowNumber: number;
  date: string;
  amount: string;
  reference: string | null;
  description: string | null;
  matchId: number | null;
  reviewCategory: string | null;
  reviewNote: string | null;
  matchedEntryId: number | null;
  matchedVoucherNumber: string | null;
  matchedVoucherId: number | null;
  status: "matched" | "unmatched" | "stale";
};

export type BookEntry = {
  entryId: number;
  voucherId: number;
  voucherNumber: string;
  date: string;
  amount: string;
  currency: string;
  currencyVerified: boolean;
  eligible: boolean;
  matched: boolean;
  matchedToStatementId: number | null;
};

type Balances = {
  currency: string;
  statementOpening: string;
  statementClosing: string;
  statementMovement: string;
  bookOpening: string | null;
  bookClosing: string | null;
  bookVsStatementDifference: string | null;
  unclearedBook: string;
  unmatchedStatement: string;
  adjustedBook: string | null;
  residual: string | null;
  matched: number;
  unmatchedStatementCount: number;
  unclearedBookCount: number;
  openingVerified: boolean;
  unverifiedEntries: number;
  otherCurrencyEntries: number;
  reconcilable: boolean;
};

export type Detail = {
  statement: Statement;
  account: { name: string; kind: Kind; id: number; linkedLedgerId: number | null };
  lines: Line[];
  bookEntries: BookEntry[];
  balances: Balances;
};

export type Preview = {
  rowCount: number;
  calculatedClosing: string;
  suppliedClosing: string;
  balanced: boolean;
  lines: Array<{ transactionDate: string; signedAmount: string; reference: string | null }>;
};

export async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  const content = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(content.message ?? "Could not load reconciliation");
  return content as T;
}

export async function upload(path: string, body: FormData) {
  const response = await fetch(path, { method: "POST", body, credentials: "include" });
  const output = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(output.message ?? "Statement upload failed");
  return output;
}

export function fmt(value: string | null) {
  return value === null ? "Unverified" : value;
}

export function exact(a: string, b: string): boolean {
  const aa = Number(a),
    bb = Number(b);
  return Number.isFinite(aa) && Number.isFinite(bb) && Math.abs(aa - bb) < 0.0000005;
}
