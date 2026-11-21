// Extracted from ./phase5ReportShard.ts: report query handlers.
import { db, sql } from "./reportShardSupport";
import type { DataQueryContext } from "../types";
import { toMoney } from "../../../lib/money";
export { runPhase5WorkerDocumentExpiry, runPhase5PurchaseOrderDetail } from "./phase5ReportCasesHelpers";

export async function runPhase5ContainerCostBreakdown({
  params,
  companyId,
  fmtDec,
  fmt,
}: {
  params: DataQueryContext["params"];
  companyId: DataQueryContext["companyId"];
  fmtDec: DataQueryContext["fmtDec"];
  fmt: DataQueryContext["fmt"];
}) {
  const cnFilter5 = params.containerNumber || params.entityName;
  if (!cnFilter5) {
    return {
      queryType: "container_cost_breakdown",
      title: "Container Cost Breakdown",
      summary: "Please specify a container number.",
    };
  }
  const cRow = await db.execute<{
    container_number: string;
    status: string;
    import_date: string | null;
    currency: string;
    supplier: string | null;
    items_total: string;
    charges_total: string;
    grand_total: string;
    total_kg: string | null;
    rate_per_kg: string | null;
    transport_fee: string | null;
    duty_fee: string | null;
    transporter: string | null;
    agent: string | null;
  }>(sql`
        SELECT c.container_number, c.status, c.import_date, c.currency,
          s.legal_name AS supplier,
          CAST(c.items_total AS numeric) AS items_total,
          CAST(c.charges_total AS numeric) AS charges_total,
          CAST(c.grand_total AS numeric) AS grand_total,
          CAST(c.total_kg AS numeric) AS total_kg,
          CAST(c.rate_per_kg AS numeric) AS rate_per_kg,
          CAST(c.transport_fee AS numeric) AS transport_fee,
          CAST(c.duty_fee AS numeric) AS duty_fee,
          c.transporter, c.agent
        FROM containers c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.company_id = ${companyId}
          AND c.container_number ILIKE ${"%" + cnFilter5 + "%"}
        ORDER BY c.import_date DESC LIMIT 1
      `);
  if (!cRow.rows.length) {
    return {
      queryType: "container_cost_breakdown",
      title: "Container Cost Breakdown",
      summary: `No container found matching "${cnFilter5}".`,
    };
  }
  const cc = cRow.rows[0];
  const poRows5 = await db.execute<{
    po_number: string;
    currency: string;
    items_total: string;
    freight: string;
    surcharge: string;
    fumigation: string;
    doc_charges: string;
    other_charges: string;
    discount: string;
  }>(sql`
        SELECT po.po_number, po.currency,
          CAST(po.items_total AS numeric) AS items_total,
          CAST(po.freight AS numeric) AS freight,
          CAST(po.surcharge AS numeric) AS surcharge,
          CAST(po.fumigation AS numeric) AS fumigation,
          CAST(po.document_charges AS numeric) AS doc_charges,
          CAST(po.other_charges AS numeric) AS other_charges,
          CAST(po.discount AS numeric) AS discount
        FROM purchase_orders po
        JOIN containers c ON c.id = po.container_id
        WHERE c.container_number ILIKE ${"%" + cnFilter5 + "%"}
        LIMIT 10
      `);
  const stats5 = [
    { label: "Supplier", value: cc.supplier },
    { label: "Status", value: cc.status },
    { label: "Import Date", value: String(cc.import_date).slice(0, 10) },
    { label: "Total Kg", value: fmtDec(toMoney(cc.total_kg).toNumber()) },
    { label: "Rate/Kg", value: fmtDec(toMoney(cc.rate_per_kg).toNumber()) },
    { label: "Grand Total", value: fmt(toMoney(cc.grand_total).toNumber()), highlight: "positive" },
  ];
  const breakdownRows: string[][] = [
    ["Items Total", cc.currency, fmt(toMoney(cc.items_total).toNumber())],
    ["Charges Total", cc.currency, fmt(toMoney(cc.charges_total).toNumber())],
  ];
  if (toMoney(cc.transport_fee).toNumber() > 0)
    breakdownRows.push(["Transport Fee", cc.currency, fmt(toMoney(cc.transport_fee).toNumber())]);
  if (toMoney(cc.duty_fee).toNumber() > 0)
    breakdownRows.push(["Duty Fee", cc.currency, fmt(toMoney(cc.duty_fee).toNumber())]);
  for (const po of poRows5.rows) {
    if (toMoney(po.freight).toNumber() > 0)
      breakdownRows.push([`Freight (${po.po_number})`, po.currency, fmt(toMoney(po.freight).toNumber())]);
    if (toMoney(po.fumigation).toNumber() > 0)
      breakdownRows.push([`Fumigation (${po.po_number})`, po.currency, fmt(toMoney(po.fumigation).toNumber())]);
    if (toMoney(po.surcharge).toNumber() > 0)
      breakdownRows.push([`Surcharge (${po.po_number})`, po.currency, fmt(toMoney(po.surcharge).toNumber())]);
    if (toMoney(po.doc_charges).toNumber() > 0)
      breakdownRows.push([`Doc Charges (${po.po_number})`, po.currency, fmt(toMoney(po.doc_charges).toNumber())]);
    if (toMoney(po.discount).toNumber() > 0)
      breakdownRows.push([`Discount (${po.po_number})`, po.currency, `(${fmt(toMoney(po.discount).toNumber())})`]);
  }
  breakdownRows.push(["GRAND TOTAL", cc.currency, fmt(toMoney(cc.grand_total).toNumber())]);
  return {
    queryType: "container_cost_breakdown",
    title: `Cost Breakdown: ${cc.container_number}`,
    subtitle: cc.transporter ? `Transporter: ${cc.transporter}${cc.agent ? ` · Agent: ${cc.agent}` : ""}` : "",
    stats: stats5,
    table: { headers: ["Component", "Currency", "Amount"], rows: breakdownRows },
    noData: false,
  };
}

export async function runPhase5TrialBalance({
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
    name: string;
    account_type: string;
    code: string | null;
    total_dr: string;
    total_cr: string;
  }>(sql`
        SELECT la.name, la.account_type, la.code,
          COALESCE(SUM(CAST(ve.debit_amount AS numeric)), 0) AS total_dr,
          COALESCE(SUM(CAST(ve.credit_amount AS numeric)), 0) AS total_cr
        FROM ledger_accounts la
        -- Only lines of live, non-optional vouchers of this company dated in the
        -- range are summed. The voucher filters used to sit on a second LEFT
        -- JOIN, which kept every entry (deleted, optional and out-of-range
        -- vouchers included) and only dropped the voucher row.
        LEFT JOIN (
          voucher_entries ve
          JOIN vouchers v ON v.id = ve.voucher_id
            AND v.company_id = ${companyId}
            AND v.deleted_at IS NULL AND v.optional = false
            AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        ) ON ve.ledger_account_id = la.id
        WHERE la.company_id = ${companyId}
          AND la.deleted_at IS NULL
          AND la.is_hidden = false
        GROUP BY la.id, la.name, la.account_type, la.code
        HAVING COALESCE(SUM(CAST(ve.debit_amount AS numeric)), 0) > 0
          OR COALESCE(SUM(CAST(ve.credit_amount AS numeric)), 0) > 0
        ORDER BY la.account_type, la.name
      `);
  let grandDrExact = toMoney(0),
    grandCrExact = toMoney(0);
  const tableRows5 = rows.rows.map((r) => {
    const drExact = toMoney(r.total_dr);
    const crExact = toMoney(r.total_cr);
    grandDrExact = grandDrExact.plus(drExact);
    grandCrExact = grandCrExact.plus(crExact);
    const dr = drExact.toNumber();
    const cr = crExact.toNumber();
    const net = drExact.minus(crExact).toNumber();
    return [
      r.code || "—",
      r.name,
      r.account_type,
      fmt(dr),
      fmt(cr),
      net >= 0 ? fmt(net) : "—",
      net < 0 ? fmt(Math.abs(net)) : "—",
    ];
  });
  const grandDr = grandDrExact.toNumber();
  const grandCr = grandCrExact.toNumber();
  tableRows5.push([
    "",
    "GRAND TOTAL",
    "",
    fmt(grandDr),
    fmt(grandCr),
    grandDr >= grandCr ? fmt(grandDr - grandCr) : "—",
    grandCr > grandDr ? fmt(grandCr - grandDr) : "—",
  ]);
  const stats5 = [
    { label: "Total Accounts", value: String(tableRows5.length - 1) },
    { label: "Total Debits", value: fmt(grandDr) },
    { label: "Total Credits", value: fmt(grandCr) },
    {
      label: "Net",
      value: fmt(Math.abs(grandDr - grandCr)),
      highlight: Math.abs(grandDr - grandCr) < 0.01 ? "positive" : "negative",
    },
  ];
  return {
    queryType: "trial_balance",
    title: "Trial Balance",
    subtitle: `${dateFrom} → ${dateTo}`,
    stats: stats5,
    table: {
      headers: ["Code", "Account", "Type", "Debit", "Credit", "Dr Balance", "Cr Balance"],
      rows: tableRows5,
    },
    noData: tableRows5.length <= 1,
  };
}
