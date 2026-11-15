// Extracted from ./costCenterReportingRoutes.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import { pool } from "../db";
import { logger } from "../lib/logger";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../services/security/activeCompanyPermissionContext";
import { getAccessibleCompanyIds } from "../security/companyAccessBoundary";
import { COST_CENTER_ERP_PAGE_KEY } from "../middleware/costCenterErpPageAccess";
import { toMoney } from "../lib/money";

const READ = new Set(["Developer", "Owner", "Admin", "Manager"]);

const WRITE = new Set(["Developer", "Owner", "Admin"]);

// Keep both current-company and consolidated exports aligned with the report tabs.
export const COST_CENTER_EXPORT_VIEWS = ["summary", "activity", "departments", "accounts", "months"] as const;

export function isCostCenterExportView(value: unknown): boolean {
  return COST_CENTER_EXPORT_VIEWS.includes(value as (typeof COST_CENTER_EXPORT_VIEWS)[number]);
}

const dateFormat = /^\d{4}-\d{2}-\d{2}$/;

export const monthFormat = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export const decimalFormat = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/;

export type Scope = { companyIds: number[]; companyId: number; userId: string; role: string };

export type Filters = {
  from: string;
  to: string;
  costCenterId: number | null;
  accountId: number | null;
  treatment: "ALL" | "EXPENSE" | "INVENTORY_COST";
};

export class ReportError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function valueId(raw: unknown): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new ReportError(400, "Invalid ID");
  return id;
}

function dateInput(raw: unknown, label: string): string {
  if (
    typeof raw !== "string" ||
    !dateFormat.test(raw) ||
    Number.isNaN(Date.parse(raw + "T00:00:00Z")) ||
    new Date(raw + "T00:00:00Z").toISOString().slice(0, 10) !== raw
  )
    throw new ReportError(400, "Invalid " + label);
  return raw;
}

export function parseFilters(req: Request): Filters {
  const year = new Date().getUTCFullYear();
  const month = String(new Date().getUTCMonth() + 1).padStart(2, "0");
  const from = dateInput(req.query.fromDate ?? year + "-" + month + "-01", "fromDate");
  const to = dateInput(
    req.query.toDate ?? new Date(Date.UTC(year, Number(month), 0)).toISOString().slice(0, 10),
    "toDate"
  );
  if (from > to) throw new ReportError(400, "fromDate must not be after toDate");
  const delta = Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z");
  if (delta > 1000 * 60 * 60 * 24 * 366 * 5) throw new ReportError(400, "Choose a date window of five years or less");
  const costCenterId = req.query.costCenterId === undefined ? null : valueId(req.query.costCenterId);
  const accountId = req.query.accountId === undefined ? null : valueId(req.query.accountId);
  const t = req.query.treatment ?? "ALL";
  if (t !== "ALL" && t !== "EXPENSE" && t !== "INVENTORY_COST") throw new ReportError(400, "Invalid cost treatment");
  return { from, to, costCenterId, accountId, treatment: t };
}

export const ERP_PREFIX = "/api/cost-centers";

export async function resolveScope(
  req: Request,
  write = false,
  consolidated = false,
  erpPages = false
): Promise<Scope> {
  const c = await getActiveCompanyPermissionContext(req);
  if (!(write ? WRITE : READ).has(c.role)) throw new ReportError(403, "Cost center accounting permission required");
  if (!consolidated) return { companyIds: [c.companyId], companyId: c.companyId, userId: c.userId, role: c.role };
  if (!WRITE.has(c.role)) throw new ReportError(403, "Consolidated reports require Admin, Owner or Developer");
  const accessible = await getAccessibleCompanyIds(c.userId);
  if (c.role === "Developer") {
    if (accessible.size > 150)
      throw new ReportError(413, "Consolidated reporting exceeds 150 companies; narrow the authorized scope");
    return {
      companyIds: [...accessible].sort((a, b) => a - b),
      companyId: c.companyId,
      userId: c.userId,
      role: c.role,
    };
  }
  // A role in the selected company is not a license to read another company.
  // Require an authorized accounting role in each included company as well.
  const rows = await pool.query("SELECT company_id,role FROM user_company_roles WHERE user_id=$1", [c.userId]);
  // ERP Cost Centers is owned by the per-company Accounts page (same rule as
  // /api/my-erp-pages), so an Owner cannot consolidate a company where that
  // page was not assigned. Factory consolidation keeps its own boundary.
  const accountsGranted = erpPages
    ? new Set(
        (
          await pool.query("SELECT company_id FROM erp_user_page_access WHERE user_id=$1 AND page_key=$2", [
            c.userId,
            COST_CENTER_ERP_PAGE_KEY,
          ])
        ).rows.map((x: { company_id: number }) => Number(x.company_id))
      )
    : null;
  const authorized = rows.rows
    .filter(
      (x: { company_id: number; role: string }) =>
        WRITE.has(x.role) &&
        accessible.has(x.company_id) &&
        (!accountsGranted || x.role === "Admin" || x.role === "Developer" || accountsGranted.has(x.company_id))
    )
    .map((x: { company_id: number }) => x.company_id)
    .sort((a: number, b: number) => a - b);
  if (authorized.length > 150) throw new ReportError(413, "Consolidated reporting exceeds 150 companies");
  return { companyIds: authorized, companyId: c.companyId, userId: c.userId, role: c.role };
}

export function fail(res: Response, e: unknown) {
  if (e instanceof ReportError) return res.status(e.status).json({ message: e.message });
  if (e instanceof ActiveCompanyPermissionContextError)
    return res.status(e.status).json({ message: e.message, code: e.code });
  if (e && typeof e === "object" && String((e as { code?: string }).code) === "23514")
    return res.status(409).json({ message: "Invalid budget amount or period" });
  if (e && typeof e === "object" && String((e as { code?: string }).code) === "42P01")
    return res.status(503).json({ message: "Cost centers are not installed yet", code: "COST_CENTERS_NOT_INSTALLED" });
  logger.error("Cost center reporting request failed", { module: "cost-centers", error: e });
  return res.status(500).json({ message: "Cost center report unavailable" });
}

export async function transactional<T>(handler: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const answer = await handler(c);
    await c.query("COMMIT");
    return answer;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/*
 * Every allocation is attached to either a voucher ledger entry or a truly
 * standalone Factory daybook expense. Reversal pairs cancel by excluding BOTH
 * an original that has a live reversing voucher and the reversal voucher itself.
 *
 * Expense credits are negative. Inventory cost is disclosed separately from
 * P&L and only debit-side eligible factory inventory source allocations count.
 * Never join or aggregate raw factory operations, unfinalized containers or
 * stock transfers as a second P&L event.
 */
/**
 * True when voucher `alias` is either half of a reversal pair. Two linkages
 * exist: correction reversals set vouchers.reversal_of_voucher_id, while the
 * exact-reversal endpoint links through its posting identity
 * (accounting_posting_requests source_type 'voucher-reversal', source_id =
 * original id). Both halves are excluded so a reversed expense nets to zero
 * everywhere, including in cost-center attribution.
 */
export function reversalPairSql(alias: string): string {
  const v = alias;
  return [
    "(" + v + ".reversal_of_voucher_id IS NOT NULL",
    "OR EXISTS (SELECT 1 FROM vouchers rev WHERE rev.reversal_of_voucher_id=" + v + ".id AND rev.deleted_at IS NULL)",
    "OR EXISTS (SELECT 1 FROM accounting_posting_requests apr WHERE apr.voucher_id=" + v + ".id",
    "AND apr.source_type='voucher-reversal')",
    "OR EXISTS (SELECT 1 FROM accounting_posting_requests apr JOIN vouchers rev ON rev.id=apr.voucher_id",
    "AND rev.deleted_at IS NULL WHERE apr.company_id=" + v + ".company_id AND apr.source_type='voucher-reversal'",
    "AND apr.source_id=" + v + ".id::text))",
  ].join(" ");
}

export const sourceCte = [
  "WITH source_rows AS (",
  " SELECT a.company_id,a.cost_center_id,a.cost_treatment,a.allocation_origin,",
  " ve.ledger_account_id AS account_id,COALESCE(l.name,'') AS account_name,",
  " v.id AS voucher_id,v.voucher_number,",
  " NULL::integer AS factory_daybook_entry_id, a.voucher_entry_id,",
  " COALESCE(v.effective_date,v.voucher_date) AS source_date,",
  " a.currency,a.amount_native::numeric *",
  " CASE WHEN COALESCE(ve.credit_amount,0)>COALESCE(ve.debit_amount,0) THEN -1 ELSE 1 END AS signed_native,",
  " a.amount_base::numeric *",
  " CASE WHEN COALESCE(ve.credit_amount,0)>COALESCE(ve.debit_amount,0) THEN -1 ELSE 1 END AS signed_usd,",
  " a.id AS allocation_id, COALESCE(v.source_module,'ERP') AS source_module",
  " FROM cost_center_allocations a",
  " JOIN voucher_entries ve ON ve.id=a.voucher_entry_id AND ve.company_id=a.company_id",
  " JOIN vouchers v ON v.id=ve.voucher_id AND v.company_id=a.company_id",
  " JOIN ledger_accounts l ON l.id=ve.ledger_account_id AND l.company_id=a.company_id",
  " WHERE a.company_id=ANY($1::integer[]) AND v.deleted_at IS NULL AND v.optional=false",
  " AND NOT " + reversalPairSql("v"),
  " AND upper(COALESCE(v.source_module,'')) NOT LIKE 'INTERCOMPANY%' AND COALESCE(v.source_module,'') <> 'SP_MIGRATION_READONLY'",
  " AND v.voucher_number NOT LIKE 'GC-%' AND v.voucher_number NOT LIKE 'MIG-%'",
  " AND (a.cost_treatment='EXPENSE' AND upper(btrim(l.account_type)) IN",
  " ('EXPENSE','DIRECT EXPENSE','INDIRECT EXPENSE')",
  " OR a.cost_treatment='INVENTORY_COST' AND upper(btrim(l.account_type))='ASSET'",
  " AND l.code IN ('FACTORY_RAW_MATERIAL_STOCK','FACTORY_WIP','FACTORY_FINISHED_GOODS')",
  " AND COALESCE(ve.debit_amount,0)>0 AND COALESCE(ve.credit_amount,0)=0)",
  " UNION ALL",
  " SELECT a.company_id,a.cost_center_id,a.cost_treatment,a.allocation_origin,",
  " NULL::integer AS account_id,'Standalone Factory Daybook'::text AS account_name,",
  " NULL::integer AS voucher_id,NULL::varchar AS voucher_number,",
  " a.factory_daybook_entry_id,NULL::integer AS voucher_entry_id,",
  " COALESCE(f.effective_date,f.tx_date) AS source_date,",
  " a.currency,a.amount_native::numeric AS signed_native,",
  " a.amount_base::numeric AS signed_usd,a.id AS allocation_id,'FACTORY'::text AS source_module",
  " FROM cost_center_allocations a",
  " JOIN factory_daybook_entries f ON f.id=a.factory_daybook_entry_id AND f.company_id=a.company_id",
  " WHERE a.company_id=ANY($1::integer[]) AND a.cost_treatment='EXPENSE'",
  " AND f.tx_type IN ('EXPENSE','OPERATING_EXPENSE','FACTORY_EXPENSE')",
  " AND NULLIF(btrim(COALESCE(f.reference_table,'')),'') IS NULL",
  " AND f.reference_id IS NULL AND f.amount_currency>0",
  "), filtered AS (",
  " SELECT * FROM source_rows",
  " WHERE source_date BETWEEN $2::date AND $3::date",
  " AND ($4::integer IS NULL OR cost_center_id=$4)",
  " AND ($5::integer IS NULL OR account_id=$5)",
  " AND ($6::text='ALL' OR cost_treatment=$6)",
  ")",
].join(" ");

export function args(scope: Scope, filters: Filters): unknown[] {
  return [scope.companyIds, filters.from, filters.to, filters.costCenterId, filters.accountId, filters.treatment];
}

export type DetailRow = Record<string, unknown>;

/**
 * Eligible expense value not assigned to any cost center, including companies
 * where no cost center rule exists. Keep this separate from center-level
 * variances, but include it in company-level total expense comparisons.
 */
export async function unallocatedExpenses(scope: Scope, filters: Filters) {
  if (filters.costCenterId !== null || filters.treatment === "INVENTORY_COST")
    return { amount: "0", months: [] as Array<{ month: string; amount: string }>, applicable: false };
  const query = [
    "WITH candidates AS (",
    " SELECT COALESCE(v.effective_date,v.voucher_date) AS source_date,",
    " GREATEST(abs(COALESCE(ve.base_debit_amount,ve.debit_amount,0)),",
    " abs(COALESCE(ve.base_credit_amount,ve.credit_amount,0)))::numeric AS source_usd,",
    " COALESCE(al.allocated,0)::numeric AS allocated,",
    " CASE WHEN COALESCE(ve.credit_amount,0)>COALESCE(ve.debit_amount,0) THEN -1 ELSE 1 END AS sign",
    " FROM voucher_entries ve JOIN vouchers v ON v.id=ve.voucher_id AND v.company_id=ve.company_id",
    " JOIN ledger_accounts l ON l.id=ve.ledger_account_id AND l.company_id=ve.company_id",
    " LEFT JOIN LATERAL (SELECT sum(a.amount_base) AS allocated FROM cost_center_allocations a",
    " WHERE a.voucher_entry_id=ve.id AND a.company_id=ve.company_id) al ON TRUE",
    " WHERE ve.company_id=ANY($1::int[])",
    " AND COALESCE(v.effective_date,v.voucher_date) BETWEEN $2::date AND $3::date",
    " AND ($4::int IS NULL OR ve.ledger_account_id=$4)",
    " AND v.deleted_at IS NULL AND v.optional=false AND NOT " + reversalPairSql("v"),
    " AND upper(COALESCE(v.source_module,'')) NOT LIKE 'INTERCOMPANY%' AND COALESCE(v.source_module,'') <> 'SP_MIGRATION_READONLY'",
    " AND v.voucher_number NOT LIKE 'GC-%' AND v.voucher_number NOT LIKE 'MIG-%'",
    " AND upper(btrim(l.account_type)) IN ('EXPENSE','DIRECT EXPENSE','INDIRECT EXPENSE')",
    " UNION ALL",
    " SELECT COALESCE(f.effective_date,f.tx_date) AS source_date,",
    " abs(f.amount_usd)::numeric AS source_usd,COALESCE(al.allocated,0)::numeric AS allocated,1 AS sign",
    " FROM factory_daybook_entries f",
    " LEFT JOIN LATERAL (SELECT sum(a.amount_base) AS allocated FROM cost_center_allocations a",
    " WHERE a.factory_daybook_entry_id=f.id AND a.company_id=f.company_id) al ON TRUE",
    " WHERE f.company_id=ANY($1::int[]) AND $4::int IS NULL",
    " AND COALESCE(f.effective_date,f.tx_date) BETWEEN $2::date AND $3::date",
    " AND f.tx_type IN ('EXPENSE','OPERATING_EXPENSE','FACTORY_EXPENSE')",
    " AND f.reference_id IS NULL AND NULLIF(btrim(COALESCE(f.reference_table,'')),'') IS NULL",
    " AND f.amount_usd>=0 AND f.amount_currency>0",
    ") SELECT to_char(date_trunc('month',source_date),'YYYY-MM') AS month,",
    " COALESCE(sum(sign*GREATEST(0,source_usd-allocated)),0)::text AS amount",
    " FROM candidates WHERE source_usd>0 GROUP BY date_trunc('month',source_date)",
    " ORDER BY month",
  ].join(" ");
  const response = await pool.query(query, [scope.companyIds, filters.from, filters.to, filters.accountId]);
  const months = response.rows as Array<{ month: string; amount: string }>;
  const total = months.reduce((value, row) => value.plus(row.amount), toMoney(0));
  return { amount: total.toFixed(6), months, applicable: true };
}
