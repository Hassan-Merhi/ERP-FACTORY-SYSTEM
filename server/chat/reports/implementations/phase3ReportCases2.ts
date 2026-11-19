// Extracted from ./phase3ReportShard.ts: report query handlers.
import { db, sql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";

export async function runPhase3FactoryKpi({
  companyId,
  dateFrom,
  dateTo,
  rowLimit,
  fmtDec,
}: {
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
}) {
  const rows = await db.execute<{
    date: string;
    kg_in: string | null;
    kg_pressed: string | null;
    total_bales_produced: number | null;
    waste_kg: string | null;
  }>(sql`
        SELECT date,
          CAST(total_kg_in AS numeric) AS kg_in,
          CAST(total_kg_pressed AS numeric) AS kg_pressed,
          total_bales_produced,
          CAST(total_waste_kg AS numeric) AS waste_kg
        FROM factory_daily_kpi_snapshots
        WHERE company_id = ${companyId}
          AND date BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY date DESC
        LIMIT ${rowLimit}
      `);
  let totKgIn = 0,
    totKgPressed = 0,
    totBales = 0,
    totWaste = 0;
  const tableRows2 = rows.rows.map((r) => {
    const kgIn = toMoney(r.kg_in).toNumber();
    const kgPressed = toMoney(r.kg_pressed).toNumber();
    const bales = r.total_bales_produced ?? 0;
    const waste = toMoney(r.waste_kg).toNumber();
    const efficiency = kgIn > 0 ? ((kgPressed / kgIn) * 100).toFixed(1) + "%" : "—";
    totKgIn += kgIn;
    totKgPressed += kgPressed;
    totBales += bales;
    totWaste += waste;
    return [String(r.date).slice(0, 10), fmtDec(kgIn), fmtDec(kgPressed), String(bales), fmtDec(waste), efficiency];
  });
  const avgEff = totKgIn > 0 ? ((totKgPressed / totKgIn) * 100).toFixed(1) + "%" : "—";
  if (tableRows2.length)
    tableRows2.push(["TOTAL", fmtDec(totKgIn), fmtDec(totKgPressed), String(totBales), fmtDec(totWaste), avgEff]);
  const stats3 = [
    { label: "Total Kg In", value: fmtDec(totKgIn) },
    { label: "Total Kg Pressed", value: fmtDec(totKgPressed) },
    { label: "Total Bales", value: String(totBales) },
    { label: "Total Waste Kg", value: fmtDec(totWaste) },
    { label: "Avg Efficiency", value: avgEff, highlight: "positive" },
  ];
  return {
    queryType: "factory_kpi",
    title: "Factory Daily KPIs",
    subtitle: `${dateFrom} → ${dateTo}`,
    stats: stats3,
    table: {
      headers: ["Date", "Kg In", "Kg Pressed", "Bales", "Waste Kg", "Efficiency"],
      rows: tableRows2,
    },
    noData: tableRows2.length === 0,
  };
}

export async function runPhase3FixedAssetsSummary({
  params,
  companyId,
  rowLimit,
  fmt,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const categoryFilter = params.entityName;
  const rows = await db.execute<{
    code: string;
    name: string;
    category: string | null;
    purchase_date: string | null;
    purchase_amount: string;
    depreciation_method: string | null;
    useful_life: number | null;
    active: boolean;
  }>(sql`
        SELECT fa.code, fa.name, fa.category,
          fa.purchase_date,
          CAST(fa.purchase_amount AS numeric) AS purchase_amount,
          fa.depreciation_method, fa.useful_life, fa.active
        FROM fixed_assets fa
        WHERE fa.company_id = ${companyId}
          ${categoryFilter ? sql`AND fa.category ILIKE ${"%" + categoryFilter + "%"}` : sql``}
        ORDER BY fa.category, fa.purchase_date DESC
        LIMIT ${rowLimit}
      `);
  let grandTotal = 0;
  const tableRows2 = rows.rows.map((r) => {
    const amt = toMoney(r.purchase_amount).toNumber();
    grandTotal += amt;
    return [
      r.code,
      r.name,
      r.category,
      String(r.purchase_date).slice(0, 10),
      fmt(amt),
      r.depreciation_method,
      r.useful_life ? `${r.useful_life} yr` : "—",
      r.active ? "Active" : "Inactive",
    ];
  });
  const stats3 = [
    { label: "Total Assets", value: String(tableRows2.length) },
    { label: "Total Purchase Value", value: fmt(grandTotal), highlight: "positive" },
  ];
  return {
    queryType: "fixed_assets_summary",
    title: categoryFilter ? `Fixed Assets — ${categoryFilter}` : "Fixed Assets Register",
    subtitle: `${tableRows2.length} asset(s)`,
    stats: stats3,
    table: {
      headers: ["Code", "Name", "Category", "Purchase Date", "Amount", "Depreciation", "Life", "Status"],
      rows: tableRows2,
    },
    noData: tableRows2.length === 0,
  };
}

export async function runPhase3BankTransactions({
  params,
  companyId,
  dateFrom,
  dateTo,
  rowLimit,
  fmt,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const accountName = params.entityName || params.locationName;
  const acctRows = await db.execute<{ id: number; name: string; account_type: string }>(sql`
        SELECT id, name, account_type FROM ledger_accounts
        WHERE company_id = ${companyId} AND LOWER(TRIM(account_type)) IN ('bank', 'cash') AND deleted_at IS NULL
          ${accountName ? sql`AND name ILIKE ${"%" + accountName + "%"}` : sql``}
        ORDER BY account_type, name
        LIMIT 1
      `);
  if (!acctRows.rows.length) {
    return {
      queryType: "bank_transactions",
      title: "Bank/Cash Transactions",
      summary: accountName ? `No account found matching "${accountName}".` : "Please specify an account name.",
    };
  }
  const acct3 = acctRows.rows[0];
  const txRows3 = await db.execute<{
    voucher_date: string;
    voucher_type: string;
    description: string | null;
    debit: string;
    credit: string;
  }>(sql`
        SELECT v.voucher_date, v.voucher_type, v.description,
          CAST(ve.debit_amount AS numeric) AS debit,
          CAST(ve.credit_amount AS numeric) AS credit
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL AND v.optional = false
        WHERE ve.ledger_account_id = ${acct3.id}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY v.voucher_date DESC, v.id DESC
        LIMIT ${rowLimit}
      `);
  const tableRows2 = txRows3.rows.map((r) => [
    String(r.voucher_date).slice(0, 10),
    r.voucher_type || "—",
    (r.description || "").slice(0, 40),
    toMoney(r.debit).toNumber() > 0 ? fmt(toMoney(r.debit).toNumber()) : "—",
    toMoney(r.credit).toNumber() > 0 ? fmt(toMoney(r.credit).toNumber()) : "—",
  ]);
  return {
    queryType: "bank_transactions",
    title: `Transactions: ${acct3.name}`,
    subtitle: `${dateFrom} → ${dateTo} · ${acct3.account_type} account`,
    table: { headers: ["Date", "Type", "Description", "In (Dr)", "Out (Cr)"], rows: tableRows2 },
    noData: tableRows2.length === 0,
  };
}
