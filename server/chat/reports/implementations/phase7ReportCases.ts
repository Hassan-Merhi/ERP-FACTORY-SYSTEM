// Extracted from ./phase7ReportShard.ts: report query handlers.
import { db, sql } from "./reportShardSupport";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext } from "../types";

export async function runPhase7PendingContainerSales({
  companyId,
  rowLimit,
  fmt,
}: {
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  fmt: DataQueryContext["fmt"];
}) {
  const rows = await db.execute<{
    sale_date: string;
    invoice_number: string | null;
    container_number: string | null;
    customer: string | null;
    currency: string;
    total_amount: string;
    paid_amount: string;
    outstanding: string;
    payment_status: string | null;
  }>(sql`
        SELECT cs.sale_date, cs.invoice_number, c.container_number,
          cu.legal_name AS customer, cs.currency,
          CAST(cs.total_amount AS numeric) AS total_amount,
          CAST(cs.paid_amount AS numeric) AS paid_amount,
          CAST(cs.total_amount AS numeric) - CAST(cs.paid_amount AS numeric) AS outstanding,
          cs.payment_status
        FROM container_sales cs
        JOIN containers c ON c.id = cs.container_id
        JOIN customers cu ON cu.id = cs.customer_id
        WHERE cs.company_id = ${companyId}
          AND cs.payment_status != 'PAID'
        ORDER BY cs.sale_date ASC
        LIMIT ${rowLimit}
      `);
  let totalOutstanding = 0;
  const tableRows7 = rows.rows.map((r) => {
    const outstanding = toMoney(r.outstanding).toNumber();
    totalOutstanding += outstanding;
    return [
      String(r.sale_date).slice(0, 10),
      r.invoice_number || "—",
      r.container_number,
      r.customer,
      fmt(toMoney(r.total_amount).toNumber()),
      fmt(toMoney(r.paid_amount).toNumber()),
      fmt(outstanding),
      r.payment_status,
      r.currency,
    ];
  });
  const stats7 = [
    { label: "Pending Sales", value: String(tableRows7.length) },
    { label: "Total Outstanding", value: fmt(totalOutstanding), highlight: "negative" },
  ];
  return {
    queryType: "pending_container_sales",
    title: "Pending Container Sales",
    subtitle: `${tableRows7.length} unpaid/partial container sale(s)`,
    stats: stats7,
    table: {
      headers: [
        "Sale Date",
        "Invoice #",
        "Container",
        "Customer",
        "Total",
        "Paid",
        "Outstanding",
        "Status",
        "Currency",
      ],
      rows: tableRows7,
    },
    noData: tableRows7.length === 0,
  };
}

export async function runPhase7ContainerTracking({
  params,
  companyId,
  rowLimit,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
}) {
  const cn7 = params.containerNumber || params.entityName;
  if (!cn7) {
    return {
      queryType: "container_tracking",
      title: "Container Tracking",
      summary: "Please specify a container number.",
    };
  }
  const containerRow7 = await db.execute<{
    id: number;
    container_number: string;
    status: string;
    eta: string | null;
    transporter: string | null;
    tracking_last_location: string | null;
    tracking_last_description: string | null;
    tracking_changed_at: Date | null;
  }>(sql`
        SELECT c.id, c.container_number, c.status, c.eta, c.transporter,
          c.tracking_last_location, c.tracking_last_description, c.tracking_changed_at
        FROM containers c
        WHERE c.company_id = ${companyId}
          AND c.container_number ILIKE ${"%" + cn7 + "%"}
        LIMIT 1
      `);
  if (!containerRow7.rows.length) {
    return {
      queryType: "container_tracking",
      title: "Container Tracking",
      summary: `No container found matching "${cn7}".`,
    };
  }
  const ctr7 = containerRow7.rows[0];
  const evtRows = await db.execute<{
    event_time: Date | null;
    event_status: string | null;
    event_location: string | null;
    event_description: string | null;
    provider: string | null;
  }>(sql`
        SELECT cte.event_time, cte.event_status, cte.event_location, cte.event_description, cte.provider
        FROM container_tracking_events cte
        WHERE cte.container_id = ${ctr7.id}
        ORDER BY cte.event_time DESC
        LIMIT ${rowLimit}
      `);
  const tableRows7 = evtRows.rows.map((r) => [
    r.event_time ? String(r.event_time).slice(0, 16) : "—",
    r.event_status || "—",
    r.event_location || "—",
    (r.event_description || "").slice(0, 50),
    r.provider,
  ]);
  const stats7 = [
    { label: "Container #", value: ctr7.container_number },
    { label: "Status", value: ctr7.status },
    { label: "ETA", value: ctr7.eta ? String(ctr7.eta).slice(0, 10) : "—" },
    { label: "Transporter", value: ctr7.transporter || "—" },
    { label: "Last Location", value: ctr7.tracking_last_location || "—" },
  ];
  return {
    queryType: "container_tracking",
    title: `Tracking: ${ctr7.container_number}`,
    subtitle: ctr7.tracking_last_description
      ? `Latest: ${(ctr7.tracking_last_description as string).slice(0, 60)}`
      : `${tableRows7.length} event(s)`,
    stats: stats7,
    table: { headers: ["Time", "Status", "Location", "Description", "Provider"], rows: tableRows7 },
    noData: tableRows7.length === 0,
  };
}

export async function runPhase7StockAdjustments({
  params,
  companyId,
  dateFrom,
  dateTo,
  rowLimit,
  fmtDec,
  fmt,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  dateTo: DataQueryContext["dateTo"];
  rowLimit: DataQueryContext["rowLimit"];
  fmtDec: DataQueryContext["fmtDec"];
  fmt: DataQueryContext["fmt"];
}) {
  const adjTypeFilter = params.entityName?.toLowerCase().includes("consum")
    ? "Consumption"
    : params.entityName?.toLowerCase().includes("prod")
      ? "Production"
      : null;
  const rows = await db.execute<{
    voucher_date: string;
    voucher_number: string;
    adjustment_type: string;
    location: string | null;
    item_name: string;
    code: string | null;
    uom: string | null;
    qty: string;
    rate: string;
    total_amount: string;
  }>(sql`
        SELECT v.voucher_date, v.voucher_number, sav.adjustment_type,
          l.name AS location, si.name AS item_name, si.code, si.uom,
          CAST(sai.quantity AS numeric) AS qty,
          CAST(sai.rate AS numeric) AS rate,
          CAST(sai.total_amount AS numeric) AS total_amount
        FROM stock_adjustment_items sai
        JOIN stock_adjustment_vouchers sav ON sav.id = sai.adjustment_id
        JOIN vouchers v ON v.id = sav.voucher_id AND v.deleted_at IS NULL
        JOIN stock_items si ON si.id = sai.stock_item_id
        JOIN locations l ON l.id = sav.location_id
        WHERE v.company_id = ${companyId}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
          ${adjTypeFilter ? sql`AND sav.adjustment_type = ${adjTypeFilter}` : sql``}
        ORDER BY v.voucher_date DESC
        LIMIT ${rowLimit}
      `);
  let totalProd = 0,
    totalCons = 0;
  const tableRows7 = rows.rows.map((r) => {
    const qty = toMoney(r.qty).toNumber();
    const amt = toMoney(r.total_amount).toNumber();
    if (r.adjustment_type === "Production") totalProd += amt;
    else totalCons += amt;
    return [
      String(r.voucher_date).slice(0, 10),
      r.voucher_number,
      r.adjustment_type,
      r.location,
      r.item_name,
      `${fmtDec(Math.abs(qty))} ${r.uom}`,
      fmt(Math.abs(amt)),
    ];
  });
  const stats7 = [
    { label: "Total Entries", value: String(tableRows7.length) },
    { label: "Production Value", value: fmt(totalProd), highlight: "positive" },
    { label: "Consumption Value", value: fmt(totalCons) },
  ];
  return {
    queryType: "stock_adjustments",
    title: adjTypeFilter ? `Stock Adjustments — ${adjTypeFilter}` : "Stock Adjustments",
    subtitle: `${dateFrom} → ${dateTo}`,
    stats: stats7,
    table: {
      headers: ["Date", "Voucher #", "Type", "Location", "Item", "Qty", "Amount"],
      rows: tableRows7,
    },
    noData: tableRows7.length === 0,
  };
}

export async function runPhase7BankAccountList({
  companyId,
  fmt,
  todayStr,
}: {
  companyId: DataQueryContext["companyId"];
  fmt: DataQueryContext["fmt"];
  todayStr: DataQueryContext["todayStr"];
}) {
  const rows = await db.execute<{
    code: string;
    name: string;
    bank_name: string | null;
    account_number: string | null;
    opening_balance: string;
    opening_balance_side: string | null;
    active: boolean;
    total_dr: string;
    total_cr: string;
  }>(sql`
        SELECT ba.code, ba.name, ba.bank_name, ba.account_number,
          CAST(ba.opening_balance AS numeric) AS opening_balance,
          ba.opening_balance_side, ba.active,
          COALESCE(SUM(CAST(ve.debit_amount AS numeric)), 0) AS total_dr,
          COALESCE(SUM(CAST(ve.credit_amount AS numeric)), 0) AS total_cr
        FROM bank_accounts ba
        LEFT JOIN voucher_entries ve ON ve.ledger_account_id = ba.linked_ledger_id
        LEFT JOIN vouchers v ON v.id = ve.voucher_id
          AND v.deleted_at IS NULL AND v.optional = false
        WHERE ba.company_id = ${companyId}
          AND ba.deleted_at IS NULL
        GROUP BY ba.id, ba.code, ba.name, ba.bank_name, ba.account_number,
          ba.opening_balance, ba.opening_balance_side, ba.active
        ORDER BY ba.name
      `);
  let grandBalance = 0;
  const tableRows7 = rows.rows.map((r) => {
    const ob = toMoney(r.opening_balance).toNumber() * (r.opening_balance_side === "Cr" ? -1 : 1);
    const dr = toMoney(r.total_dr).toNumber();
    const cr = toMoney(r.total_cr).toNumber();
    const balance = ob + dr - cr;
    grandBalance += balance;
    const balLabel = balance >= 0 ? fmt(balance) + " Dr" : fmt(Math.abs(balance)) + " Cr";
    return [r.code, r.name, r.bank_name, r.account_number, balLabel];
  });
  tableRows7.push([
    "",
    "TOTAL BALANCE",
    "",
    "",
    grandBalance >= 0 ? fmt(grandBalance) + " Dr" : fmt(Math.abs(grandBalance)) + " Cr",
  ]);
  const stats7 = [
    { label: "Bank Accounts", value: String(tableRows7.length - 1) },
    {
      label: "Net Balance",
      value: grandBalance >= 0 ? fmt(grandBalance) + " Dr" : fmt(Math.abs(grandBalance)) + " Cr",
      highlight: grandBalance >= 0 ? "positive" : "negative",
    },
  ];
  return {
    queryType: "bank_account_list",
    title: "Bank Account Balances",
    subtitle: `As of ${todayStr}`,
    stats: stats7,
    table: { headers: ["Code", "Account Name", "Bank", "Account No.", "Balance"], rows: tableRows7 },
    noData: tableRows7.length <= 1,
  };
}

export async function runPhase7AuditTrail({
  params,
  companyId,
  dateFrom,
  rowLimit,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  dateFrom: DataQueryContext["dateFrom"];
  rowLimit: DataQueryContext["rowLimit"];
}) {
  const tableFilter7 = params.entityName;
  const rows = await db.execute<{
    username: string | null;
    action: string;
    table_name: string | null;
    record_identifier: string | null;
    created_at: Date;
  }>(sql`
        SELECT al.username, al.action, al.table_name, al.record_identifier,
          al.created_at
        FROM audit_log al
        WHERE al.company_id = ${companyId}
          AND al.created_at >= ${dateFrom}
          ${tableFilter7 ? sql`AND (al.table_name ILIKE ${"%" + tableFilter7 + "%"} OR al.record_identifier ILIKE ${"%" + tableFilter7 + "%"})` : sql``}
        ORDER BY al.created_at DESC
        LIMIT ${rowLimit}
      `);
  const actionMap: Record<string, number> = {};
  const tableRows7 = rows.rows.map((r) => {
    actionMap[r.action] = (actionMap[r.action] || 0) + 1;
    return [String(r.created_at).slice(0, 16), r.username, r.action, r.table_name, r.record_identifier || "—"];
  });
  const stats7 = [
    { label: "Total Events", value: String(tableRows7.length) },
    ...Object.entries(actionMap).map(([a, c]) => ({
      label: a.charAt(0).toUpperCase() + a.slice(1) + "s",
      value: String(c),
    })),
  ];
  return {
    queryType: "audit_trail",
    title: tableFilter7 ? `Audit Trail: ${tableFilter7}` : "Audit Trail",
    subtitle: `Since ${dateFrom} · most recent first`,
    stats: stats7,
    table: { headers: ["Timestamp", "User", "Action", "Table", "Record"], rows: tableRows7 },
    noData: tableRows7.length === 0,
  };
}
