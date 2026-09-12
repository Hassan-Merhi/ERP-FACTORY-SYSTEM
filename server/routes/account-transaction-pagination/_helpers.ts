import type { Request, Response } from "express";
import { getClientDate } from "../../lib/dateUtils";
import { summarizeAccountStatementCurrency } from "../../services/accounting/accountStatementCurrency";

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 250;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type AccountKind = "ledger" | "bank" | "fixed-asset" | "supplier" | "employee";

export type DateContext = {
  rawStart?: string;
  effectiveEndDate: string;
  asOfDate: string;
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

export type FactoryCustomerCursor = {
  sortDate: string;
  voucherNumber: string;
  sourceRank: number;
  sourceId: number;
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
  endDate: string;
  continuous?: boolean;
  chunkOpeningNet?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
}

export function wantsContinuous(req: Request): boolean {
  return req.query.continuous === "1" || typeof req.query.cursor === "string";
}

export function wantsPagination(req: Request): boolean {
  return (
    wantsContinuous(req) ||
    req.query.pagination === "1" ||
    req.query.page !== undefined ||
    req.query.limit !== undefined ||
    req.query.pageSize !== undefined ||
    req.query.offset !== undefined
  );
}

export function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parsePagination(req: Request): Pagination {
  const limit = Math.min(MAX_PAGE_SIZE, parsePositiveInt(req.query.limit ?? req.query.pageSize, DEFAULT_PAGE_SIZE));
  if (req.query.offset !== undefined) {
    const offset = Math.max(0, Number.parseInt(String(req.query.offset), 10) || 0);
    return { page: Math.floor(offset / limit) + 1, limit, offset };
  }
  const page = parsePositiveInt(req.query.page, 1);
  return { page, limit, offset: (page - 1) * limit };
}

export function parseContinuousWindow(req: Request): ContinuousWindow | undefined {
  if (!wantsContinuous(req)) return undefined;
  const token = typeof req.query.cursor === "string" && req.query.cursor.trim() ? req.query.cursor.trim() : undefined;
  return {
    limit: Math.min(MAX_PAGE_SIZE, parsePositiveInt(req.query.limit ?? req.query.pageSize, DEFAULT_PAGE_SIZE)),
    token,
  };
}

export function dateContext(req: Request): DateContext {
  const asOfDate = getClientDate(req);
  const rawStart =
    typeof req.query.startDate === "string" && ISO_DATE.test(req.query.startDate) ? req.query.startDate : undefined;
  const rawEnd =
    typeof req.query.endDate === "string" && ISO_DATE.test(req.query.endDate) ? req.query.endDate : undefined;
  const effectiveEndDate = rawEnd && rawEnd < asOfDate ? rawEnd : asOfDate;
  return { rawStart, effectiveEndDate, asOfDate };
}

export function exposePaginationHeaders(res: Response, page: StatementPage): void {
  res.setHeader("X-Total-Count", String(page.total));
  res.setHeader("X-Page", String(page.page));
  res.setHeader("X-Page-Size", String(page.limit));
  res.setHeader("X-Total-Pages", String(page.totalPages));
  res.setHeader("Access-Control-Expose-Headers", "X-Total-Count, X-Page, X-Page-Size, X-Total-Pages");
}

export function statementSummaryNumbers(summary: StatementSummary | null | undefined): {
  total: number;
  periodDebitTotal: number;
  periodCreditTotal: number;
} {
  return {
    total: Number(summary?.total ?? 0) || 0,
    periodDebitTotal: Number.parseFloat(String(summary?.debitTotal ?? "0")) || 0,
    periodCreditTotal: Number.parseFloat(String(summary?.creditTotal ?? "0")) || 0,
  };
}

export function continuousMeta(
  summary: StatementSummary | null | undefined,
  prePeriodNet: number
): ContinuousStatementMeta {
  const { total, periodDebitTotal, periodCreditTotal } = statementSummaryNumbers(summary);
  return { total, periodDebitTotal, periodCreditTotal, prePeriodNet };
}

export function summaryFromContinuousMeta(meta: ContinuousStatementMeta): StatementSummary {
  return {
    total: meta.total,
    debitTotal: meta.periodDebitTotal,
    creditTotal: meta.periodCreditTotal,
  };
}

export function isContinuousStatementMeta(value: unknown): value is ContinuousStatementMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Partial<ContinuousStatementMeta>;
  return (
    Number.isInteger(meta.total) &&
    Number(meta.total) >= 0 &&
    Number.isFinite(meta.periodDebitTotal) &&
    Number.isFinite(meta.periodCreditTotal) &&
    Number.isFinite(meta.prePeriodNet)
  );
}

export function statementRowNet(row: unknown): number {
  if (!row || typeof row !== "object") return 0;
  const record = row as Record<string, unknown>;
  const debit = Number.parseFloat(String(record.debitAmount ?? "0")) || 0;
  const credit = Number.parseFloat(String(record.creditAmount ?? "0")) || 0;
  return debit - credit;
}

export function buildPageResponse(
  rows: unknown[],
  summary: StatementSummary | null | undefined,
  precedingPageNet: number,
  prePeriodNet: number,
  pagination: Pagination,
  dates: DateContext
): StatementPage {
  const { total, periodDebitTotal, periodCreditTotal } = statementSummaryNumbers(summary);
  const totalPages = total === 0 ? 0 : Math.ceil(total / pagination.limit);
  return {
    transactions: rows,
    currencySummary: summarizeAccountStatementCurrency(rows),
    // This is the opening balance for the selected page. The frontend adds the
    // account master opening balance separately, exactly as it did before paging.
    preNetBalance: prePeriodNet + precedingPageNet,
    periodPreNetBalance: prePeriodNet,
    periodDebitTotal,
    periodCreditTotal,
    closingNetBalance: prePeriodNet + periodDebitTotal - periodCreditTotal,
    total,
    page: pagination.page,
    limit: pagination.limit,
    totalPages,
    hasNextPage: pagination.page < totalPages,
    hasPreviousPage: pagination.page > 1 && totalPages > 0,
    asOfDate: dates.asOfDate,
    startDate: dates.rawStart ?? null,
    endDate: dates.effectiveEndDate,
  };
}

export function buildContinuousResponse(options: {
  rows: unknown[];
  summary: StatementSummary | null | undefined;
  prePeriodNet: number;
  previousChunkNet: number;
  limit: number;
  dates: DateContext;
  hadCursor: boolean;
  hasMore: boolean;
  nextCursor: string | null;
}): StatementPage {
  const { rows, summary, prePeriodNet, previousChunkNet, limit, dates, hadCursor, hasMore, nextCursor } = options;
  const { total, periodDebitTotal, periodCreditTotal } = statementSummaryNumbers(summary);
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  const chunkOpeningNet = prePeriodNet + previousChunkNet;
  return {
    transactions: rows,
    currencySummary: summarizeAccountStatementCurrency(rows),
    preNetBalance: chunkOpeningNet,
    periodPreNetBalance: prePeriodNet,
    periodDebitTotal,
    periodCreditTotal,
    closingNetBalance: prePeriodNet + periodDebitTotal - periodCreditTotal,
    total,
    page: 1,
    limit,
    totalPages,
    hasNextPage: hasMore,
    hasPreviousPage: hadCursor,
    asOfDate: dates.asOfDate,
    startDate: dates.rawStart ?? null,
    endDate: dates.effectiveEndDate,
    continuous: true,
    chunkOpeningNet,
    hasMore,
    nextCursor,
  };
}

export function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function cursorDate(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value ?? "").slice(0, 10);
  return ISO_DATE.test(text) ? text : null;
}

export function isVoucherEntryCursor(value: unknown, kind: AccountKind): value is VoucherEntryCursor {
  if (!value || typeof value !== "object") return false;
  const cursor = value as Partial<VoucherEntryCursor>;
  return (
    typeof cursor.sortDate === "string" &&
    ISO_DATE.test(cursor.sortDate) &&
    Number.isInteger(cursor.sortId) &&
    Number.isFinite(cursor.net) &&
    isContinuousStatementMeta(cursor.meta) &&
    (kind === "ledger" || Number.isInteger(cursor.sortEntryId))
  );
}

export function isCustomerCursor(value: unknown): value is CustomerCursor {
  if (!value || typeof value !== "object") return false;
  const cursor = value as Partial<CustomerCursor>;
  return (
    typeof cursor.sortDate === "string" &&
    ISO_DATE.test(cursor.sortDate) &&
    Number.isInteger(cursor.sortId) &&
    Number.isFinite(cursor.net) &&
    isContinuousStatementMeta(cursor.meta)
  );
}

export function isFactoryCustomerCursor(value: unknown): value is FactoryCustomerCursor {
  if (!value || typeof value !== "object") return false;
  const cursor = value as Partial<FactoryCustomerCursor>;
  return (
    typeof cursor.sortDate === "string" &&
    ISO_DATE.test(cursor.sortDate) &&
    typeof cursor.voucherNumber === "string" &&
    Number.isInteger(cursor.sourceRank) &&
    Number.isInteger(cursor.sourceId) &&
    Number.isFinite(cursor.net) &&
    isContinuousStatementMeta(cursor.meta)
  );
}
