// Extracted from ./_helpers.ts
import { summarizeAccountStatementCurrency } from "../../services/accounting/accountStatementCurrency";
import type { NotInLedgerSection } from "../../services/accounting/balances/customerLedgerStatement";

export type AccountKind = "ledger" | "bank" | "fixed-asset" | "supplier" | "employee";

export type DateContext = {
  rawStart?: string;
  /** The requested end date; undefined lists everything posted (wave 17 A, statementWindow.ts). */
  effectiveEndDate: string | undefined;
  asOfDate: string;
  /** The server's business date: lines dated after it are flagged `futureDated`. */
  businessDate: string;
};

export interface Pagination {
  page: number;
  limit: number;
  offset: number;
}

export interface ContinuousWindow {
  limit: number;
  token?: string;
}

export type ContinuousStatementMeta = {
  total: number;
  periodDebitTotal: number;
  periodCreditTotal: number;
  prePeriodNet: number;
};

export type VoucherEntryCursor = {
  sortDate: string;
  sortId: number;
  sortEntryId?: number;
  net: number;
  meta: ContinuousStatementMeta;
};

export type CustomerCursor = {
  sortDate: string;
  sortId: number;
  net: number;
  meta: ContinuousStatementMeta;
};

export type StatementSummary = {
  total?: unknown;
  debitTotal?: unknown;
  creditTotal?: unknown;
};

export type StatementQueryResult = {
  rows: Record<string, unknown>[];
};

export interface StatementPage {
  /** Present when a ledger is customer-owned (or the endpoint is a customer). */
  customerId?: number;
  transactions: unknown[];
  currencySummary: ReturnType<typeof summarizeAccountStatementCurrency>;
  preNetBalance: number;
  periodPreNetBalance: number;
  periodDebitTotal: number;
  periodCreditTotal: number;
  closingNetBalance: number;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  asOfDate: string;
  startDate: string | null;
  /** Null when the statement lists everything posted (wave 17 A). */
  endDate: string | null;
  /** The server's business date; rows after it carry `futureDated: true`. */
  businessDate: string;
  continuous?: boolean;
  chunkOpeningNet?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
  /** Customer statements: amounts not yet in the ledger, never part of the rows or totals. */
  notInLedger?: NotInLedgerSection;
}
