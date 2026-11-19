import { styleSpecializedWorkbook } from "@shared/universal-excel/specializedWorkbookStyle";
import { toArrayBuffer } from "../../lib/bufferCompatibility";

import { ALT_FILL, HDR_FILL, HDR_FONT } from "./sheet-helpers";
import { qStream, EXPORT_DATE_INVALID_MESSAGE, assertExportDate } from "./workbookHelpers";
import { workbookStep } from "./workbookStep";
import { workbookStep2 } from "./workbookStep2";
export { EXPORT_DATE_INVALID_MESSAGE, assertExportDate } from "./workbookHelpers";
export { buildCompanyWorkbook } from "./buildCompanyWorkbook";

/** Request-boundary check: returns an error message for a malformed optional date range, else null. */
export function invalidExportDateRange(fromDate: unknown, toDate: unknown): string | null {
  for (const [field, value] of [
    ["fromDate", fromDate],
    ["toDate", toDate],
  ] as const) {
    if (value === undefined || value === null || value === "") continue;
    try {
      assertExportDate(value as string, field);
    } catch (error) {
      return error instanceof Error ? error.message : EXPORT_DATE_INVALID_MESSAGE;
    }
  }
  return null;
}

export async function streamCompanyWorkbookDirect(
  companyId: number,
  fromDate: string | undefined,
  toDate: string | undefined
): Promise<Buffer> {
  const wb1 = await workbookStep({ companyId, fromDate, toDate });
  const { fetch1, summaryWs, summaryRows, wb } = wb1;
  // The raw-SQL scanner proves `cid` and `df` within one file, so this query
  // stage derives them from the same inputs as stage 1 (same $1/$2 placeholders).
  const cid = Number(companyId);
  const dateParams: string[] = [];
  const fromPlaceholder = fromDate ? `$${dateParams.push(assertExportDate(fromDate, "fromDate"))}` : null;
  const toPlaceholder = toDate ? `$${dateParams.push(assertExportDate(toDate, "toDate"))}` : null;
  const df = (col: string): string => {
    const parts: string[] = [];
    if (fromPlaceholder) parts.push(`AND ${col} >= ${fromPlaceholder}`);
    if (toPlaceholder) parts.push(`AND ${col} <= ${toPlaceholder}`);
    return parts.join(" ");
  };
  await workbookStep2({ wb1, companyId, fromDate, toDate });

  // ── Containers ─────────────────────────────────────────────────────────────
  await fetch1(
    "Containers Detail",
    `
    SELECT c.container_number, c.status, c.import_date, c.eta, c.eta_source,
      c.border_date, c.offload_date, c.item_name, c.total_kg, c.rate_per_kg,
      c.items_total, c.charges_total, c.grand_total, c.transport_fee, c.duty_fee,
      c.agent, c.transporter, c.number_plate, c.shop_name, c.tracking_location,
      c.tracking_description, c.doc_received, s.legal_name AS supplier_name, s.phone AS supplier_phone,
      COALESCE(ch.total_charges, 0) AS total_other_charges, COALESCE(ch.charge_breakdown,'') AS charge_breakdown,
      COALESCE(fr.freight_amount_usd, 0) AS freight_usd, COALESCE(fr.freight_amount_local, 0) AS freight_local,
      COALESCE(off.total_bales, 0) AS offloaded_bales, COALESCE(off.duties, 0) AS offload_duties,
      COALESCE(off.office_charges, 0) AS offload_office_charges, COALESCE(off.transfer_charges, 0) AS offload_transfer_charges,
      COALESCE(off.transport_fees, 0) AS offload_transport_fees, COALESCE(off.total_charges, 0) AS offload_total_charges,
      COALESCE(sa.total_sale_amount, 0) AS total_sale_amount, COALESCE(sa.total_paid, 0) AS total_paid,
      COALESCE(sa.total_commission, 0) AS total_commission, COALESCE(sa.sale_count, 0) AS sale_count,
      COALESCE(oi.offload_qty, 0) AS offload_qty_items, COALESCE(oi.offload_value, 0) AS offload_value
    FROM containers c
    LEFT JOIN suppliers s ON s.id = c.supplier_id
    LEFT JOIN LATERAL (SELECT SUM(cc.amount) AS total_charges, STRING_AGG(cc.charge_name||': '||cc.amount::text,' | ' ORDER BY cc.id) AS charge_breakdown FROM container_charges cc WHERE cc.container_id=c.id) ch ON true
    LEFT JOIN LATERAL (SELECT SUM(CASE WHEN cf.currency='USD' THEN cf.freight_amount ELSE 0 END) AS freight_amount_usd, SUM(CASE WHEN cf.currency!='USD' THEN cf.freight_amount ELSE 0 END) AS freight_amount_local FROM container_freight cf WHERE cf.container_id=c.id) fr ON true
    LEFT JOIN LATERAL (SELECT SUM(co.total_bales) AS total_bales, SUM(co.duties) AS duties, SUM(co.office_charges) AS office_charges, SUM(co.transfer_charges) AS transfer_charges, SUM(co.transport_fees) AS transport_fees, SUM(co.total_charges) AS total_charges FROM container_offloads co WHERE co.container_id=c.id) off ON true
    LEFT JOIN LATERAL (SELECT SUM(cs.total_amount) AS total_sale_amount, SUM(cs.paid_amount) AS total_paid, SUM(cs.commission) AS total_commission, COUNT(cs.id) AS sale_count FROM container_sales cs WHERE cs.container_id=c.id) sa ON true
    LEFT JOIN LATERAL (SELECT SUM(coi.quantity) AS offload_qty, SUM(coi.total_value) AS offload_value FROM container_offload_items coi INNER JOIN container_offloads co ON co.id=coi.offload_id WHERE co.container_id=c.id) oi ON true
    WHERE c.company_id = ${cid} ORDER BY c.import_date DESC NULLS LAST, c.id DESC`
  );
  await fetch1(
    "Containers",
    `SELECT * FROM containers WHERE company_id = ${cid} ${df("import_date")} ORDER BY import_date DESC, id`
  );
  await fetch1(
    "Container Charges",
    `SELECT cc.* FROM container_charges cc INNER JOIN containers c ON c.id = cc.container_id WHERE c.company_id = ${cid} ORDER BY cc.id`
  );
  await fetch1(
    "Container Offloads",
    `SELECT co.* FROM container_offloads co INNER JOIN containers c ON c.id = co.container_id WHERE c.company_id = ${cid} ORDER BY co.id`
  );
  await fetch1(
    "Offload Items",
    `SELECT coi.* FROM container_offload_items coi INNER JOIN container_offloads co ON co.id = coi.offload_id INNER JOIN containers c ON c.id = co.container_id WHERE c.company_id = ${cid} ORDER BY coi.id`
  );
  await fetch1("Container Freight", `SELECT * FROM container_freight WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Container Freight Payments",
    `SELECT * FROM container_freight_payments WHERE company_id = ${cid} ORDER BY id DESC`
  );
  await fetch1("Container Documents", `SELECT * FROM container_documents WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1("Container Sales", `SELECT * FROM container_sales WHERE company_id = ${cid} ORDER BY id DESC`);

  // ── Purchase Orders ────────────────────────────────────────────────────────
  await fetch1(
    "Purchase Orders",
    `SELECT po.* FROM purchase_orders po WHERE po.company_id = ${cid} ${df("po.created_at::date")} ORDER BY po.created_at, po.id`
  );
  await fetch1(
    "PO Line Items",
    `SELECT pli.* FROM po_line_items pli INNER JOIN purchase_orders po ON po.id = pli.po_id WHERE po.company_id = ${cid} ORDER BY pli.id`
  );

  // ── POS ────────────────────────────────────────────────────────────────────
  await fetch1(
    "POS Shifts",
    `SELECT * FROM pos_shifts WHERE company_id = ${cid} ${df("opened_at::date")} ORDER BY opened_at DESC`
  );
  await fetch1(
    "Sales Items",
    `SELECT si.*, v.voucher_number, v.voucher_date FROM sales_items si INNER JOIN vouchers v ON v.id = si.voucher_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date, si.id`
  );

  // ── Waste ──────────────────────────────────────────────────────────────────
  await fetch1("Waste Dispatches", `SELECT * FROM waste_dispatches WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Waste Dispatch Items",
    `SELECT wdi.* FROM waste_dispatch_items wdi INNER JOIN waste_dispatches wd ON wd.id = wdi.dispatch_id WHERE wd.company_id = ${cid} ORDER BY wdi.id`
  );

  // ── Misc ───────────────────────────────────────────────────────────────────
  await fetch1(
    "Spreadsheets",
    `SELECT id, name, created_at, updated_at FROM spreadsheets WHERE company_id = ${cid} ORDER BY name`
  );
  await fetch1("Import Logs", `SELECT * FROM import_logs WHERE company_id = ${cid} ORDER BY id DESC LIMIT 10000`);
  await fetch1(
    "Audit Log",
    `SELECT * FROM audit_log WHERE company_id = ${cid} ${df("created_at::date")} ORDER BY created_at DESC LIMIT 50000`
  );

  // ── Factory Enriched Detail Views ──────────────────────────────────────────
  await fetch1(
    "Factory Bale Production",
    `SELECT fb.bale_code, fb.reference_number, fb.article_code, fb.product_name, fb.weight_kg, fb.cost_per_kg, fb.total_cost, fb.status, fb.pressed_at, fb.finalized_at, fb.category, fb.grade, fb.quantity, fb.stock_entry_date, fb.notes, fbp.code AS product_code, fbp.selling_price, fbp.production_price, l.name AS erp_location, fmb.batch_code AS mix_batch_code, fmb.batch_number AS mix_batch_number FROM factory_bales fb LEFT JOIN factory_bale_products fbp ON fbp.id = fb.product_id LEFT JOIN locations l ON l.id = fb.erp_location_id LEFT JOIN factory_mix_batches fmb ON fmb.id = fb.mix_batch_id WHERE fb.company_id = ${cid} ${df("fb.pressed_at::date")} ORDER BY fb.pressed_at DESC, fb.id`
  );
  await fetch1(
    "Factory Wkr Advances Detail",
    `SELECT fa.advance_date, fa.amount, fa.remaining_balance, fa.notes, fa.fully_paid, fa.repayment_type, fw.full_name AS worker_name, fw.employee_code, fw.department, fw.position FROM factory_worker_advances fa INNER JOIN factory_workers fw ON fw.id = fa.worker_id WHERE fa.company_id = ${cid} ORDER BY fa.advance_date, fa.id`
  );
  await fetch1(
    "Factory Payroll Detail",
    `SELECT fp.period_start, fp.period_end, fp.status, fp.base_salary, fp.bale_earnings, fp.kg_earnings, fp.overtime_pay, fp.bonuses, fp.deductions, fp.advances, fp.net_salary, fp.bales_count, fp.kg_processed, fp.overtime_hours, fp.total_working_days, fp.present_days, fp.absent_days, fp.transport, fp.notes, fw.full_name AS worker_name, fw.employee_code, fw.department, fw.position, fw.salary_type FROM factory_payrolls fp INNER JOIN factory_workers fw ON fw.id = fp.worker_id WHERE fp.company_id = ${cid} ${df("fp.period_start")} ORDER BY fp.period_start, fp.id`
  );
  await fetch1(
    "Factory Container Detail",
    `SELECT fc.container_number, fc.status, fc.arrival_date, fc.total_kg, fc.declared_kg, fc.actual_received_kg, fc.difference_kg, fc.rate_per_kg, fc.currency_code, fc.fx_rate_to_usd, fc.rate_per_kg_usd, fc.freight, fc.other_charges, fc.commission_amount, fc.duty_amount, fc.duty_status, fc.final_payable_amount, fc.final_payable_amount_usd, fc.notes, fs.name AS supplier_name FROM factory_containers fc LEFT JOIN factory_suppliers fs ON fs.id = fc.supplier_id WHERE fc.company_id = ${cid} ORDER BY fc.arrival_date DESC, fc.id`
  );
  await fetch1(
    "Factory Supplier Pay Detail",
    `SELECT fsp.date AS payment_date, fsp.amount, fsp.currency_code, fsp.fx_rate_to_usd, fsp.amount_usd, fsp.notes, fs.name AS supplier_name FROM factory_supplier_payments fsp INNER JOIN factory_suppliers fs ON fs.id = fsp.supplier_id WHERE fsp.company_id = ${cid} ${df("fsp.date")} ORDER BY fsp.date DESC, fsp.id`
  );
  await fetch1(
    "Factory Raw Stock Detail",
    `SELECT fr.offloaded_at, fr.material_type, fr.quantity_kg, fr.received_kg, fr.used_kg, fr.rate_per_kg, fr.cost_per_kg, fr.cost_per_kg_usd, fr.notes, fc.container_number, fs.name AS supplier_name FROM factory_raw_stock fr LEFT JOIN factory_containers fc ON fc.id = fr.container_id LEFT JOIN factory_suppliers fs ON fs.id = fc.supplier_id WHERE fr.company_id = ${cid} ORDER BY fr.offloaded_at DESC, fr.id`
  );
  await fetch1(
    "Factory Mix Batch Detail",
    `SELECT fmb.batch_number, fmb.batch_code, fmb.batch_date, fmb.total_weight_kg, fmb.cost_per_kg, fmb.total_cost, fmb.status, fmb.notes, fms.source_type, fms.weight_kg, fms.cost_per_kg AS source_cost_per_kg, fms.total_cost AS source_total_cost, fms.notes AS source_notes, fs.name AS supplier_name, fc.container_number FROM factory_mix_batches fmb LEFT JOIN factory_mix_batch_sources fms ON fms.mix_batch_id = fmb.id LEFT JOIN factory_suppliers fs ON fs.id = fms.supplier_id LEFT JOIN factory_containers fc ON fc.id = fms.container_id WHERE fmb.company_id = ${cid} ORDER BY fmb.batch_date DESC, fmb.id, fms.id`
  );
  await fetch1(
    "Factory POS Sales Detail",
    `SELECT fps.sale_number, fps.tx_date AS sale_date, fps.customer_name, fps.notes AS sale_notes, fps.total_amount AS sale_total, fps.currency_code, fps.payment_type, fps.status, fpsi.product_name, fpsi.article_code, fpsi.quantity, fpsi.unit_price, fpsi.total_amount AS item_total FROM factory_pos_sales fps LEFT JOIN factory_pos_sale_items fpsi ON fpsi.sale_id = fps.id WHERE fps.company_id = ${cid} ${df("fps.tx_date")} ORDER BY fps.tx_date DESC, fps.id, fpsi.id`
  );

  // ── ERP Enriched Detail Views ──────────────────────────────────────────────
  await fetch1(
    "Voucher Lines Detail",
    `SELECT v.voucher_number, v.voucher_type, v.voucher_date, v.description AS voucher_narration, v.currency, v.exchange_rate, v.location_name, la.code AS account_code, la.name AS account_name, la.account_type, CASE WHEN COALESCE(ve.debit_amount,0) > 0 THEN 'DR' ELSE 'CR' END AS dr_cr, COALESCE(ve.debit_amount,0) AS debit_amount, COALESCE(ve.credit_amount,0) AS credit_amount, ve.transaction_currency, ve.transaction_debit_amount, ve.transaction_credit_amount, ve.base_debit_amount, ve.base_credit_amount, ve.historical_exchange_rate, ve.rate_convention, ve.narration AS entry_narration, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name, c.legal_name AS customer_name, s.legal_name AS supplier_name FROM vouchers v LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id LEFT JOIN employees e ON e.id = ve.employee_id LEFT JOIN customers c ON c.id = ve.customer_id LEFT JOIN suppliers s ON s.id = ve.supplier_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date, v.id, ve.id`
  );
  await fetch1(
    "PO Detail",
    `SELECT po.po_number, po.status, po.currency, po.created_at AS po_date, s.legal_name AS supplier_name, COALESCE(si.code,'') AS item_code, pol.item_name, pol.quantity, pol.rate, pol.line_total, po.freight, po.other_charges, po.surcharge, po.fumigation, po.document_charges, po.discount, po.items_total FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN po_line_items pol ON pol.po_id = po.id LEFT JOIN stock_items si ON si.id = pol.stock_item_id WHERE po.company_id = ${cid} ORDER BY po.created_at DESC, po.id, pol.id`
  );
  await fetch1(
    "Stock Transfer Detail",
    `SELECT v.voucher_number, v.voucher_date, v.description AS notes, l1.name AS from_location, l2.name AS to_location, si.code AS item_code, si.name AS item_name, sti.quantity, sti.rate, sti.total_amount FROM stock_transfer_vouchers stv INNER JOIN vouchers v ON v.id = stv.voucher_id LEFT JOIN locations l1 ON l1.id = stv.source_location_id LEFT JOIN locations l2 ON l2.id = stv.destination_location_id LEFT JOIN stock_transfer_items sti ON sti.transfer_id = stv.id LEFT JOIN stock_items si ON si.id = sti.stock_item_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date DESC, stv.id, sti.id`
  );
  await fetch1(
    "Supplier Balances",
    `SELECT s.code AS supplier_code, s.legal_name AS supplier_name, s.phone, s.email, s.payment_terms, COALESCE(s.opening_balance,0) AS opening_balance, COALESCE(SUM(ve.debit_amount),0) AS total_debits, COALESCE(SUM(ve.credit_amount),0) AS total_credits FROM suppliers s INNER JOIN ledger_accounts la ON la.id = s.ledger_account_id LEFT JOIN voucher_entries ve ON ve.supplier_id = s.id WHERE la.company_id = ${cid} AND s.deleted_at IS NULL GROUP BY s.id, s.code, s.legal_name, s.phone, s.email, s.payment_terms, s.opening_balance ORDER BY s.legal_name`
  );
  await fetch1(
    "Supplier Txn Detail",
    `SELECT s.legal_name AS supplier_name, s.code AS supplier_code, v.voucher_number, v.voucher_type, v.voucher_date, la.code AS account_code, la.name AS account_name, CASE WHEN COALESCE(ve.debit_amount,0) > 0 THEN 'DR' ELSE 'CR' END AS dr_cr, COALESCE(ve.debit_amount,0) AS debit_amount, COALESCE(ve.credit_amount,0) AS credit_amount, ve.transaction_currency, ve.transaction_debit_amount, ve.transaction_credit_amount, ve.base_debit_amount, ve.base_credit_amount, ve.historical_exchange_rate, ve.rate_convention, ve.narration, v.description AS voucher_narration FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id INNER JOIN suppliers s ON s.id = ve.supplier_id LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY s.legal_name, v.voucher_date, ve.id`
  );
  await fetch1(
    "Customer Balances Detail",
    `SELECT c.legal_name AS customer_name, c.code AS customer_code, cb.transaction_date, cb.transaction_type, cb.reference_type, cb.debit_amount, cb.credit_amount, cb.balance, cb.currency, cb.description, cb.side FROM customer_balances cb INNER JOIN customers c ON c.id = cb.customer_id WHERE cb.company_id = ${cid} ${df("cb.transaction_date")} ORDER BY c.legal_name, cb.transaction_date, cb.id`
  );
  await fetch1(
    "Customer Order Detail",
    `SELECT c.legal_name AS customer_name, c.code AS customer_code, co.invoice_number, co.order_date, co.status, co.container_number, co.shipping_company, col.article_code, col.bale_name AS item_name, col.qty, col.weight_per_bale, col.total_weight, col.price_per_bale AS rate, col.total_price, co.freight_amount, co.other_charges_total, co.grand_total FROM customer_orders co INNER JOIN customers c ON c.id = co.customer_id LEFT JOIN customer_order_lines col ON col.order_id = co.id WHERE co.company_id = ${cid} ${df("co.order_date")} ORDER BY co.order_date DESC, co.id, col.id`
  );
  await fetch1(
    "Credit-Debit Note Detail",
    `SELECT v.voucher_number, v.voucher_type, v.voucher_date, v.description AS narration, c.legal_name AS customer_name, si.code AS item_code, si.name AS item_name, l.name AS location_name, cni.quantity, cni.rate, cni.total_value, cni.inventory_cost FROM credit_note_items cni INNER JOIN vouchers v ON v.id = cni.voucher_id LEFT JOIN stock_items si ON si.id = cni.stock_item_id LEFT JOIN locations l ON l.id = cni.location_id LEFT JOIN LATERAL (SELECT ve2.customer_id FROM voucher_entries ve2 WHERE ve2.voucher_id = v.id AND ve2.customer_id IS NOT NULL LIMIT 1) ve ON true LEFT JOIN customers c ON c.id = ve.customer_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date DESC, v.id, cni.id`
  );
  await fetch1(
    "Salary Advances Detail",
    `SELECT sa.advance_date, sa.amount, sa.remaining_balance, sa.notes, sa.fully_paid, sa.is_opening_balance, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name, e.code AS employee_code, e.department FROM salary_advances sa INNER JOIN employees e ON e.id = sa.employee_id WHERE sa.company_id = ${cid} ${df("sa.advance_date")} ORDER BY sa.advance_date, sa.id`
  );
  await fetch1(
    "Employee Txn Detail",
    `SELECT TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name, e.code AS employee_code, e.department, v.voucher_number, v.voucher_type, v.voucher_date, la.code AS account_code, la.name AS account_name, CASE WHEN COALESCE(ve.debit_amount,0) > 0 THEN 'DR' ELSE 'CR' END AS dr_cr, COALESCE(ve.debit_amount,0) AS debit_amount, COALESCE(ve.credit_amount,0) AS credit_amount, ve.narration, v.description AS voucher_narration FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id INNER JOIN employees e ON e.id = ve.employee_id LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY e.first_name, v.voucher_date, ve.id`
  );
  await fetch1(
    "Location Stock Detail",
    `SELECT l.name AS location_name, sg.name AS stock_group, si.code AS item_code, si.name AS item_name, si.uom, i.quantity, i.average_rate AS rate, i.total_value, i.last_updated FROM inventory i INNER JOIN stock_items si ON si.id = i.stock_item_id INNER JOIN locations l ON l.id = i.location_id LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id WHERE i.company_id = ${cid} AND i.quantity != 0 ORDER BY l.name, sg.name, si.code`
  );

  // ── Populate SUMMARY sheet (created first; filled here after all counts are known) ──
  {
    const [co] = await qStream(`SELECT name FROM companies WHERE id = ${cid}`);
    const title = summaryWs.addRow([`Full Data Export — ${co?.name || ""}`]);
    title.getCell(1).font = { bold: true, size: 14, color: { argb: "FF1E3A5F" } };
    summaryWs.addRow(["Generated at", new Date().toISOString()]);
    summaryWs.addRow([]);
    const headerRow = summaryWs.addRow(["Data Category", "Record Count"]);
    headerRow.eachCell((cell) => {
      cell.fill = HDR_FILL;
      cell.font = HDR_FONT;
    });
    headerRow.height = 18;
    const total = summaryRows.reduce((s, [, n]) => s + n, 0);
    summaryRows.forEach(([label, count], i) => {
      const r = summaryWs.addRow([label, count]);
      r.getCell(2).numFmt = "#,##0";
      if (i % 2 === 1)
        r.eachCell((c) => {
          c.fill = ALT_FILL;
        });
    });
    summaryWs.addRow([]);
    const totalRow = summaryWs.addRow(["TOTAL RECORDS", total]);
    totalRow.getCell(1).font = { bold: true, size: 11 };
    totalRow.getCell(2).font = { bold: true, size: 11 };
    totalRow.getCell(2).numFmt = "#,##0";
  }
  styleSpecializedWorkbook(wb, {
    sheets: [{ name: "SUMMARY", purpose: "report" }],
  });
  const workbookBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(new Uint8Array(toArrayBuffer(new Uint8Array(workbookBuffer))));
}
