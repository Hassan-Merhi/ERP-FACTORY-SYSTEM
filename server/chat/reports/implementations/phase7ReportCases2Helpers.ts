// Extracted from ./phase7ReportCases2.ts
import { db, sql, accountTypesOfClassSql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";
import { notFiscalClosingVoucher } from "../../../services/accounting/balances/periodReportRules";

export async function runPhase7IncomeBreakdown({
  dateFrom,
  dateTo,
  companyId,
  rowLimit,
  fmt,
}: {
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const rows = await db.execute<{ name: string; account_type: string; net_income: string }>(sql`
        SELECT la.name, la.account_type,
          COALESCE(SUM(CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric)), 0) AS net_income
        FROM ledger_accounts la
        JOIN voucher_entries ve ON ve.ledger_account_id = la.id
        JOIN vouchers v ON v.id = ve.voucher_id
          AND v.deleted_at IS NULL AND v.optional = false
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
          AND v.company_id = ${companyId}
          AND ${notFiscalClosingVoucher("v")}
        WHERE la.company_id = ${companyId}
          AND LOWER(TRIM(la.account_type)) IN (${accountTypesOfClassSql("income")})
          AND la.deleted_at IS NULL
        GROUP BY la.id, la.name, la.account_type
        HAVING COALESCE(SUM(CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric)), 0) > 0
        ORDER BY net_income DESC
        LIMIT ${rowLimit}
      `);
  let grandIncome = 0;
  const tableRows7 = rows.rows.map((r) => {
    const income = toMoney(r.net_income).toNumber();
    grandIncome += income;
    return [r.name, r.account_type, fmt(income)];
  });
  if (tableRows7.length) tableRows7.push(["TOTAL", "", fmt(grandIncome)]);
  return {
    queryType: "income_breakdown",
    title: "Income Breakdown by Account",
    subtitle: `${dateFrom} → ${dateTo} · Total: ${fmt(grandIncome)}`,
    table: { headers: ["Account", "Type", "Net Income"], rows: tableRows7 },
    noData: tableRows7.length === 0,
  };
}

export async function runPhase7SupplierContainerHistory({
  params,
  companyId,
  rowLimit,
  fmtDec,
  fmt,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
  fmt: DataQueryContext["fmt"];
}) {
  const suppName7 = params.entityName;
  if (!suppName7) {
    return {
      queryType: "supplier_container_history",
      title: "Supplier Container History",
      summary: "Please specify a supplier name.",
    };
  }
  const rows = await db.execute<{
    container_number: string;
    status: string;
    import_date: string | null;
    eta: string | null;
    grand_total: string;
    currency: string;
    total_kg: string | null;
    rate_per_kg: string | null;
    item_name: string | null;
    supplier: string | null;
  }>(sql`
        SELECT c.container_number, c.status, c.import_date, c.eta,
          CAST(c.grand_total AS numeric) AS grand_total, c.currency,
          c.total_kg, c.rate_per_kg, c.item_name, s.legal_name AS supplier
        FROM containers c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.company_id = ${companyId}
          AND s.legal_name ILIKE ${"%" + suppName7 + "%"}
        ORDER BY c.import_date DESC
        LIMIT ${rowLimit}
      `);
  let totalValue = 0,
    totalKg = 0;
  const statusCounts: Record<string, number> = {};
  const tableRows7 = rows.rows.map((r) => {
    const val = toMoney(r.grand_total).toNumber();
    const kg = toMoney(r.total_kg).toNumber();
    totalValue += val;
    totalKg += kg;
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    return [
      r.container_number,
      r.status,
      String(r.import_date).slice(0, 10),
      r.eta ? String(r.eta).slice(0, 10) : "—",
      fmtDec(kg),
      fmt(val),
      r.currency,
      (r.item_name || "—").slice(0, 25),
    ];
  });
  const supplier7 = (rows.rows[0] as { supplier: unknown })?.supplier || suppName7;
  const stats7 = [
    { label: "Supplier", value: supplier7 },
    { label: "Total Containers", value: String(tableRows7.length) },
    { label: "Total Kg", value: fmtDec(totalKg) },
    { label: "Total Value", value: fmt(totalValue), highlight: "positive" },
    ...Object.entries(statusCounts).map(([s, c]) => ({ label: s, value: String(c) })),
  ];
  return {
    queryType: "supplier_container_history",
    title: `Containers from: ${supplier7}`,
    subtitle: `${tableRows7.length} container(s) · most recent first`,
    stats: stats7,
    table: {
      headers: ["Container #", "Status", "Import Date", "ETA", "Total Kg", "Value", "Currency", "Item"],
      rows: tableRows7,
    },
    noData: tableRows7.length === 0,
  };
}
