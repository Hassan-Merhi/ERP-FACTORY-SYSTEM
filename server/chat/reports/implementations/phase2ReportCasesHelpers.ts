// Extracted from ./phase2ReportCases.ts
import { db, sql, nonPartyAccountTypesSql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";

export async function runPhase2CustomerAging({
  companyId,
  rowLimit,
  fmt,
  todayStr,
}: {
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
  todayStr: DataQueryContext["todayStr"];
}) {
  const rows = await db.execute<{
    name: string;
    ob: string;
    total_debit: string;
    total_credit: string;
    bucket_0_30: string;
    bucket_31_60: string;
    bucket_61_90: string;
    bucket_over_90: string;
  }>(sql`
        SELECT la.name,
          COALESCE(CASE WHEN la.opening_balance_side = 'Cr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END, 0) AS ob,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS total_debit,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS total_credit,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) BETWEEN 0 AND 30
            THEN CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS bucket_0_30,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) BETWEEN 31 AND 60
            THEN CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS bucket_31_60,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) BETWEEN 61 AND 90
            THEN CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS bucket_61_90,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) > 90
            THEN CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS bucket_over_90
        FROM ledger_accounts la
        LEFT JOIN voucher_entries ve ON ve.ledger_account_id = la.id
        LEFT JOIN vouchers v ON v.id = ve.voucher_id
        WHERE la.company_id = ${companyId} AND la.active = true AND la.deleted_at IS NULL
          AND LOWER(TRIM(la.account_type)) NOT IN (${nonPartyAccountTypesSql(["Accounts Payable", "Loans"])})
        GROUP BY la.id, la.name, la.opening_balance, la.opening_balance_side
        HAVING (
          COALESCE(CASE WHEN la.opening_balance_side = 'Cr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END, 0)
          + COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0)
        ) > 100
        ORDER BY (
          COALESCE(CASE WHEN la.opening_balance_side = 'Cr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END, 0)
          + COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0)
        ) DESC
        LIMIT ${rowLimit}
      `);
  let grandTotal0_30 = 0,
    grandTotal31_60 = 0,
    grandTotal61_90 = 0,
    grandTotalOver90 = 0,
    grandTotalAll = 0;
  const tableRows2 = rows.rows.map((r) => {
    const balance = toMoney(r.ob).plus(toMoney(r.total_debit)).minus(toMoney(r.total_credit)).toNumber();
    const b0 = toMoney(r.bucket_0_30).toNumber();
    const b1 = toMoney(r.bucket_31_60).toNumber();
    const b2 = toMoney(r.bucket_61_90).toNumber();
    const b3 = toMoney(r.bucket_over_90).toNumber();
    grandTotal0_30 += b0;
    grandTotal31_60 += b1;
    grandTotal61_90 += b2;
    grandTotalOver90 += b3;
    grandTotalAll += balance;
    return [
      r.name,
      fmt(balance),
      fmt(b0 > 0 ? b0 : 0),
      fmt(b1 > 0 ? b1 : 0),
      fmt(b2 > 0 ? b2 : 0),
      fmt(b3 > 0 ? b3 : 0),
    ];
  });
  tableRows2.push([
    "TOTAL",
    fmt(grandTotalAll),
    fmt(grandTotal0_30),
    fmt(grandTotal31_60),
    fmt(grandTotal61_90),
    fmt(grandTotalOver90),
  ]);
  return {
    queryType: "customer_aging",
    title: "Customer Receivables Aging",
    subtitle: `As of ${todayStr}`,
    table: {
      headers: ["Account", "Total", "0-30 days", "31-60 days", "61-90 days", "90+ days"],
      rows: tableRows2,
    },
    noData: tableRows2.length <= 1,
  };
}

export async function runPhase2LowStockItems({
  companyId,
  rowLimit,
  fmtDec,
}: {
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
}) {
  const rows = await db.execute<{
    name: string;
    code: string;
    uom: string;
    reorder_level: string;
    total_qty: string;
  }>(sql`
        SELECT si.name, si.code, si.uom,
          CAST(si.reorder_level AS numeric) AS reorder_level,
          COALESCE(SUM(CAST(inv.quantity AS numeric)), 0) AS total_qty
        FROM stock_items si
        LEFT JOIN inventory inv ON inv.stock_item_id = si.id AND inv.company_id = ${companyId}
        WHERE si.company_id = ${companyId}
          AND si.active = true AND si.deleted_at IS NULL
          AND CAST(si.reorder_level AS numeric) > 0
        GROUP BY si.id, si.name, si.code, si.uom, si.reorder_level
        HAVING COALESCE(SUM(CAST(inv.quantity AS numeric)), 0) < CAST(si.reorder_level AS numeric)
        ORDER BY (COALESCE(SUM(CAST(inv.quantity AS numeric)), 0) / NULLIF(CAST(si.reorder_level AS numeric), 0)) ASC
        LIMIT ${rowLimit}
      `);
  const tableRows2 = rows.rows.map((r) => [
    r.name,
    r.code,
    `${fmtDec(toMoney(r.total_qty).toNumber())} ${r.uom}`,
    `${fmtDec(toMoney(r.reorder_level).toNumber())} ${r.uom}`,
    `${Math.round((toMoney(r.total_qty).toNumber() / toMoney(r.reorder_level).toNumber()) * 100)}%`,
  ]);
  return {
    queryType: "low_stock_items",
    title: "Items Below Reorder Level",
    subtitle: `${tableRows2.length} item(s) need restocking`,
    table: { headers: ["Item", "Code", "Current Stock", "Reorder Level", "Stock %"], rows: tableRows2 },
    noData: tableRows2.length === 0,
  };
}
