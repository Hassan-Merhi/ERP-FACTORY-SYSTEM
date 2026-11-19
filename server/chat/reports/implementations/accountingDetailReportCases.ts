// Extracted from ./accountingDetailReportShard.ts: report query handlers.
import { db, sql } from "./reportShardSupport";
import type { DataQueryContext } from "../types";
import { toMoney } from "../../../lib/money";

export async function runPhase5WorkerDocumentExpiry({
  todayDate,
  companyId,
  rowLimit,
  todayStr,
}: {
  todayDate: DataQueryContext["todayDate"];
  companyId: DataQueryContext["companyId"];
  rowLimit: DataQueryContext["rowLimit"];
  todayStr: DataQueryContext["todayStr"];
}) {
  const daysWindow = 60;
  const futureDoc = new Date(todayDate.getTime() + daysWindow * 86400000).toISOString().slice(0, 10);
  const rows = await db.execute<{
    full_name: string;
    employee_code: string | null;
    nationality: string | null;
    visa_expiry: string | null;
    work_permit_expiry: string | null;
    residential_permit_expiry: string | null;
    visa_number: string | null;
    work_permit_number: string | null;
  }>(sql`
        SELECT fw.full_name, fw.employee_code, fw.nationality,
          fw.visa_expiry, fw.work_permit_expiry, fw.residential_permit_expiry,
          fw.visa_number, fw.work_permit_number
        FROM factory_workers fw
        WHERE fw.company_id = ${companyId} AND fw.active = true
          AND (
            (fw.visa_expiry IS NOT NULL AND fw.visa_expiry <= ${futureDoc})
            OR (fw.work_permit_expiry IS NOT NULL AND fw.work_permit_expiry <= ${futureDoc})
            OR (fw.residential_permit_expiry IS NOT NULL AND fw.residential_permit_expiry <= ${futureDoc})
          )
        ORDER BY LEAST(
          COALESCE(fw.visa_expiry, '9999-01-01'),
          COALESCE(fw.work_permit_expiry, '9999-01-01'),
          COALESCE(fw.residential_permit_expiry, '9999-01-01')
        ) ASC
        LIMIT ${rowLimit}
      `);
  const expired: string[] = [];
  const tableRows5 = rows.rows.map((r) => {
    const visaExp = r.visa_expiry ? String(r.visa_expiry).slice(0, 10) : "—";
    const wpExp = r.work_permit_expiry ? String(r.work_permit_expiry).slice(0, 10) : "—";
    const rpExp = r.residential_permit_expiry ? String(r.residential_permit_expiry).slice(0, 10) : "—";
    const isExpired = (d: string) => d !== "—" && d < todayStr;
    const label = (d: string) => (isExpired(d) ? `${d} ⚠ EXPIRED` : d);
    if (isExpired(visaExp) || isExpired(wpExp) || isExpired(rpExp)) expired.push(r.full_name);
    return [r.full_name, r.employee_code || "—", r.nationality || "—", label(visaExp), label(wpExp), label(rpExp)];
  });
  const stats5 = [
    { label: "Workers With Expiring Docs", value: String(tableRows5.length) },
    {
      label: "Already Expired",
      value: String(expired.length),
      highlight: expired.length > 0 ? "negative" : undefined,
    },
    { label: "Window", value: `Next ${daysWindow} days` },
  ];
  return {
    queryType: "worker_document_expiry",
    title: "Worker Document Expiry Alert",
    subtitle: `Expiring within ${daysWindow} days (as of ${todayStr})`,
    stats: stats5,
    table: {
      headers: ["Worker", "Code", "Nationality", "Visa Expiry", "Work Permit", "Residential Permit"],
      rows: tableRows5,
    },
    noData: tableRows5.length === 0,
  };
}

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

export async function runPhase5PurchaseOrderDetail({
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
  const poNum = params.containerNumber || params.entityName;
  if (!poNum) {
    return {
      queryType: "purchase_order_detail",
      title: "Purchase Order Detail",
      summary: "Please specify a PO number.",
    };
  }
  const poRow = await db.execute<{
    id: number;
    po_number: string;
    currency: string;
    status: string;
    supplier: string | null;
    container_number: string | null;
    items_total: string;
    freight: string;
    surcharge: string;
    fumigation: string;
    doc_charges: string;
    other_charges: string;
    discount: string;
  }>(sql`
        SELECT po.id, po.po_number, po.currency, po.status,
          s.legal_name AS supplier, c.container_number,
          CAST(po.items_total AS numeric) AS items_total,
          CAST(po.freight AS numeric) AS freight,
          CAST(po.surcharge AS numeric) AS surcharge,
          CAST(po.fumigation AS numeric) AS fumigation,
          CAST(po.document_charges AS numeric) AS doc_charges,
          CAST(po.other_charges AS numeric) AS other_charges,
          CAST(po.discount AS numeric) AS discount
        FROM purchase_orders po
        JOIN suppliers s ON s.id = po.supplier_id
        JOIN containers c ON c.id = po.container_id
        WHERE po.company_id = ${companyId}
          AND po.po_number ILIKE ${"%" + poNum + "%"}
        ORDER BY po.created_at DESC LIMIT 1
      `);
  if (!poRow.rows.length) {
    return {
      queryType: "purchase_order_detail",
      title: "Purchase Order Detail",
      summary: `No PO found matching "${poNum}".`,
    };
  }
  const po5 = poRow.rows[0];
  const lineRows = await db.execute<{
    item_name: string;
    code: string | null;
    uom: string | null;
    qty: string;
    rate: string;
    line_total: string;
  }>(sql`
        SELECT pli.item_name, si.code, si.uom,
          CAST(pli.quantity AS numeric) AS qty,
          CAST(pli.rate AS numeric) AS rate,
          CAST(pli.line_total AS numeric) AS line_total
        FROM po_line_items pli
        JOIN stock_items si ON si.id = pli.stock_item_id
        WHERE pli.po_id = ${po5.id}
        ORDER BY pli.id
      `);
  const tableRows5 = lineRows.rows.map((r) => {
    const lt = toMoney(r.line_total).toNumber();
    return [
      r.item_name,
      r.code,
      `${fmtDec(toMoney(r.qty).toNumber())} ${r.uom}`,
      fmtDec(toMoney(r.rate).toNumber()),
      fmt(lt),
    ];
  });
  const charges = [
    ["Freight", fmt(toMoney(po5.freight).toNumber())],
    ["Surcharge", fmt(toMoney(po5.surcharge).toNumber())],
    ["Fumigation", fmt(toMoney(po5.fumigation).toNumber())],
    ["Document Charges", fmt(toMoney(po5.doc_charges).toNumber())],
    ["Other Charges", fmt(toMoney(po5.other_charges).toNumber())],
    ["Discount", `(${fmt(toMoney(po5.discount).toNumber())})`],
  ].filter(([, v]) => v !== fmt(0) && v !== `(${fmt(0)})`);
  const grandPO = toMoney(po5.items_total)
    .plus(toMoney(po5.freight))
    .plus(toMoney(po5.surcharge))
    .plus(toMoney(po5.fumigation))
    .plus(toMoney(po5.doc_charges))
    .plus(toMoney(po5.other_charges))
    .minus(toMoney(po5.discount))
    .toNumber();
  const stats5 = [
    { label: "Supplier", value: po5.supplier },
    { label: "Container", value: po5.container_number },
    { label: "Currency", value: po5.currency },
    { label: "Items Total", value: fmt(toMoney(po5.items_total).toNumber()) },
    { label: "Grand Total", value: fmt(grandPO), highlight: "positive" },
    { label: "Status", value: po5.status },
  ];
  const chargeRows = charges.map(([label, val]) => [label, "", "", "", val]);
  chargeRows.push(["GRAND TOTAL", "", "", "", fmt(grandPO)]);
  return {
    queryType: "purchase_order_detail",
    title: `PO Detail: ${po5.po_number}`,
    subtitle: `${tableRows5.length} line item(s)`,
    stats: stats5,
    table: { headers: ["Item", "Code", "Qty", "Rate", "Total"], rows: [...tableRows5, ...chargeRows] },
    noData: tableRows5.length === 0,
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
