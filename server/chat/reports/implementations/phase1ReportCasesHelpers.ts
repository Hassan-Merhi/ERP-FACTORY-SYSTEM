// Extracted from ./phase1ReportCases.ts
import {
  db,
  sql,
  nonPartyAccountTypesSql,
  schema,
  eq,
  and,
  desc,
  isNull,
  ilike,
  profitAndLossAccountTypesSql,
} from "./reportShardSupport";
import type { DataQueryContext } from "../types";
import { plusMoney, toMoney, MoneyDecimal } from "../../../lib/money";
import { classifyAccountType, expenseCategory } from "../../../services/accounting/accountClassification";
import { notFiscalClosingVoucher } from "../../../services/accounting/balances/periodReportRules";

export async function runPhase1OutstandingSuppliers({
  companyId,
  rowLimit,
  fmt,
}: {
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const rows = await db.execute<{
    name: string;
    opening_balance: string | null;
    opening_balance_side: string | null;
    total_debit: string;
    total_credit: string;
  }>(sql`
        SELECT la.name, la.opening_balance, la.opening_balance_side,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS total_debit,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS total_credit
        FROM ledger_accounts la
        LEFT JOIN voucher_entries ve ON ve.ledger_account_id = la.id
        LEFT JOIN vouchers v ON v.id = ve.voucher_id
        WHERE la.company_id = ${companyId} AND la.active = true AND la.deleted_at IS NULL
          AND LOWER(TRIM(la.account_type)) NOT IN (${nonPartyAccountTypesSql()})
        GROUP BY la.id, la.name, la.opening_balance, la.opening_balance_side
        HAVING (
          CASE WHEN la.opening_balance_side = 'Cr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END
          + COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0)
        ) < -100
        ORDER BY (
          CASE WHEN la.opening_balance_side = 'Cr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END
          + COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0)
        ) ASC
        LIMIT ${rowLimit}
      `);
  const tableRows = rows.rows.map((row) => {
    const ob = toMoney(row.opening_balance).toNumber();
    const obAdj = row.opening_balance_side === "Cr" ? -ob : ob;
    const bal = plusMoney(obAdj, toMoney(row.total_debit).minus(toMoney(row.total_credit)));
    return [row.name, fmt(Math.abs(bal))];
  });
  return {
    queryType: "outstanding_suppliers",
    title: "Outstanding Supplier Balances",
    subtitle: "Largest amounts owed to suppliers",
    table: { headers: ["Supplier / Account", "Amount Owed"], rows: tableRows },
    noData: tableRows.length === 0,
  };
}

export async function runPhase1CustomerStatement({
  params,
  companyId,
  rowLimit,
  fmtDec,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
}) {
  const name = params.entityName;
  if (!name) {
    return {
      queryType: "customer_statement",
      title: "Customer Statement",
      summary: "Please specify a customer name.",
    };
  }
  const accts = await db
    .select({ id: schema.ledgerAccounts.id, name: schema.ledgerAccounts.name })
    .from(schema.ledgerAccounts)
    .where(
      and(
        eq(schema.ledgerAccounts.companyId, companyId),
        ilike(schema.ledgerAccounts.name, `%${name}%`),
        isNull(schema.ledgerAccounts.deletedAt)
      )
    )
    .limit(3);
  if (!accts.length) {
    return {
      queryType: "customer_statement",
      title: `Customer: ${name}`,
      summary: "No account found matching that name.",
    };
  }
  const acct = accts[0];
  const txRows = await db
    .select({
      voucherDate: schema.vouchers.voucherDate,
      voucherType: schema.vouchers.voucherType,
      description: schema.vouchers.description,
      debitAmount: schema.voucherEntries.debitAmount,
      creditAmount: schema.voucherEntries.creditAmount,
    })
    .from(schema.voucherEntries)
    .innerJoin(
      schema.vouchers,
      and(
        eq(schema.voucherEntries.voucherId, schema.vouchers.id),
        eq(schema.vouchers.optional, false),
        isNull(schema.vouchers.deletedAt)
      )
    )
    .where(eq(schema.voucherEntries.ledgerAccountId, acct.id))
    .orderBy(desc(schema.vouchers.voucherDate))
    .limit(rowLimit);
  const tableRows = txRows.map((r) => [
    r.voucherDate || "—",
    r.voucherType || "—",
    (r.description || "").slice(0, 40),
    toMoney(r.debitAmount).toNumber() > 0 ? fmtDec(toMoney(r.debitAmount!).toNumber()) : "—",
    toMoney(r.creditAmount).toNumber() > 0 ? fmtDec(toMoney(r.creditAmount!).toNumber()) : "—",
  ]);
  return {
    queryType: "customer_statement",
    title: `Statement: ${acct.name}`,
    subtitle: `Last ${txRows.length} transaction(s)`,
    table: { headers: ["Date", "Type", "Description", "Debit", "Credit"], rows: tableRows },
    noData: tableRows.length === 0,
  };
}

export async function runPhase1PlSummary({
  companyId,
  dateFrom,
  dateTo,
  fmt,
}: {
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  fmt: DataQueryContext["fmt"];
}) {
  const rows = await db.execute<{
    account_type: string;
    sub_type: string | null;
    total_debit: string;
    total_credit: string;
  }>(sql`
        SELECT la.account_type, la.sub_type,
          COALESCE(SUM(CAST(ve.debit_amount AS numeric)), 0) AS total_debit,
          COALESCE(SUM(CAST(ve.credit_amount AS numeric)), 0) AS total_credit
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.optional = false AND v.deleted_at IS NULL
          AND v.company_id = ${companyId}
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.company_id = ${companyId}
        WHERE COALESCE(v.effective_date, v.voucher_date) BETWEEN ${dateFrom} AND ${dateTo}
          AND ${notFiscalClosingVoucher("v")}
          AND LOWER(TRIM(la.account_type)) IN (${profitAndLossAccountTypesSql()})
        GROUP BY la.account_type, la.sub_type
      `);
  // Shared classifier: every income type is revenue (Indirect Income and
  // Revenue included); Direct Expense is cost of goods sold; every other
  // expense (Government Taxes included) is operating. Profit is equity and
  // no longer read as an expense.
  let revenueExact = new MoneyDecimal(0),
    cogsExact = new MoneyDecimal(0),
    opexExact = new MoneyDecimal(0);
  for (const row of rows.rows) {
    const debitMinusCredit = toMoney(row.total_debit).minus(toMoney(row.total_credit));
    if (classifyAccountType(row.account_type, row.sub_type) === "income")
      revenueExact = revenueExact.minus(debitMinusCredit);
    else if (expenseCategory(row.account_type, row.sub_type) === "Direct Expense")
      cogsExact = cogsExact.plus(debitMinusCredit);
    else opexExact = opexExact.plus(debitMinusCredit);
  }
  const revenue = revenueExact.toNumber();
  const cogs = cogsExact.toNumber();
  const opex = opexExact.toNumber();
  const gross = revenueExact.minus(cogsExact).toNumber();
  const net = revenueExact.minus(cogsExact).minus(opexExact).toNumber();
  return {
    queryType: "pl_summary",
    title: "Profit & Loss Summary",
    subtitle: `${dateFrom} to ${dateTo}`,
    stats: [
      { label: "Revenue", value: fmt(revenue), highlight: revenue >= 0 ? "positive" : "negative" },
      { label: "Cost of Goods Sold", value: fmt(cogs), highlight: "muted" },
      { label: "Gross Profit", value: fmt(gross), highlight: gross >= 0 ? "positive" : "negative" },
      { label: "Operating Expenses", value: fmt(opex), highlight: "muted" },
      { label: "Net Profit / (Loss)", value: fmt(net), highlight: net >= 0 ? "positive" : "negative" },
    ],
  };
}
