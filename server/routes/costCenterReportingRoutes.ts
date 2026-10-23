/**
 * Cost Centers Phase 6: historical-USD analytical budgets and reporting.
 * Nothing here creates vouchers, changes stock value, or alters the GL.
 * Reporting is based only on the authoritative source posting.
 */
import type { Express, Request, Response } from "express";
import type { PoolClient } from "pg";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import { pool } from "../db";
import { logger } from "../lib/logger";
import { requireAuth } from "../auth";
import {
  getActiveCompanyPermissionContext,
  ActiveCompanyPermissionContextError,
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
const monthFormat = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const decimalFormat = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/;
type Scope = { companyIds: number[]; companyId: number; userId: string; role: string };
type Filters = {
  from: string;
  to: string;
  costCenterId: number | null;
  accountId: number | null;
  treatment: "ALL" | "EXPENSE" | "INVENTORY_COST";
};
class ReportError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
function valueId(raw: unknown): number {
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
function parseFilters(req: Request): Filters {
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
const ERP_PREFIX = "/api/cost-centers";
async function resolveScope(req: Request, write = false, consolidated = false, erpPages = false): Promise<Scope> {
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
function fail(res: Response, e: unknown) {
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
async function transactional<T>(handler: (c: PoolClient) => Promise<T>): Promise<T> {
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
function args(scope: Scope, filters: Filters): unknown[] {
  return [scope.companyIds, filters.from, filters.to, filters.costCenterId, filters.accountId, filters.treatment];
}
type DetailRow = Record<string, unknown>;

/**
 * Eligible expense value not assigned to any cost center, including companies
 * where no cost center rule exists. Keep this separate from center-level
 * variances, but include it in company-level total expense comparisons.
 */
async function unallocatedExpenses(scope: Scope, filters: Filters) {
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

async function summaryData(scope: Scope, filters: Filters) {
  const params = args(scope, filters);
  const [detail, centers, budgets] = await Promise.all([
    pool.query(
      sourceCte +
        ' SELECT company_id AS "companyId",cost_center_id AS "costCenterId",' +
        ' account_id AS "accountId",account_name AS "accountName",cost_treatment AS "treatment",' +
        " to_char(date_trunc('month',source_date),'YYYY-MM') AS month," +
        ' sum(signed_usd)::text AS "amountUsd",count(*)::int AS "entryCount"' +
        " FROM filtered GROUP BY company_id,cost_center_id,account_id,account_name,cost_treatment,date_trunc('month',source_date)" +
        " ORDER BY company_id,cost_center_id,month,account_name",
      params
    ),
    pool.query(
      'SELECT c.id AS "costCenterId",c.company_id AS "companyId",c.name,c.code,c.active,' +
        ' cp.name AS "companyName",c.parent_id AS "parentId"' +
        " FROM cost_centers c JOIN companies cp ON cp.id=c.company_id" +
        " WHERE c.company_id=ANY($1::int[])" +
        " ORDER BY cp.name,c.code LIMIT 10000",
      [scope.companyIds]
    ),
    pool.query(
      'SELECT company_id AS "companyId",cost_center_id AS "costCenterId",' +
        ' budget_month::text AS month,amount_usd::text AS "amountUsd"' +
        " FROM cost_center_monthly_budgets WHERE company_id=ANY($1::int[])" +
        " AND budget_month BETWEEN date_trunc('month',$2::date)::date AND date_trunc('month',$3::date)::date" +
        " AND ($4::int IS NULL OR cost_center_id=$4) ORDER BY company_id,cost_center_id,budget_month",
      [scope.companyIds, filters.from, filters.to, filters.costCenterId]
    ),
  ]);
  if (centers.rows.length >= 10000)
    throw new ReportError(413, "Too many cost centers for one summary; narrow the authorized company scope");
  const centerRows = centers.rows as Array<{
    companyId: number;
    costCenterId: number;
    companyName: string;
    name: string;
    code: string;
    active: boolean;
    parentId: number | null;
  }>;
  const b = budgets.rows as Array<{ companyId: number; costCenterId: number; month: string; amountUsd: string }>;
  const rows = detail.rows as Array<{
    companyId: number;
    costCenterId: number;
    accountId: number | null;
    accountName: string;
    treatment: string;
    month: string;
    amountUsd: string;
    entryCount: number;
  }>;
  const key = (co: number, cc: number) => co + ":" + cc;
  const centerMap = new Map(centerRows.map((x) => [key(x.companyId, x.costCenterId), x]));
  const centerAmounts = new Map<string, { expense: string; inventoryCost: string; budget: string; entries: number }>();
  const totals = { expense: toMoney(0), inventoryCost: toMoney(0), budget: toMoney(0), entries: 0 };
  const byAccount = new Map<
    string,
    {
      companyId: number;
      accountId: number | null;
      accountName: string;
      expense: string;
      inventoryCost: string;
      entries: number;
    }
  >();
  const byMonth = new Map<
    string,
    { month: string; expense: string; inventoryCost: string; budget: string; unallocated: string }
  >();
  function getCenter(co: number, cc: number) {
    const k = key(co, cc);
    if (!centerAmounts.has(k)) centerAmounts.set(k, { expense: "0", inventoryCost: "0", budget: "0", entries: 0 });
    return centerAmounts.get(k)!;
  }
  function getMonth(month: string) {
    const m = month.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, { month: m, expense: "0", inventoryCost: "0", budget: "0", unallocated: "0" });
    return byMonth.get(m)!;
  }
  for (const row of rows) {
    const amt = toMoney(row.amountUsd);
    const isExpense = row.treatment === "EXPENSE";
    const x = getCenter(row.companyId, row.costCenterId);
    if (isExpense) {
      x.expense = toMoney(x.expense).plus(amt).toFixed(6);
      totals.expense = totals.expense.plus(amt);
    } else {
      x.inventoryCost = toMoney(x.inventoryCost).plus(amt).toFixed(6);
      totals.inventoryCost = totals.inventoryCost.plus(amt);
    }
    x.entries += row.entryCount;
    totals.entries += row.entryCount;
    const mon = getMonth(String(row.month));
    if (isExpense) mon.expense = toMoney(mon.expense).plus(amt).toFixed(6);
    else mon.inventoryCost = toMoney(mon.inventoryCost).plus(amt).toFixed(6);
    const k = row.companyId + ":" + (row.accountId ?? "factory");
    if (!byAccount.has(k))
      byAccount.set(k, {
        companyId: row.companyId,
        accountId: row.accountId,
        accountName: row.accountName,
        expense: "0",
        inventoryCost: "0",
        entries: 0,
      });
    const v = byAccount.get(k)!;
    if (isExpense) v.expense = toMoney(v.expense).plus(amt).toFixed(6);
    else v.inventoryCost = toMoney(v.inventoryCost).plus(amt).toFixed(6);
    v.entries += row.entryCount;
  }
  if (filters.treatment !== "INVENTORY_COST" && filters.accountId === null)
    for (const row of b) {
      const x = getCenter(row.companyId, row.costCenterId);
      x.budget = toMoney(x.budget).plus(row.amountUsd).toFixed(6);
      totals.budget = totals.budget.plus(row.amountUsd);
      const m = getMonth(row.month);
      m.budget = toMoney(m.budget).plus(row.amountUsd).toFixed(6);
    }
  const byCenter = centerRows
    .filter((c) => filters.costCenterId === null || c.costCenterId === filters.costCenterId)
    .map((c) => {
      const a = centerAmounts.get(key(c.companyId, c.costCenterId)) || {
        expense: "0",
        inventoryCost: "0",
        budget: "0",
        entries: 0,
      };
      return {
        ...c,
        ...a,
        variance: toMoney(a.expense).minus(a.budget).toFixed(6),
        utilization: toMoney(a.budget).isZero() ? null : toMoney(a.expense).div(a.budget).times(100).toFixed(2),
      };
    });
  const departments = new Map<
    string,
    {
      companyId: number;
      companyName: string;
      costCenterId: number;
      code: string;
      name: string;
      expense: string;
      inventoryCost: string;
      budget: string;
      entries: number;
      members: number;
    }
  >();
  function rootOf(row: (typeof centerRows)[number]) {
    let current = row;
    const seen = new Set<number>();
    while (current.parentId !== null && !seen.has(current.costCenterId)) {
      seen.add(current.costCenterId);
      const parent = centerMap.get(key(row.companyId, current.parentId));
      if (!parent) break;
      current = parent;
    }
    return current;
  }
  for (const center of byCenter) {
    const node = centerMap.get(key(center.companyId, center.costCenterId));
    if (!node) continue;
    const root = rootOf(node),
      k = key(center.companyId, root.costCenterId);
    if (!departments.has(k))
      departments.set(k, {
        companyId: center.companyId,
        companyName: center.companyName,
        costCenterId: root.costCenterId,
        code: root.code,
        name: root.name,
        expense: "0",
        inventoryCost: "0",
        budget: "0",
        entries: 0,
        members: 0,
      });
    const d = departments.get(k)!;
    d.expense = toMoney(d.expense).plus(center.expense).toFixed(6);
    d.inventoryCost = toMoney(d.inventoryCost).plus(center.inventoryCost).toFixed(6);
    d.budget = toMoney(d.budget).plus(center.budget).toFixed(6);
    d.entries += center.entries;
    d.members += 1;
  }
  const departmentRows = [...departments.values()].map((x) => ({
    ...x,
    variance: toMoney(x.expense).minus(x.budget).toFixed(6),
  }));
  const byAccountRows = [...byAccount.values()].sort((a, b) => a.accountName.localeCompare(b.accountName));
  const unallocated = await unallocatedExpenses(scope, filters);
  for (const item of unallocated.months) {
    const m = getMonth(item.month);
    m.unallocated = toMoney(m.unallocated || "0")
      .plus(item.amount)
      .toFixed(6);
  }
  const months = [...byMonth.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      ...m,
      variance: toMoney(m.expense).plus(m.unallocated).minus(m.budget).toFixed(6),
    }));
  return {
    scope: scope.companyIds.length > 1 ? "consolidated" : "company",
    companyIds: scope.companyIds,
    period: { from: filters.from, to: filters.to, budgetBasis: "whole_calendar_months" },
    currency: "USD",
    centers: byCenter,
    departments: departmentRows,
    accounts: byAccountRows,
    months,
    totals: {
      expense: totals.expense.toFixed(6),
      inventoryCost: totals.inventoryCost.toFixed(6),
      budget: totals.budget.toFixed(6),
      unallocated: unallocated.amount,
      unallocatedApplicable: unallocated.applicable,
      recognizedExpense: totals.expense.plus(unallocated.amount).toFixed(6),
      variance: totals.expense.plus(unallocated.amount).minus(totals.budget).toFixed(6),
      entries: totals.entries,
    },
  };
}

async function activityData(scope: Scope, filters: Filters, limit: number, offset: number) {
  const sql =
    sourceCte +
    ' SELECT s.allocation_id AS "id",s.company_id AS "companyId",' +
    ' c.name AS "costCenterName",c.code AS "costCenterCode",s.cost_center_id AS "costCenterId",' +
    ' s.account_id AS "accountId",s.account_name AS "accountName",' +
    ' s.voucher_id AS "voucherId",s.voucher_number AS "voucherNumber",' +
    ' s.factory_daybook_entry_id AS "factoryDaybookEntryId",' +
    ' s.voucher_entry_id AS "voucherEntryId",s.source_module AS "sourceModule",' +
    ' s.source_date::text AS "sourceDate",s.cost_treatment AS "treatment",' +
    ' s.allocation_origin AS "allocationOrigin",s.currency,' +
    ' s.signed_native::text AS "amountNative",s.signed_usd::text AS "amountUsd"' +
    " FROM filtered s JOIN cost_centers c ON c.id=s.cost_center_id AND c.company_id=s.company_id" +
    " ORDER BY s.source_date DESC,s.allocation_id DESC,s.company_id" +
    " LIMIT $7 OFFSET $8";
  const rows = await pool.query(sql, [...args(scope, filters), limit, offset]);
  return { activity: rows.rows as DetailRow[], limit, offset };
}
async function auditBudget(
  client: PoolClient,
  scope: Scope,
  id: number,
  before: unknown,
  after: unknown,
  reason: string
) {
  await client.query(
    "INSERT INTO audit_log(user_id,username,company_id,action,table_name,record_id,record_identifier,changes)" +
      " VALUES($1,$2,$3,$4,'cost_center_monthly_budgets',$5,$6,$7::jsonb)",
    [
      scope.userId,
      scope.userId,
      scope.companyId,
      before ? "update" : "create",
      id,
      "monthly-budget:" + id,
      JSON.stringify({ snapshot: { old: before, new: after }, reason }),
    ]
  );
}
async function exportReport(res: Response, scope: Scope, filters: Filters, format: string, view: string) {
  const data = await summaryData(scope, filters);
  const layouts: Record<string, string[]> = {
    activity: [
      "sourceDate",
      "companyId",
      "costCenterCode",
      "accountName",
      "sourceModule",
      "voucherNumber",
      "treatment",
      "allocationOrigin",
      "currency",
      "amountNative",
      "amountUsd",
    ],
    summary: ["companyName", "code", "name", "expense", "budget", "variance", "inventoryCost", "entries"],
    departments: ["companyName", "code", "name", "expense", "budget", "variance", "inventoryCost", "members"],
    accounts: ["companyId", "accountName", "expense", "inventoryCost", "entries"],
    months: ["month", "expense", "unallocated", "budget", "variance", "inventoryCost"],
  };
  const cols = layouts[view];
  if (!cols) throw new ReportError(400, "Invalid export view");
  const centerExport =
    view === "summary" && data.totals.unallocatedApplicable && !toMoney(data.totals.unallocated).isZero()
      ? [
          ...data.centers,
          {
            companyName: scope.companyIds.length > 1 ? "Authorized companies" : "Current company",
            code: "UNALLOCATED",
            name: "Unallocated expense",
            expense: data.totals.unallocated,
            budget: "0",
            variance: data.totals.unallocated,
            inventoryCost: "0",
            entries: 0,
          },
        ]
      : data.centers;
  const items =
    view === "activity"
      ? (await activityData(scope, filters, 5001, 0)).activity
      : view === "departments"
        ? data.departments
        : view === "accounts"
          ? data.accounts
          : view === "months"
            ? data.months
            : centerExport;
  if (items.length > 5000) throw new ReportError(413, "Narrow your dates or center for exports above 5,000 rows");
  const name = "cost-centers-" + view + "-" + filters.from + "-" + filters.to;
  const rowData = (items as unknown as Array<Record<string, unknown>>).map((item) =>
    cols.map((col) => String(item[col] ?? ""))
  );
  const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) && !/^[-+]?\d+(?:\.\d+)?$/.test(v) ? "'" + v : v);
  if (format === "csv") {
    const escape = (v: string) => '"' + safe(v).replace(/"/g, '""') + '"';
    const contents = "\uFEFF" + [cols, ...rowData].map((c) => c.map(escape).join(",")).join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="' + name + '.csv"');
    return res.send(contents);
  }
  if (format === "xlsx") {
    const book = new ExcelJS.Workbook();
    book.creator = "ERP Cost Centers";
    const sheet = book.addWorksheet("Cost Centers", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.addRow(cols);
    const numericColumns = new Set([
      "expense",
      "inventoryCost",
      "budget",
      "variance",
      "unallocated",
      "amountNative",
      "amountUsd",
      "entries",
      "members",
    ]);
    for (const line of rowData)
      sheet.addRow(
        line.map((value, index) => {
          if (numericColumns.has(cols[index]) && /^[-+]?\d+(?:\.\d+)?$/.test(value)) {
            const numberValue = Number(value);
            // Excel stores approximately 15 significant digits; retain large
            // 20,6 source values as exact text rather than corrupt historical FX.
            if (Number.isFinite(numberValue) && Math.abs(numberValue) < 1e12) return numberValue;
          }
          return safe(value);
        })
      );
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((column) => {
      column.width = 22;
    });
    sheet.autoFilter = { from: "A1", to: sheet.getRow(1).getCell(cols.length).address };
    const buffer = await book.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="' + name + '.xlsx"');
    return res.end(Buffer.from(buffer));
  }
  if (format === "pdf") {
    const pdf = new PDFDocument({ margin: 34, size: "A4", layout: "landscape" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="' + name + '.pdf"');
    pdf.pipe(res);
    const viewTitle: Record<string, string> = {
      summary: "Budget & Expense Report",
      activity: "Activity Report",
      departments: "Budget & Expense Report by Department",
      accounts: "Expense Report by Account",
      months: "Budget & Expense Report by Month",
    };
    pdf.fontSize(16).text("Cost Center " + viewTitle[view]);
    pdf.fontSize(9).text(filters.from + " to " + filters.to + " | Historical USD | Whole-month budgets");
    if (view !== "activity") {
      pdf.text(
        "Allocated expense: " +
          data.totals.expense +
          " | Unallocated: " +
          data.totals.unallocated +
          " | Budget: " +
          data.totals.budget +
          " | Variance: " +
          data.totals.variance +
          " | Inventory costs (separate): " +
          data.totals.inventoryCost
      );
    }
    pdf.moveDown();
    const widths = view === "activity" ? [65, 42, 80, 100, 66, 80, 60, 55, 38, 62, 62] : cols.map(() => 80);
    const pageW = pdf.page.width - 68;
    const scale = pageW / widths.reduce((s, v) => s + v, 0);
    let y = pdf.y;
    function draw(line: string[], header = false) {
      if (y > pdf.page.height - 45) {
        pdf.addPage();
        y = 38;
      }
      let x = 34;
      if (header) pdf.font("Helvetica-Bold");
      else pdf.font("Helvetica");
      for (let i = 0; i < line.length; i++) {
        const w = widths[i] * scale;
        pdf.fontSize(7.5).text(line[i].slice(0, 38), x, y, { width: w - 4, height: 16, ellipsis: true });
        x += w;
      }
      y += 19;
    }
    draw(cols, true);
    rowData.forEach((row) => draw(row));
    pdf.end();
    return;
  }
  throw new ReportError(400, "Invalid export format");
}

function registerPrefix(app: Express, prefix: string) {
  app.get(prefix + "/reports/summary", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      res.json(await summaryData(scope, parseFilters(req)));
    } catch (e) {
      fail(res, e);
    }
  });
  app.get(prefix + "/reports/consolidated", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req, false, true, prefix === ERP_PREFIX);
      res.json(await summaryData(scope, parseFilters(req)));
    } catch (e) {
      fail(res, e);
    }
  });
  app.get(prefix + "/reports/consolidated/activity", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req, false, true, prefix === ERP_PREFIX);
      const limit = req.query.limit === undefined ? 50 : valueId(req.query.limit);
      const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
      if (limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 2000000)
        throw new ReportError(400, "Invalid pagination");
      res.json(await activityData(scope, parseFilters(req), limit, offset));
    } catch (e) {
      fail(res, e);
    }
  });
  app.get(prefix + "/reports/consolidated/export", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req, false, true, prefix === ERP_PREFIX);
      const format = req.query.format;
      const view = req.query.view ?? "summary";
      if (!["csv", "xlsx", "pdf"].includes(String(format)) || !isCostCenterExportView(view))
        throw new ReportError(400, "Invalid export request");
      await exportReport(res, scope, parseFilters(req), String(format), String(view));
    } catch (e) {
      if (!res.headersSent) fail(res, e);
      else res.end();
    }
  });
  app.get(prefix + "/reports/activity", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      const limit = req.query.limit === undefined ? 50 : valueId(req.query.limit);
      const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
      if (limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 2000000)
        throw new ReportError(400, "Invalid pagination");
      res.json(await activityData(scope, parseFilters(req), limit, offset));
    } catch (e) {
      fail(res, e);
    }
  });
  app.get(prefix + "/reports/export", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      const format = req.query.format;
      const view = req.query.view ?? "summary";
      if (!["csv", "xlsx", "pdf"].includes(String(format)) || !isCostCenterExportView(view))
        throw new ReportError(400, "Invalid export request");
      await exportReport(res, scope, parseFilters(req), String(format), String(view));
    } catch (e) {
      if (!res.headersSent) fail(res, e);
      else res.end();
    }
  });
  app.get(prefix + "/budgets", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      const filters = parseFilters(req);
      const result = await pool.query(
        'SELECT id,company_id AS "companyId",cost_center_id AS "costCenterId",' +
          ' budget_month::text AS month,amount_usd::text AS "amountUsd",notes,' +
          ' updated_by AS "updatedBy",updated_at AS "updatedAt"' +
          " FROM cost_center_monthly_budgets" +
          " WHERE company_id=$1 AND budget_month BETWEEN date_trunc('month',$2::date)::date" +
          " AND date_trunc('month',$3::date)::date" +
          " ORDER BY budget_month,cost_center_id",
        [scope.companyId, filters.from, filters.to]
      );
      res.json({ budgets: result.rows });
    } catch (e) {
      fail(res, e);
    }
  });
  // Auditable budget history, scoped to the active company and selected center.
  app.get(prefix + "/budgets/:costCenterId/:month/history", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      const centerId = valueId(req.params.costCenterId);
      const period = req.params.month;
      if (!monthFormat.test(period)) throw new ReportError(400, "Invalid budget month");
      const budget = await pool.query(
        "SELECT id FROM cost_center_monthly_budgets" +
          " WHERE company_id=$1 AND cost_center_id=$2 AND budget_month=$3::date",
        [scope.companyId, centerId, period + "-01"]
      );
      if (!budget.rows.length) return res.json({ history: [] });
      const history = await pool.query(
        'SELECT id,username,action,changes,created_at AS "createdAt"' +
          " FROM audit_log WHERE company_id=$1 AND table_name='cost_center_monthly_budgets'" +
          " AND record_id=$2 ORDER BY id DESC LIMIT 100",
        [scope.companyId, budget.rows[0].id]
      );
      res.json({ history: history.rows });
    } catch (e) {
      fail(res, e);
    }
  });
  app.put(prefix + "/budgets/:costCenterId/:month", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req, true);
      const centerId = valueId(req.params.costCenterId);
      const period = req.params.month;
      if (!monthFormat.test(period)) throw new ReportError(400, "Invalid budget month");
      const amount = String(req.body?.amountUsd ?? "");
      if (!decimalFormat.test(amount)) throw new ReportError(400, "Invalid nonnegative USD budget");
      const notes = req.body?.notes === undefined ? null : req.body.notes;
      const reason = req.body?.reason;
      if (
        (notes !== null && (typeof notes !== "string" || notes.length > 1200)) ||
        typeof reason !== "string" ||
        reason.trim().length < 3 ||
        reason.length > 500
      )
        throw new ReportError(400, "Notes or audit reason is invalid");
      const result = await transactional(async (client) => {
        const exists = await client.query(
          "SELECT id FROM cost_centers WHERE company_id=$1 AND id=$2 AND active=true FOR SHARE",
          [scope.companyId, centerId]
        );
        if (!exists.rowCount) throw new ReportError(409, "Budget center must be active in this company");
        const before = await client.query(
          "SELECT * FROM cost_center_monthly_budgets WHERE company_id=$1" +
            " AND cost_center_id=$2 AND budget_month=$3::date FOR UPDATE",
          [scope.companyId, centerId, period + "-01"]
        );
        const after = await client.query(
          "INSERT INTO cost_center_monthly_budgets" +
            "(company_id,cost_center_id,budget_month,amount_usd,notes,created_by,updated_by)" +
            " VALUES($1,$2,$3::date,$4,$5,$6,$6)" +
            " ON CONFLICT(company_id,cost_center_id,budget_month)" +
            " DO UPDATE SET amount_usd=excluded.amount_usd,notes=excluded.notes," +
            "updated_by=excluded.updated_by,updated_at=now() RETURNING *",
          [scope.companyId, centerId, period + "-01", toMoney(amount).toFixed(6), notes, scope.userId]
        );
        await auditBudget(client, scope, after.rows[0].id, before.rows[0] ?? null, after.rows[0], reason.trim());
        return after.rows[0];
      });
      res.json({ budget: result });
    } catch (e) {
      fail(res, e);
    }
  });
}
export function registerCostCenterReportingRoutes(app: Express): void {
  registerPrefix(app, ERP_PREFIX);
  registerPrefix(app, "/api/factory/cost-centers");
}
