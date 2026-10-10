import { db, sql } from "./reportShardSupport";
import { defaultOpeningSide } from "../../../services/accounting/accountClassification";
import { toMoney } from "../../../lib/money";
import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";

export const phase5QueryTypes = [
  "trial_balance",
  "purchase_order_detail",
  "container_cost_breakdown",
  "worker_document_expiry",
  "stock_transfers",
  "cash_flow_summary",
  "ledger_account_balance",
  "daily_report",
  "profit_by_location",
  "debit_note_summary",
] as const;

async function runPhase5Report(ctx: DataQueryContext): Promise<DataQueryResult> {
  const { companyId, params, dateFrom, dateTo, todayStr, todayDate, rowLimit, fmt, fmtDec } = ctx;
  let dataQueryResult: DataQueryResult;

  switch (params.queryType) {
    case "trial_balance": {
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
      dataQueryResult = {
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
      break;
    }

    case "purchase_order_detail": {
      const poNum = params.containerNumber || params.entityName;
      if (!poNum) {
        dataQueryResult = {
          queryType: "purchase_order_detail",
          title: "Purchase Order Detail",
          summary: "Please specify a PO number.",
        };
        break;
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
        dataQueryResult = {
          queryType: "purchase_order_detail",
          title: "Purchase Order Detail",
          summary: `No PO found matching "${poNum}".`,
        };
        break;
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
      let _lineTotal = 0;
      const tableRows5 = lineRows.rows.map((r) => {
        const lt = parseFloat(r.line_total || "0");
        _lineTotal += lt;
        return [r.item_name, r.code, `${fmtDec(parseFloat(r.qty))} ${r.uom}`, fmtDec(parseFloat(r.rate)), fmt(lt)];
      });
      const charges = [
        ["Freight", fmt(parseFloat(po5.freight || "0"))],
        ["Surcharge", fmt(parseFloat(po5.surcharge || "0"))],
        ["Fumigation", fmt(parseFloat(po5.fumigation || "0"))],
        ["Document Charges", fmt(parseFloat(po5.doc_charges || "0"))],
        ["Other Charges", fmt(parseFloat(po5.other_charges || "0"))],
        ["Discount", `(${fmt(parseFloat(po5.discount || "0"))})`],
      ].filter(([, v]) => v !== fmt(0) && v !== `(${fmt(0)})`);
      const grandPO =
        parseFloat(po5.items_total || "0") +
        parseFloat(po5.freight || "0") +
        parseFloat(po5.surcharge || "0") +
        parseFloat(po5.fumigation || "0") +
        parseFloat(po5.doc_charges || "0") +
        parseFloat(po5.other_charges || "0") -
        parseFloat(po5.discount || "0");
      const stats5 = [
        { label: "Supplier", value: po5.supplier },
        { label: "Container", value: po5.container_number },
        { label: "Currency", value: po5.currency },
        { label: "Items Total", value: fmt(parseFloat(po5.items_total || "0")) },
        { label: "Grand Total", value: fmt(grandPO), highlight: "positive" },
        { label: "Status", value: po5.status },
      ];
      const chargeRows = charges.map(([label, val]) => [label, "", "", "", val]);
      chargeRows.push(["GRAND TOTAL", "", "", "", fmt(grandPO)]);
      dataQueryResult = {
        queryType: "purchase_order_detail",
        title: `PO Detail: ${po5.po_number}`,
        subtitle: `${tableRows5.length} line item(s)`,
        stats: stats5,
        table: { headers: ["Item", "Code", "Qty", "Rate", "Total"], rows: [...tableRows5, ...chargeRows] },
        noData: tableRows5.length === 0,
      };
      break;
    }

    case "container_cost_breakdown": {
      const cnFilter5 = params.containerNumber || params.entityName;
      if (!cnFilter5) {
        dataQueryResult = {
          queryType: "container_cost_breakdown",
          title: "Container Cost Breakdown",
          summary: "Please specify a container number.",
        };
        break;
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
        dataQueryResult = {
          queryType: "container_cost_breakdown",
          title: "Container Cost Breakdown",
          summary: `No container found matching "${cnFilter5}".`,
        };
        break;
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
        { label: "Total Kg", value: fmtDec(parseFloat(cc.total_kg || "0")) },
        { label: "Rate/Kg", value: fmtDec(parseFloat(cc.rate_per_kg || "0")) },
        { label: "Grand Total", value: fmt(parseFloat(cc.grand_total || "0")), highlight: "positive" },
      ];
      const breakdownRows: string[][] = [
        ["Items Total", cc.currency, fmt(parseFloat(cc.items_total || "0"))],
        ["Charges Total", cc.currency, fmt(parseFloat(cc.charges_total || "0"))],
      ];
      if (parseFloat(cc.transport_fee || "0") > 0)
        breakdownRows.push(["Transport Fee", cc.currency, fmt(parseFloat(cc.transport_fee || "0"))]);
      if (parseFloat(cc.duty_fee || "0") > 0)
        breakdownRows.push(["Duty Fee", cc.currency, fmt(parseFloat(cc.duty_fee || "0"))]);
      for (const po of poRows5.rows) {
        if (parseFloat(po.freight || "0") > 0)
          breakdownRows.push([`Freight (${po.po_number})`, po.currency, fmt(parseFloat(po.freight))]);
        if (parseFloat(po.fumigation || "0") > 0)
          breakdownRows.push([`Fumigation (${po.po_number})`, po.currency, fmt(parseFloat(po.fumigation))]);
        if (parseFloat(po.surcharge || "0") > 0)
          breakdownRows.push([`Surcharge (${po.po_number})`, po.currency, fmt(parseFloat(po.surcharge))]);
        if (parseFloat(po.doc_charges || "0") > 0)
          breakdownRows.push([`Doc Charges (${po.po_number})`, po.currency, fmt(parseFloat(po.doc_charges))]);
        if (parseFloat(po.discount || "0") > 0)
          breakdownRows.push([`Discount (${po.po_number})`, po.currency, `(${fmt(parseFloat(po.discount))})`]);
      }
      breakdownRows.push(["GRAND TOTAL", cc.currency, fmt(parseFloat(cc.grand_total || "0"))]);
      dataQueryResult = {
        queryType: "container_cost_breakdown",
        title: `Cost Breakdown: ${cc.container_number}`,
        subtitle: cc.transporter ? `Transporter: ${cc.transporter}${cc.agent ? ` · Agent: ${cc.agent}` : ""}` : "",
        stats: stats5,
        table: { headers: ["Component", "Currency", "Amount"], rows: breakdownRows },
        noData: false,
      };
      break;
    }

    case "worker_document_expiry": {
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
      const expired: string[] = [],
        _expiringSoon: string[] = [];
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
      dataQueryResult = {
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
      break;
    }

    case "stock_transfers": {
      const locFilter5 = params.locationName || params.entityName;
      const rows = await db.execute<{
        voucher_date: string;
        voucher_number: string;
        from_location: string | null;
        to_location: string | null;
        item_name: string;
        code: string | null;
        qty: string;
        uom: string | null;
        rate: string;
        total_amount: string;
        notes: string | null;
      }>(sql`
        SELECT v.voucher_date, v.voucher_number,
          sl.name AS from_location, dl.name AS to_location,
          si.name AS item_name, si.code,
          CAST(sti.quantity AS numeric) AS qty, si.uom,
          CAST(sti.rate AS numeric) AS rate,
          CAST(sti.total_amount AS numeric) AS total_amount,
          stv.notes
        FROM stock_transfer_items sti
        JOIN stock_transfer_vouchers stv ON stv.id = sti.transfer_id
        JOIN vouchers v ON v.id = stv.voucher_id AND v.deleted_at IS NULL
        JOIN stock_items si ON si.id = sti.stock_item_id
        LEFT JOIN locations sl ON sl.id = sti.source_location_id
        JOIN locations dl ON dl.id = stv.destination_location_id
        WHERE si.company_id = ${companyId}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
          ${locFilter5 ? sql`AND (sl.name ILIKE ${"%" + locFilter5 + "%"} OR dl.name ILIKE ${"%" + locFilter5 + "%"})` : sql``}
        ORDER BY v.voucher_date DESC
        LIMIT ${rowLimit}
      `);
      let totalTransferred = 0;
      const tableRows5 = rows.rows.map((r) => {
        const amt = parseFloat(r.total_amount || "0");
        totalTransferred += amt;
        return [
          String(r.voucher_date).slice(0, 10),
          r.voucher_number,
          r.item_name,
          `${fmtDec(parseFloat(r.qty))} ${r.uom}`,
          r.from_location || "—",
          r.to_location,
          fmt(amt),
        ];
      });
      dataQueryResult = {
        queryType: "stock_transfers",
        title: locFilter5 ? `Stock Transfers: ${locFilter5}` : "Stock Transfers",
        subtitle: `${dateFrom} → ${dateTo} · Total value transferred: ${fmt(totalTransferred)}`,
        table: { headers: ["Date", "Voucher #", "Item", "Qty", "From", "To", "Value"], rows: tableRows5 },
        noData: tableRows5.length === 0,
      };
      break;
    }

    case "cash_flow_summary": {
      const rows = await db.execute<{
        account_name: string;
        account_type: string;
        total_in: string;
        total_out: string;
        tx_count: string;
      }>(sql`
        SELECT la.name AS account_name, la.account_type,
          COALESCE(SUM(CAST(ve.debit_amount AS numeric)), 0) AS total_in,
          COALESCE(SUM(CAST(ve.credit_amount AS numeric)), 0) AS total_out,
          COUNT(DISTINCT v.id) AS tx_count
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
          AND v.deleted_at IS NULL AND v.optional = false
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id
          AND LOWER(TRIM(la.account_type)) IN ('bank', 'cash')
        WHERE la.company_id = ${companyId}
        GROUP BY la.id, la.name, la.account_type
        ORDER BY total_in DESC
      `);
      let grandIn = 0,
        grandOut = 0;
      const tableRows5 = rows.rows.map((r) => {
        const inflow = parseFloat(r.total_in || "0");
        const outflow = parseFloat(r.total_out || "0");
        const net = inflow - outflow;
        grandIn += inflow;
        grandOut += outflow;
        return [
          r.account_name,
          r.account_type,
          fmt(inflow),
          fmt(outflow),
          net >= 0 ? fmt(net) : `(${fmt(Math.abs(net))})`,
          String(r.tx_count),
        ];
      });
      tableRows5.push([
        "TOTAL",
        "",
        fmt(grandIn),
        fmt(grandOut),
        grandIn >= grandOut ? fmt(grandIn - grandOut) : `(${fmt(grandOut - grandIn)})`,
        "",
      ]);
      const stats5 = [
        { label: "Total Cash In", value: fmt(grandIn), highlight: "positive" },
        { label: "Total Cash Out", value: fmt(grandOut) },
        {
          label: "Net Position",
          value: grandIn >= grandOut ? fmt(grandIn - grandOut) : `(${fmt(grandOut - grandIn)})`,
          highlight: grandIn >= grandOut ? "positive" : "negative",
        },
      ];
      dataQueryResult = {
        queryType: "cash_flow_summary",
        title: "Cash Flow Summary",
        subtitle: `${dateFrom} → ${dateTo} · Bank & Cash accounts`,
        stats: stats5,
        table: {
          headers: ["Account", "Type", "Inflow (Dr)", "Outflow (Cr)", "Net", "Transactions"],
          rows: tableRows5,
        },
        noData: tableRows5.length <= 1,
      };
      break;
    }

    case "ledger_account_balance": {
      const acctName5 = params.entityName || params.locationName;
      if (!acctName5) {
        dataQueryResult = {
          queryType: "ledger_account_balance",
          title: "Ledger Account Balance",
          summary: "Please specify an account name.",
        };
        break;
      }
      const acctRow5 = await db.execute<{
        id: number;
        name: string;
        account_type: string;
        code: string | null;
        opening_balance: string;
        opening_balance_side: string | null;
      }>(sql`
        SELECT id, name, account_type, code,
          CAST(opening_balance AS numeric) AS opening_balance, opening_balance_side
        FROM ledger_accounts
        WHERE company_id = ${companyId} AND deleted_at IS NULL
          AND name ILIKE ${"%" + acctName5 + "%"}
        ORDER BY name LIMIT 1
      `);
      if (!acctRow5.rows.length) {
        dataQueryResult = {
          queryType: "ledger_account_balance",
          title: "Ledger Account Balance",
          summary: `No account found matching "${acctName5}".`,
        };
        break;
      }
      const la5 = acctRow5.rows[0];
      const txRows5 = await db.execute<{
        voucher_date: string;
        voucher_type: string;
        voucher_number: string;
        description: string | null;
        dr: string;
        cr: string;
      }>(sql`
        SELECT v.voucher_date, v.voucher_type, v.voucher_number, v.description,
          CAST(ve.debit_amount AS numeric) AS dr,
          CAST(ve.credit_amount AS numeric) AS cr
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
          AND v.deleted_at IS NULL AND v.optional = false
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        WHERE ve.ledger_account_id = ${la5.id}
        ORDER BY v.voucher_date, v.id
        LIMIT ${rowLimit}
      `);
      // A sideless opening is on its type's usual side, as in the balance engine (wave 13, C1).
      const obSide5 =
        la5.opening_balance_side === "Dr" || la5.opening_balance_side === "Cr"
          ? la5.opening_balance_side
          : (defaultOpeningSide(la5.account_type) ?? "Dr");
      const ob = parseFloat(la5.opening_balance || "0") * (obSide5 === "Cr" ? -1 : 1);
      let runningBal = ob;
      let totalDr = 0,
        totalCr = 0;
      const tableRows5 = txRows5.rows.map((r) => {
        const dr = parseFloat(r.dr || "0");
        const cr = parseFloat(r.cr || "0");
        runningBal += dr - cr;
        totalDr += dr;
        totalCr += cr;
        return [
          String(r.voucher_date).slice(0, 10),
          r.voucher_number,
          r.voucher_type,
          (r.description || "").slice(0, 35),
          dr > 0 ? fmt(dr) : "—",
          cr > 0 ? fmt(cr) : "—",
          fmt(Math.abs(runningBal)) + (runningBal >= 0 ? " Dr" : " Cr"),
        ];
      });
      const stats5 = [
        { label: "Account", value: `${la5.code ? la5.code + " — " : ""}${la5.name}` },
        { label: "Type", value: la5.account_type },
        { label: "Total Debit", value: fmt(totalDr) },
        { label: "Total Credit", value: fmt(totalCr) },
        {
          label: "Closing Balance",
          value: fmt(Math.abs(runningBal)) + (runningBal >= 0 ? " Dr" : " Cr"),
          highlight: "positive",
        },
      ];
      dataQueryResult = {
        queryType: "ledger_account_balance",
        title: `Ledger: ${la5.name}`,
        subtitle: `${dateFrom} → ${dateTo}`,
        stats: stats5,
        table: {
          headers: ["Date", "Voucher #", "Type", "Description", "Dr", "Cr", "Balance"],
          rows: tableRows5,
        },
        noData: tableRows5.length === 0,
      };
      break;
    }

    case "daily_report": {
      const reportDate = params.dateFrom || todayStr;
      const rows = await db.execute<{
        voucher_number: string;
        voucher_type: string;
        description: string | null;
        amount: string;
        currency: string;
        location: string | null;
      }>(sql`
        SELECT v.voucher_number, v.voucher_type, v.description,
          CAST(v.total_amount AS numeric) AS amount,
          v.currency, l.name AS location
        FROM vouchers v
        LEFT JOIN locations l ON l.id = v.location_id
        WHERE v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND v.optional = false
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) = ${reportDate}
        ORDER BY v.voucher_type, v.voucher_number
        LIMIT ${rowLimit}
      `);
      const typeMap5: Record<string, number> = {};
      let grandAmt = 0;
      const tableRows5 = rows.rows.map((r) => {
        const amt = parseFloat(r.amount || "0");
        typeMap5[r.voucher_type] = (typeMap5[r.voucher_type] || 0) + amt;
        grandAmt += amt;
        return [
          r.voucher_number,
          r.voucher_type,
          (r.description || "").slice(0, 40),
          r.location || "—",
          fmt(amt),
          r.currency,
        ];
      });
      const stats5 = [
        { label: "Date", value: reportDate },
        { label: "Total Vouchers", value: String(tableRows5.length) },
        { label: "Grand Total", value: fmt(grandAmt), highlight: "positive" },
        ...Object.entries(typeMap5).map(([t, a]) => ({ label: t, value: fmt(a) })),
      ];
      dataQueryResult = {
        queryType: "daily_report",
        title: `Daily Report: ${reportDate}`,
        subtitle: `${tableRows5.length} voucher(s) · Total: ${fmt(grandAmt)}`,
        stats: stats5,
        table: {
          headers: ["Voucher #", "Type", "Description", "Location", "Amount", "Currency"],
          rows: tableRows5,
        },
        noData: tableRows5.length === 0,
      };
      break;
    }

    case "profit_by_location": {
      const rows = await db.execute<{
        location: string;
        sales_count: string;
        total_revenue: string | null;
        total_cost: string | null;
        total_profit: string | null;
      }>(sql`
        SELECT COALESCE(l.name, v.location_name, 'Unassigned') AS location,
          COUNT(DISTINCT v.id) AS sales_count,
          SUM(CAST(sal.total_sales AS numeric)) AS total_revenue,
          SUM(CAST(sal.total_cost AS numeric)) AS total_cost,
          SUM(CAST(sal.profit AS numeric)) AS total_profit
        FROM sales_items sal
        JOIN vouchers v ON v.id = sal.voucher_id AND v.deleted_at IS NULL
        LEFT JOIN locations l ON l.id = v.location_id
        WHERE v.company_id = ${companyId}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY l.id, l.name, v.location_name
        ORDER BY total_profit DESC
        LIMIT ${rowLimit}
      `);
      let grandRev = 0,
        grandCost = 0,
        grandProfit = 0;
      const tableRows5 = rows.rows.map((r) => {
        const rev = parseFloat(r.total_revenue || "0");
        const cost = parseFloat(r.total_cost || "0");
        const profit5 = parseFloat(r.total_profit || "0");
        const margin = rev > 0 ? ((profit5 / rev) * 100).toFixed(1) + "%" : "—";
        grandRev += rev;
        grandCost += cost;
        grandProfit += profit5;
        return [r.location, String(r.sales_count), fmt(rev), fmt(cost), fmt(profit5), margin];
      });
      if (tableRows5.length) {
        const totMargin = grandRev > 0 ? ((grandProfit / grandRev) * 100).toFixed(1) + "%" : "—";
        tableRows5.push(["TOTAL", "", fmt(grandRev), fmt(grandCost), fmt(grandProfit), totMargin]);
      }
      const best = tableRows5.length > 1 ? tableRows5[0] : null;
      const stats5 = [
        { label: "Total Revenue", value: fmt(grandRev) },
        { label: "Total Cost", value: fmt(grandCost) },
        { label: "Total Profit", value: fmt(grandProfit), highlight: "positive" },
        ...(best ? [{ label: "Best Location", value: best[0] as string }] : []),
      ];
      dataQueryResult = {
        queryType: "profit_by_location",
        title: "Profit by Location",
        subtitle: `${dateFrom} → ${dateTo}`,
        stats: stats5,
        table: { headers: ["Location", "Sales", "Revenue", "Cost", "Profit", "Margin"], rows: tableRows5 },
        noData: tableRows5.length === 0,
      };
      break;
    }

    case "debit_note_summary": {
      const rows = await db.execute<{
        voucher_date: string;
        voucher_number: string;
        description: string | null;
        amount: string;
        currency: string;
      }>(sql`
        SELECT v.voucher_date, v.voucher_number, v.description,
          CAST(v.total_amount AS numeric) AS amount, v.currency
        FROM vouchers v
        WHERE v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND v.voucher_type = 'Debit Note'
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY v.voucher_date DESC
        LIMIT ${rowLimit}
      `);
      let totalDN = 0;
      const tableRows5 = rows.rows.map((r) => {
        const amt = parseFloat(r.amount || "0");
        totalDN += amt;
        return [
          String(r.voucher_date).slice(0, 10),
          r.voucher_number,
          (r.description || "").slice(0, 50),
          fmt(amt),
          r.currency,
        ];
      });
      const stats5 = [
        { label: "Debit Notes Issued", value: String(tableRows5.length) },
        { label: "Total Amount", value: fmt(totalDN), highlight: "negative" },
      ];
      dataQueryResult = {
        queryType: "debit_note_summary",
        title: "Debit Notes",
        subtitle: `${dateFrom} → ${dateTo}`,
        stats: stats5,
        table: { headers: ["Date", "Voucher #", "Description", "Amount", "Currency"], rows: tableRows5 },
        noData: tableRows5.length === 0,
      };
      break;
    }

    default:
      return undefined;
  }

  return dataQueryResult;
}

export const phase5ReportShard: ReportImplementationShard = {
  name: "phase-5",
  queryTypes: phase5QueryTypes,
  run: runPhase5Report,
};
