// Extracted from ./costCenterHistoricalRoutes.ts
import type { Request } from "express";
import { z } from "zod";
import {
  HistoryError,
  MAX_ACCOUNT_FILTERS,
  accountFilter,
  idSchema,
  uuidPattern,
  windowDates,
  type SourceKind,
} from "./costCenterHistoricalRoutesSourceSql";

export function parseUuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value))
    throw new HistoryError(400, "Invalid historical preview ID");
  return value;
}

export function parseFilters(req: Request): {
  sourceKind: SourceKind;
  fromDate: string;
  toDate: string;
  ledgerAccountIds: number[] | null;
} {
  const sourceKind = req.query.sourceKind;
  if (sourceKind !== "VOUCHER_ENTRY" && sourceKind !== "FACTORY_DAYBOOK")
    throw new HistoryError(400, "Choose a historical source kind");
  if (typeof req.query.fromDate !== "string" || typeof req.query.toDate !== "string")
    throw new HistoryError(400, "Date range required");
  windowDates(req.query.fromDate, req.query.toDate);
  // ?ledgerAccountIds=1,2,3 (or the older single ?ledgerAccountId=1).
  const rawIds = [req.query.ledgerAccountIds, req.query.ledgerAccountId]
    .filter((v) => v !== undefined)
    .flatMap((v): unknown[] => (typeof v === "string" ? v.split(",") : [v]))
    .filter((v) => v !== "");
  const parsedIds = z.array(idSchema).max(MAX_ACCOUNT_FILTERS).safeParse(rawIds);
  if (!parsedIds.success) throw new HistoryError(400, "Invalid expense account filter");
  const ledgerAccountIds = accountFilter(parsedIds.data);
  if (sourceKind === "FACTORY_DAYBOOK" && ledgerAccountIds !== null)
    throw new HistoryError(400, "Factory daybook cannot be filtered by account");
  return { sourceKind, fromDate: req.query.fromDate, toDate: req.query.toDate, ledgerAccountIds };
}
