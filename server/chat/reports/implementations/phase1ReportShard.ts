import {
  db,
  schema,
  eq,
  and,
  desc,
  sql,
  isNull,
  asc,
  ilike,
  nonPartyAccountTypesSql,
  profitAndLossAccountTypesSql,
} from "./reportShardSupport";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { classifyAccountType, expenseCategory } from "../../../services/accounting/accountClassification";
import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import { notFiscalClosingVoucher } from "../../../services/accounting/balances/periodReportRules";

export const phase1QueryTypes = [
  "pl_summary",
  "cash_position",
  "overdue_payments",
  "customer_statement",
  "supplier_statement",
  "top_customers",
  "outstanding_suppliers",
  "worker_attendance",
  "bale_production",
  "container_status",
  "containers_pending_offload",
] as const;

async function runPhase1Report(ctx: DataQueryContext): Promise<DataQueryResult> {
  const { companyId, params, dateFrom, dateTo, todayStr, rowLimit, userMessage, fmt, fmtDec } = ctx;
  let dataQueryResult: DataQueryResult;

  switch (params.queryType) {
    case "pl_summary": {
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
      dataQueryResult = {
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
      break;
    }

    case "cash_position": {
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
        const ob = parseFloat(row.opening_balance || "0");
        const obAdj = row.opening_balance_side === "Cr" ? -ob : ob;
        const bal = obAdj + parseFloat(row.total_debit || "0") - parseFloat(row.total_credit || "0");
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
      dataQueryResult = {
        queryType: "cash_position",
        title: "Cash & Bank Positions",
        subtitle: `As of ${todayStr}`,
        stats,
      };
      break;
    }

    case "overdue_payments": {
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
        const ob = parseFloat(row.opening_balance || "0");
        const obAdj = row.opening_balance_side === "Cr" ? -ob : ob;
        const bal = obAdj + parseFloat(row.total_debit || "0") - parseFloat(row.total_credit || "0");
        const lastTx = row.last_tx ? String(row.last_tx).slice(0, 10) : "—";
        return [row.name, fmt(bal), lastTx];
      });
      dataQueryResult = {
        queryType: "overdue_payments",
        title: "Outstanding Receivables",
        subtitle: "Accounts with debit balance (they owe you)",
        table: { headers: ["Account", "Balance Owed", "Last Transaction"], rows: tableRows },
        noData: tableRows.length === 0,
      };
      break;
    }

    case "customer_statement": {
      const name = params.entityName;
      if (!name) {
        dataQueryResult = {
          queryType: "customer_statement",
          title: "Customer Statement",
          summary: "Please specify a customer name.",
        };
        break;
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
        dataQueryResult = {
          queryType: "customer_statement",
          title: `Customer: ${name}`,
          summary: "No account found matching that name.",
        };
        break;
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
        parseFloat(r.debitAmount || "0") > 0 ? fmtDec(parseFloat(r.debitAmount!)) : "—",
        parseFloat(r.creditAmount || "0") > 0 ? fmtDec(parseFloat(r.creditAmount!)) : "—",
      ]);
      dataQueryResult = {
        queryType: "customer_statement",
        title: `Statement: ${acct.name}`,
        subtitle: `Last ${txRows.length} transaction(s)`,
        table: { headers: ["Date", "Type", "Description", "Debit", "Credit"], rows: tableRows },
        noData: tableRows.length === 0,
      };
      break;
    }

    case "supplier_statement": {
      const name = params.entityName;
      if (!name) {
        dataQueryResult = {
          queryType: "supplier_statement",
          title: "Supplier Statement",
          summary: "Please specify a supplier name.",
        };
        break;
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
        dataQueryResult = {
          queryType: "supplier_statement",
          title: `Supplier: ${name}`,
          summary: "No account found matching that name.",
        };
        break;
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
        parseFloat(r.debitAmount || "0") > 0 ? fmtDec(parseFloat(r.debitAmount!)) : "—",
        parseFloat(r.creditAmount || "0") > 0 ? fmtDec(parseFloat(r.creditAmount!)) : "—",
      ]);
      dataQueryResult = {
        queryType: "supplier_statement",
        title: `Supplier: ${acct.name}`,
        subtitle: `Last ${txRows.length} transaction(s)`,
        table: { headers: ["Date", "Type", "Description", "Debit", "Credit"], rows: tableRows },
        noData: tableRows.length === 0,
      };
      break;
    }

    case "top_customers": {
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
        fmt(parseFloat(r.total_received || "0")),
      ]);
      dataQueryResult = {
        queryType: "top_customers",
        title: `Top ${tableRows.length} Customers by Revenue`,
        subtitle: `${dateFrom} to ${dateTo}`,
        table: { headers: ["#", "Customer", "Transactions", "Amount Received"], rows: tableRows },
        noData: tableRows.length === 0,
      };
      break;
    }

    case "outstanding_suppliers": {
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
        const ob = parseFloat(row.opening_balance || "0");
        const obAdj = row.opening_balance_side === "Cr" ? -ob : ob;
        const bal = obAdj + parseFloat(row.total_debit || "0") - parseFloat(row.total_credit || "0");
        return [row.name, fmt(Math.abs(bal))];
      });
      dataQueryResult = {
        queryType: "outstanding_suppliers",
        title: "Outstanding Supplier Balances",
        subtitle: "Largest amounts owed to suppliers",
        table: { headers: ["Supplier / Account", "Amount Owed"], rows: tableRows },
        noData: tableRows.length === 0,
      };
      break;
    }

    case "worker_attendance": {
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
      dataQueryResult = {
        queryType: "worker_attendance",
        title: "Worker Attendance",
        subtitle: `${dateFrom} to ${dateTo} — ${totalRecords} record(s)`,
        stats,
      };
      break;
    }

    case "bale_production": {
      const rows = await db.execute<{ status: string; count: string; total_weight: string }>(sql`
        SELECT fb.status, COUNT(*) AS count,
          COALESCE(SUM(CAST(fb.weight_kg AS numeric)), 0) AS total_weight
        FROM factory_bales fb
        WHERE fb.company_id = ${companyId} AND fb.deleted_at IS NULL
          AND fb.created_at::date BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY fb.status ORDER BY count DESC
      `);
      const totalBales = rows.rows.reduce((s: number, r) => s + parseInt(r.count || "0"), 0);
      const totalWeight = rows.rows.reduce((s: number, r) => s + parseFloat(r.total_weight || "0"), 0);
      const tableRows = rows.rows.map((r) => [
        String(r.status).replace(/_/g, " "),
        String(r.count),
        fmtDec(parseFloat(r.total_weight || "0")) + " kg",
      ]);
      dataQueryResult = {
        queryType: "bale_production",
        title: "Bale Production Summary",
        subtitle: `${dateFrom} to ${dateTo}`,
        stats: [
          { label: "Total Bales", value: fmt(totalBales), highlight: "positive" },
          { label: "Total Weight", value: fmtDec(totalWeight) + " kg", highlight: "positive" },
        ],
        table: tableRows.length > 0 ? { headers: ["Status", "Bales", "Weight"], rows: tableRows } : undefined,
        noData: totalBales === 0,
      };
      break;
    }

    case "container_status": {
      const num = params.containerNumber || userMessage.match(/\b([A-Z]{4}\d{6,7})\b/)?.[1];
      if (!num) {
        dataQueryResult = {
          queryType: "container_status",
          title: "Container Status",
          summary: "Please specify a container number (e.g. ABCU1234567).",
        };
        break;
      }
      const [container] = await db
        .select({
          containerNumber: schema.containers.containerNumber,
          status: schema.containers.status,
          importDate: schema.containers.importDate,
          eta: schema.containers.eta,
          offloadDate: schema.containers.offloadDate,
          transporter: schema.containers.transporter,
          trackingLocation: schema.containers.trackingLocation,
          trackingLastStatus: schema.containers.trackingLastStatus,
          trackingLastDescription: schema.containers.trackingLastDescription,
          trackingLastLocation: schema.containers.trackingLastLocation,
          borderDate: schema.containers.borderDate,
          grandTotal: schema.containers.grandTotal,
        })
        .from(schema.containers)
        .where(and(eq(schema.containers.companyId, companyId), ilike(schema.containers.containerNumber, `%${num}%`)))
        .limit(1);
      if (!container) {
        dataQueryResult = {
          queryType: "container_status",
          title: `Container: ${num}`,
          summary: "Container not found.",
        };
        break;
      }
      const stats = [
        { label: "Container #", value: container.containerNumber, highlight: "neutral" },
        {
          label: "Status",
          value: container.status,
          highlight: container.status === "OFFLOADED" ? "positive" : "neutral",
        },
        { label: "Import Date", value: container.importDate || "—", highlight: "muted" },
        { label: "ETA", value: container.eta || "—", highlight: "muted" },
        {
          label: "Offload Date",
          value: container.offloadDate || "Not yet offloaded",
          highlight: container.offloadDate ? "positive" : "muted",
        },
        { label: "Transporter", value: container.transporter || "—", highlight: "muted" },
      ];
      if (container.trackingLastStatus)
        stats.push({ label: "Tracking Status", value: container.trackingLastStatus, highlight: "neutral" });
      if (container.trackingLastLocation)
        stats.push({ label: "Last Location", value: container.trackingLastLocation, highlight: "neutral" });
      if (container.trackingLastDescription)
        stats.push({ label: "Last Update", value: container.trackingLastDescription, highlight: "muted" });
      dataQueryResult = {
        queryType: "container_status",
        title: `Container: ${container.containerNumber}`,
        subtitle: `Status: ${container.status}`,
        stats,
      };
      break;
    }

    case "containers_pending_offload": {
      const pending = await db
        .select({
          containerNumber: schema.containers.containerNumber,
          status: schema.containers.status,
          eta: schema.containers.eta,
          transporter: schema.containers.transporter,
        })
        .from(schema.containers)
        .where(and(eq(schema.containers.companyId, companyId), isNull(schema.containers.offloadDate)))
        .orderBy(asc(schema.containers.eta))
        .limit(rowLimit);
      const tableRows = pending.map((c) => [c.containerNumber, c.status, c.eta || "—", c.transporter || "—"]);
      dataQueryResult = {
        queryType: "containers_pending_offload",
        title: "Containers Pending Offload",
        subtitle: `${pending.length} container(s) not yet offloaded`,
        table: { headers: ["Container #", "Status", "ETA", "Transporter"], rows: tableRows },
        noData: pending.length === 0,
      };
      break;
    }

    default:
      return undefined;
  }

  return dataQueryResult;
}

export const phase1ReportShard: ReportImplementationShard = {
  name: "phase-1",
  queryTypes: phase1QueryTypes,
  run: runPhase1Report,
};
