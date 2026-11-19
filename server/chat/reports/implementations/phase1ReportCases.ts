// Extracted from ./phase1ReportShard.ts: report query handlers.
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

export async function runPhase1WorkerAttendance({
  companyId,
  dateFrom,
  dateTo,
}: {
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
}) {
  const rows = await db.execute<{ status: string; count: string; workers: string }>(sql`
        SELECT fa.status, COUNT(*) AS count, COUNT(DISTINCT fa.worker_id) AS workers
        FROM factory_attendance fa
        WHERE fa.company_id = ${companyId}
          AND fa.attendance_date BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY fa.status ORDER BY fa.status
      `);
  const totalRecords = rows.rows.reduce((s: number, r) => s + parseInt(r.count || "0"), 0);
  const stats = rows.rows.map((r) => ({
    label: r.status,
    value: `${r.count} records · ${r.workers} worker(s)`,
    highlight: r.status === "Present" ? "positive" : r.status === "Absent" ? "negative" : "muted",
  }));
  if (!stats.length)
    stats.push({ label: "No Data", value: "No attendance records for this period.", highlight: "muted" });
  return {
    queryType: "worker_attendance",
    title: "Worker Attendance",
    subtitle: `${dateFrom} to ${dateTo} — ${totalRecords} record(s)`,
    stats,
  };
}

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

export async function runPhase1TopCustomers({
  companyId,
  dateFrom,
  dateTo,
  rowLimit,
  fmt,
}: {
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const rows = await db.execute<{ name: string; tx_count: string; total_received: string }>(sql`
        SELECT la.name,
          COUNT(DISTINCT v.id) AS tx_count,
          COALESCE(SUM(CAST(ve.credit_amount AS numeric)), 0) AS total_received
        FROM ledger_accounts la
        JOIN voucher_entries ve ON ve.ledger_account_id = la.id
        JOIN vouchers v ON v.id = ve.voucher_id AND v.optional = false AND v.deleted_at IS NULL AND v.voucher_type = 'Receipt'
        WHERE la.company_id = ${companyId} AND la.active = true
          AND COALESCE(v.effective_date, v.voucher_date) BETWEEN ${dateFrom} AND ${dateTo}
          AND LOWER(TRIM(la.account_type)) NOT IN (${nonPartyAccountTypesSql()})
          AND CAST(ve.credit_amount AS numeric) > 0
        GROUP BY la.id, la.name
        ORDER BY total_received DESC
        LIMIT ${rowLimit}
      `);
  const tableRows = rows.rows.map((r, i) => [
    String(i + 1),
    r.name,
    String(r.tx_count),
    fmt(toMoney(r.total_received).toNumber()),
  ]);
  return {
    queryType: "top_customers",
    title: `Top ${tableRows.length} Customers by Revenue`,
    subtitle: `${dateFrom} to ${dateTo}`,
    table: { headers: ["#", "Customer", "Transactions", "Amount Received"], rows: tableRows },
    noData: tableRows.length === 0,
  };
}

export async function runPhase1SupplierStatement({
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
      queryType: "supplier_statement",
      title: "Supplier Statement",
      summary: "Please specify a supplier name.",
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
      queryType: "supplier_statement",
      title: `Supplier: ${name}`,
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
    queryType: "supplier_statement",
    title: `Supplier: ${acct.name}`,
    subtitle: `Last ${txRows.length} transaction(s)`,
    table: { headers: ["Date", "Type", "Description", "Debit", "Credit"], rows: tableRows },
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

export async function runPhase1OverduePayments({
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
    last_tx: string | null;
  }>(sql`
        SELECT la.name, la.opening_balance, la.opening_balance_side,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS total_debit,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS total_credit,
          MAX(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN v.voucher_date END) AS last_tx
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
        ) > 100
        ORDER BY (
          CASE WHEN la.opening_balance_side = 'Cr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END
          + COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0)
        ) DESC
        LIMIT ${rowLimit}
      `);
  const tableRows = rows.rows.map((row) => {
    const ob = toMoney(row.opening_balance).toNumber();
    const obAdj = row.opening_balance_side === "Cr" ? -ob : ob;
    const bal = plusMoney(obAdj, toMoney(row.total_debit).minus(toMoney(row.total_credit)));
    const lastTx = row.last_tx ? String(row.last_tx).slice(0, 10) : "—";
    return [row.name, fmt(bal), lastTx];
  });
  return {
    queryType: "overdue_payments",
    title: "Outstanding Receivables",
    subtitle: "Accounts with debit balance (they owe you)",
    table: { headers: ["Account", "Balance Owed", "Last Transaction"], rows: tableRows },
    noData: tableRows.length === 0,
  };
}

export async function runPhase1CashPosition({
  companyId,
  fmt,
  todayStr,
}: {
  companyId: DataQueryContext["companyId"];
  fmt: DataQueryContext["fmt"];
  todayStr: DataQueryContext["todayStr"];
}) {
  const rows = await db.execute<{
    name: string;
    account_type: string;
    opening_balance: string | null;
    opening_balance_side: string | null;
    total_debit: string;
    total_credit: string;
  }>(sql`
        SELECT la.name, la.account_type, la.opening_balance, la.opening_balance_side,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS total_debit,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS total_credit
        FROM ledger_accounts la
        LEFT JOIN voucher_entries ve ON ve.ledger_account_id = la.id
        LEFT JOIN vouchers v ON v.id = ve.voucher_id
        WHERE la.company_id = ${companyId} AND LOWER(TRIM(la.account_type)) IN ('cash', 'bank') AND la.active = true AND la.deleted_at IS NULL
        GROUP BY la.id, la.name, la.account_type, la.opening_balance, la.opening_balance_side
        ORDER BY la.account_type, la.name
      `);
  let grandTotal = 0;
  const stats = rows.rows.map((row) => {
    const ob = toMoney(row.opening_balance).toNumber();
    const obAdj = row.opening_balance_side === "Cr" ? -ob : ob;
    const bal = plusMoney(obAdj, toMoney(row.total_debit).minus(toMoney(row.total_credit)));
    grandTotal += bal;
    return {
      label: `${row.name} (${row.account_type})`,
      value: fmt(bal),
      highlight: bal >= 0 ? "positive" : "negative",
    };
  });
  stats.push({
    label: "TOTAL CASH & BANK",
    value: fmt(grandTotal),
    highlight: grandTotal >= 0 ? "positive" : "negative",
  });
  return {
    queryType: "cash_position",
    title: "Cash & Bank Positions",
    subtitle: `As of ${todayStr}`,
    stats,
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
