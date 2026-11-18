// Extracted from ./costCenterHistoricalRoutes.ts to keep that module under the source-size cap.
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { logger } from "../lib/logger";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../services/security/activeCompanyPermissionContext";
import { sumMoney, toMoney } from "../lib/money";
import { reversalPairSql } from "./costCenterReportingRoutes";

export type SourceKind = "VOUCHER_ENTRY" | "FACTORY_DAYBOOK";

export type Entry = {
  sourceId: number;
  voucherId: number | null;
  voucherNumber: string | null;
  sourceDate: string;
  currency: string;
  amountNative: string;
  amountUsd: string;
  historicalRate: string | null;
  rateConvention: string | null;
  accountName: string;
  accountCode: string | null;
  sourceModule: string;
};

export type PlanSplit = { costCenterId: number; percent: string };

export type Plan = {
  sourceKind: SourceKind;
  fromDate: string;
  toDate: string;
  ledgerAccountIds: number[] | null;
  limit: number;
  splits: PlanSplit[];
  reason: string;
};

export type Actor = { companyId: number; userId: string; role: string; username: string };

export class HistoryError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const rolesRead = new Set(["Admin", "Owner", "Developer", "Manager"]);

const rolesWrite = new Set(["Admin", "Owner", "Developer"]);

export const idSchema = z.coerce.number().int().positive().max(2147483647);

const amountPattern = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/;

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export const HISTORICAL_BATCH_MAX = 10000;

export const MAX_ACCOUNT_FILTERS = 500;

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const previewBody = z
  .object({
    sourceKind: z.enum(["VOUCHER_ENTRY", "FACTORY_DAYBOOK"]),
    fromDate: z.string(),
    toDate: z.string(),
    // ledgerAccountId: single-account form kept for previews stored before
    // multi-account filters; new requests send ledgerAccountIds.
    ledgerAccountId: idSchema.nullable().optional(),
    ledgerAccountIds: z.array(idSchema).max(MAX_ACCOUNT_FILTERS).nullable().optional(),
    limit: z.number().int().min(1).max(HISTORICAL_BATCH_MAX).default(50),
    splits: z
      .array(
        z
          .object({
            costCenterId: idSchema,
            percent: z.string().regex(amountPattern),
          })
          .strict()
      )
      .min(1)
      .max(10),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

export async function actor(req: Request, write = false): Promise<Actor> {
  const ctx = await getActiveCompanyPermissionContext(req);
  if (!(write ? rolesWrite : rolesRead).has(ctx.role))
    throw new HistoryError(403, "Cost center accounting permission required");
  return {
    companyId: ctx.companyId,
    userId: ctx.userId,
    role: ctx.role,
    username: String(req.session.username || ctx.userId),
  };
}

export function errorResponse(res: Response, e: unknown) {
  if (e instanceof HistoryError) return res.status(e.status).json({ message: e.message });
  if (e instanceof ActiveCompanyPermissionContextError)
    return res.status(e.status).json({ message: e.message, code: e.code });
  if (e && typeof e === "object") {
    const code = String((e as { code?: string }).code || "");
    if (code === "42P01")
      return res
        .status(503)
        .json({ message: "Cost centers are not installed yet", code: "COST_CENTERS_NOT_INSTALLED" });
    if (["23503", "23505", "23514", "P0001", "40001"].includes(code))
      return res.status(409).json({ message: "Historical allocation conflicts with a changed or protected source" });
  }
  logger.error("Cost center historical request failed", { module: "cost-centers", error: e });
  return res.status(500).json({ message: "Historical cost center operation failed" });
}

function validDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function windowDates(from: string, to: string): void {
  if (!validDate(from) || !validDate(to) || from > to)
    throw new HistoryError(400, "Enter a valid historical date range");
  if (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z") > 366 * 5 * 86400000)
    throw new HistoryError(400, "Narrow the date range to five years or less");
}

export function parsePlan(raw: unknown): Plan {
  const parsed = previewBody.safeParse(raw);
  if (!parsed.success) throw new HistoryError(400, parsed.error.issues.map((i) => i.message).join("; "));
  const p = parsed.data;
  windowDates(p.fromDate, p.toDate);
  const ledgerAccountIds = accountFilter(p.ledgerAccountIds, p.ledgerAccountId);
  if (p.sourceKind === "FACTORY_DAYBOOK" && ledgerAccountIds !== null)
    throw new HistoryError(400, "Factory daybook entries do not have ledger account filters");
  if (new Set(p.splits.map((s) => s.costCenterId)).size !== p.splits.length)
    throw new HistoryError(400, "Each cost center can appear only once");
  const total = sumMoney(p.splits.map((s) => s.percent));
  if (total.lte(0) || total.gt(100) || p.splits.some((s) => toMoney(s.percent).lte(0)))
    throw new HistoryError(400, "Positive split percentages must total 100% or less");
  return {
    sourceKind: p.sourceKind,
    fromDate: p.fromDate,
    toDate: p.toDate,
    ledgerAccountIds,
    limit: p.limit,
    splits: p.splits.map((s) => ({ costCenterId: s.costCenterId, percent: toMoney(s.percent).toFixed(4) })),
    reason: p.reason.trim(),
  };
}

/** Distinct, sorted account ids; null (no filter) when none were chosen. */
export function accountFilter(ids: number[] | null | undefined, legacyId?: number | null): number[] | null {
  const all = [...(ids ?? []), ...(legacyId != null ? [legacyId] : [])];
  return all.length ? Array.from(new Set(all)).sort((a, b) => a - b) : null;
}

function queryParams(plan: Pick<Plan, "fromDate" | "toDate" | "ledgerAccountIds" | "limit">, companyId: number) {
  return [companyId, plan.fromDate, plan.toDate, plan.ledgerAccountIds, plan.limit + 1];
}

export function sourceSql(kind: SourceKind): string {
  if (kind === "VOUCHER_ENTRY")
    return [
      'SELECT ve.id AS "sourceId",v.id AS "voucherId",v.voucher_number AS "voucherNumber",',
      ' COALESCE(v.effective_date,v.voucher_date)::text AS "sourceDate",',
      " COALESCE(ve.transaction_currency,v.currency,'USD') AS currency,",
      " GREATEST(abs(COALESCE(ve.transaction_debit_amount,ve.debit_amount,0)),",
      ' abs(COALESCE(ve.transaction_credit_amount,ve.credit_amount,0)))::text AS "amountNative",',
      " GREATEST(abs(COALESCE(ve.base_debit_amount,ve.debit_amount,0)),",
      ' abs(COALESCE(ve.base_credit_amount,ve.credit_amount,0)))::text AS "amountUsd",',
      ' ve.historical_exchange_rate::text AS "historicalRate",',
      ' ve.rate_convention AS "rateConvention",l.name AS "accountName",',
      ' l.code AS "accountCode",COALESCE(v.source_module,\'ERP\') AS "sourceModule"',
      " FROM voucher_entries ve JOIN vouchers v ON v.id=ve.voucher_id AND v.company_id=ve.company_id",
      " JOIN ledger_accounts l ON l.id=ve.ledger_account_id AND l.company_id=ve.company_id",
      " WHERE ve.company_id=$1 AND v.deleted_at IS NULL AND v.optional=false",
      " AND NOT " + reversalPairSql("v"),
      " AND v.voucher_number NOT LIKE 'GC-%' AND v.voucher_number NOT LIKE 'MIG-%'",
      " AND upper(COALESCE(v.source_module,'')) NOT LIKE 'INTERCOMPANY%'",
      " AND COALESCE(v.source_module,'') <> 'SP_MIGRATION_READONLY'",
      " AND upper(btrim(l.account_type)) IN ('EXPENSE','DIRECT EXPENSE','INDIRECT EXPENSE')",
      " AND ve.debit_amount>0 AND COALESCE(ve.credit_amount,0)=0",
      " AND COALESCE(ve.transaction_debit_amount,ve.debit_amount,0)>0",
      " AND GREATEST(abs(COALESCE(ve.base_debit_amount,ve.debit_amount,0)),",
      " abs(COALESCE(ve.base_credit_amount,ve.credit_amount,0)))>=0",
      " AND COALESCE(v.effective_date,v.voucher_date) BETWEEN $2::date AND $3::date",
      " AND ($4::integer[] IS NULL OR ve.ledger_account_id=ANY($4::integer[]))",
      " AND NOT EXISTS(SELECT 1 FROM cost_center_allocations a",
      " WHERE a.company_id=ve.company_id AND a.voucher_entry_id=ve.id)",
      " AND NOT EXISTS(SELECT 1 FROM cost_center_source_overrides o",
      " WHERE o.company_id=ve.company_id AND o.voucher_entry_id=ve.id)",
      " ORDER BY COALESCE(v.effective_date,v.voucher_date),ve.id LIMIT $5",
    ].join(" ");
  return [
    'SELECT f.id AS "sourceId",NULL::integer AS "voucherId",',
    ' NULL::varchar AS "voucherNumber",COALESCE(f.effective_date,f.tx_date)::text AS "sourceDate",',
    ' f.currency_code AS currency,abs(f.amount_currency)::text AS "amountNative",',
    ' abs(f.amount_usd)::text AS "amountUsd",f.fx_rate_to_usd::text AS "historicalRate",',
    " 'BASE_PER_TRANSACTION'::text AS \"rateConvention\",",
    " 'Standalone Factory Daybook'::text AS \"accountName\",",
    ' NULL::text AS "accountCode",\'FACTORY\'::text AS "sourceModule"',
    " FROM factory_daybook_entries f WHERE f.company_id=$1",
    " AND f.tx_type IN ('EXPENSE','OPERATING_EXPENSE','FACTORY_EXPENSE')",
    " AND f.amount_currency>0 AND f.amount_usd>=0",
    " AND f.reference_id IS NULL AND NULLIF(btrim(COALESCE(f.reference_table,'')),'') IS NULL",
    " AND COALESCE(f.effective_date,f.tx_date) BETWEEN $2::date AND $3::date AND $4::integer[] IS NULL",
    " AND NOT EXISTS(SELECT 1 FROM cost_center_allocations a",
    " WHERE a.company_id=f.company_id AND a.factory_daybook_entry_id=f.id)",
    " AND NOT EXISTS(SELECT 1 FROM cost_center_source_overrides o",
    " WHERE o.company_id=f.company_id AND o.factory_daybook_entry_id=f.id)",
    " ORDER BY COALESCE(f.effective_date,f.tx_date),f.id LIMIT $5",
  ].join(" ");
}

export async function candidates(client: PoolClient, companyId: number, plan: Plan): Promise<Entry[]> {
  const result = await client.query(sourceSql(plan.sourceKind), queryParams(plan, companyId));
  return result.rows as Entry[];
}

export function digest(rows: Entry[]): string {
  // PG JSONB reorders object keys; use a fixed, ordered evidence tuple so a
  // stored preview hashes identically to the live source read at apply time.
  const tuples = rows.map((row) => [
    row.sourceId,
    row.voucherId,
    row.voucherNumber,
    row.sourceDate,
    row.currency,
    row.amountNative,
    row.amountUsd,
    row.historicalRate,
    row.rateConvention,
    row.accountName,
    row.accountCode,
    row.sourceModule,
  ]);
  return createHash("sha256").update(JSON.stringify(tuples)).digest("hex");
}
