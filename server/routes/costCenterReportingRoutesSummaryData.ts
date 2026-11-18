// Extracted from ./costCenterReportingRoutes.ts to keep that module under the source-size cap.
import type { PoolClient } from "pg";
import { pool } from "../db";
import { toMoney } from "../lib/money";
import {
  ReportError,
  args,
  sourceCte,
  unallocatedExpenses,
  type DetailRow,
  type Filters,
  type Scope,
} from "./costCenterReportingRoutesReversalPairSql";

export async function summaryData(scope: Scope, filters: Filters) {
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

export async function activityData(scope: Scope, filters: Filters, limit: number, offset: number) {
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

export async function auditBudget(
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
