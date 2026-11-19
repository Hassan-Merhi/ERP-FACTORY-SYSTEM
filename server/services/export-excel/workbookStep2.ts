// Extracted from ./workbook.ts: a stage of workbook.
import { assertExportDate } from "./workbookHelpers";
import type { workbookStep } from "./workbookStep";

type WorkbookStepResult = Awaited<ReturnType<typeof workbookStep>>;

export async function workbookStep2({
  wb1,
  companyId,
  fromDate,
  toDate,
}: {
  wb1: WorkbookStepResult;
  companyId: number;
  fromDate: string | undefined;
  toDate: string | undefined;
}) {
  const { fetch1 } = wb1;
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
  await fetch1(
    "Factory KPI Snapshots",
    `SELECT * FROM factory_daily_kpi_snapshots WHERE company_id = ${cid} ${df("date")} ORDER BY date DESC`
  );
  await fetch1(
    "Factory Daily Usages",
    `SELECT * FROM factory_daily_usages WHERE company_id = ${cid} ${df("used_date")} ORDER BY used_date DESC`
  );
  await fetch1("Factory Alerts", `SELECT * FROM factory_alerts WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Factory Duty Audit Log",
    `SELECT * FROM factory_duty_audit_log WHERE company_id = ${cid} ORDER BY id DESC LIMIT 50000`
  );

  // ── Factory Raw / Production ───────────────────────────────────────────────
  await fetch1("Factory Raw Stock", `SELECT * FROM factory_raw_stock WHERE company_id = ${cid} ORDER BY id`);
  await fetch1(
    "Raw Material Adjustments",
    `SELECT * FROM factory_raw_material_adjustments WHERE company_id = ${cid} ${df("date")} ORDER BY date DESC, id`
  );
  await fetch1(
    "Factory Pressing Batches",
    `SELECT * FROM factory_pressing_batches WHERE company_id = ${cid} ${df("created_at::date")} ORDER BY created_at DESC, id`
  );
  await fetch1("Pressing Batches", `SELECT * FROM pressing_batches WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1("Factory Mix Batches", `SELECT * FROM factory_mix_batches WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Factory Mix Batch Sources",
    `SELECT fms.* FROM factory_mix_batch_sources fms INNER JOIN factory_mix_batches fmb ON fmb.id = fms.mix_batch_id WHERE fmb.company_id = ${cid} ORDER BY fms.id`
  );
  await fetch1("Mix Batches", `SELECT * FROM mix_batches WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Mix Batch Sources",
    `SELECT mbs.* FROM mix_batch_sources mbs INNER JOIN mix_batches mb ON mb.id = mbs.mix_batch_id WHERE mb.company_id = ${cid} ORDER BY mbs.id`
  );
  await fetch1(
    "Production Bales",
    `SELECT * FROM production_bales WHERE company_id = ${cid} ORDER BY id DESC LIMIT 100000`
  );
  await fetch1("Production Raw Stock", `SELECT * FROM production_raw_stock WHERE company_id = ${cid} ORDER BY id`);

  // ── Factory Bales ──────────────────────────────────────────────────────────
  await fetch1("Factory Bale Products", `SELECT * FROM factory_bale_products WHERE company_id = ${cid} ORDER BY name`);
  await fetch1(
    "Factory Bales",
    `SELECT * FROM factory_bales WHERE company_id = ${cid} ${df("pressed_at::date")} ORDER BY pressed_at DESC, id`
  );
  await fetch1("Factory Bale Sequences", `SELECT * FROM factory_bale_sequences WHERE company_id = ${cid} ORDER BY id`);
  await fetch1(
    "Factory Bale Cost Snapshots",
    `SELECT * FROM factory_bale_cost_snapshots WHERE company_id = ${cid} ORDER BY id DESC LIMIT 50000`
  );
  await fetch1(
    "Factory Bale Waste Dispatches",
    `SELECT * FROM factory_bale_waste_dispatches WHERE company_id = ${cid} ORDER BY id DESC`
  );
  await fetch1(
    "Factory Waste Entries",
    `SELECT * FROM factory_waste_entries WHERE company_id = ${cid} ${df("date")} ORDER BY date DESC, id`
  );

  // ── Factory Containers ─────────────────────────────────────────────────────
  await fetch1("Factory Containers", `SELECT * FROM factory_containers WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Container Plans",
    `SELECT * FROM factory_container_plans WHERE company_id = ${cid} ORDER BY updated_at DESC, id DESC`
  );
  await fetch1(
    "Plan Containers",
    `SELECT * FROM factory_container_plan_containers WHERE company_id = ${cid} ORDER BY plan_id, position, id`
  );
  await fetch1(
    "Plan Lines",
    `SELECT * FROM factory_container_plan_lines WHERE company_id = ${cid} ORDER BY plan_id, plan_container_id, product_name, article_code`
  );
  await fetch1(
    "Factory Ctnr Commissions",
    `SELECT * FROM factory_container_commissions WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Factory Ctnr Other Charges",
    `SELECT * FROM factory_container_other_charges WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Factory Ctnr PL Snapshots",
    `SELECT * FROM factory_container_profit_snapshots WHERE company_id = ${cid} ORDER BY id DESC`
  );
  await fetch1(
    "Offload Additional Charges",
    `SELECT * FROM factory_offload_additional_charges WHERE company_id = ${cid} ORDER BY id`
  );

  // ── Factory Suppliers ──────────────────────────────────────────────────────
  await fetch1("Factory Suppliers", `SELECT * FROM factory_suppliers WHERE company_id = ${cid} ORDER BY name`);
  await fetch1(
    "Factory Supplier Payments",
    `SELECT * FROM factory_supplier_payments WHERE company_id = ${cid} ${df("date")} ORDER BY date DESC, id`
  );
  await fetch1(
    "Factory Supplier FX Xfers",
    `SELECT * FROM factory_supplier_fx_transfers WHERE company_id = ${cid} ORDER BY id DESC`
  );
  await fetch1(
    "Factory Supplier Scores",
    `SELECT * FROM factory_supplier_score_snapshots WHERE company_id = ${cid} ORDER BY id DESC`
  );

  // ── Factory FX & POS ──────────────────────────────────────────────────────
  await fetch1("Factory FX Rates", `SELECT * FROM factory_fx_rates WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Factory FX Allocations",
    `SELECT * FROM factory_fx_allocations WHERE company_id = ${cid} ORDER BY id DESC`
  );
  await fetch1(
    "Factory POS Sales",
    `SELECT * FROM factory_pos_sales WHERE company_id = ${cid} ${df("tx_date")} ORDER BY tx_date DESC, id`
  );
  await fetch1(
    "Factory POS Sale Items",
    `SELECT fps.* FROM factory_pos_sale_items fps INNER JOIN factory_pos_sales fp ON fp.id = fps.sale_id WHERE fp.company_id = ${cid} ORDER BY fps.id`
  );

  // ── Bales (Sorting) ────────────────────────────────────────────────────────
  await fetch1(
    "Bales (Sorting)",
    `SELECT * FROM bales WHERE company_id = ${cid} ${df("date_pressed")} ORDER BY date_pressed DESC, id`
  );
  await fetch1("Bale Products", `SELECT * FROM bale_products WHERE company_id = ${cid} ORDER BY name`);
  await fetch1(
    "Bale Product Categories",
    `SELECT * FROM bale_product_categories WHERE company_id = ${cid} ORDER BY name`
  );
  await fetch1("Bale Sequences", `SELECT * FROM bale_sequences WHERE company_id = ${cid} ORDER BY id`);
  await fetch1(
    "Bale Label Prints",
    `SELECT * FROM bale_label_prints WHERE company_id = ${cid} ORDER BY id DESC LIMIT 100000`
  );
  await fetch1("Bale Transfers", `SELECT * FROM bale_transfers WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Bale Transfer Items",
    `SELECT bti.* FROM bale_transfer_items bti INNER JOIN bale_transfers bt ON bt.id = bti.transfer_id WHERE bt.company_id = ${cid} ORDER BY bti.id`
  );
  await fetch1("Bale Recode Sessions", `SELECT * FROM bale_recode_sessions WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Bale Recode Items",
    `SELECT bri.* FROM bale_recode_items bri INNER JOIN bale_recode_sessions brs ON brs.id = bri.session_id WHERE brs.company_id = ${cid} ORDER BY bri.id`
  );

  // ── Stock ──────────────────────────────────────────────────────────────────
  await fetch1("Stock Groups", `SELECT * FROM stock_groups WHERE company_id = ${cid} ORDER BY name`);
  await fetch1("Stock Items", `SELECT * FROM stock_items WHERE company_id = ${cid} ORDER BY code`);
  await fetch1("Stock Item Aliases", `SELECT * FROM stock_item_code_aliases WHERE company_id = ${cid} ORDER BY id`);
  await fetch1(
    "Stock Item Location Prices",
    `SELECT silp.* FROM stock_item_location_prices silp INNER JOIN stock_items si ON si.id = silp.stock_item_id WHERE si.company_id = ${cid} ORDER BY silp.id`
  );
  await fetch1(
    "Inventory by Location",
    `SELECT i.*, si.code AS item_code, si.name AS item_name, l.name AS location_name FROM inventory i INNER JOIN stock_items si ON si.id = i.stock_item_id INNER JOIN locations l ON l.id = i.location_id WHERE si.company_id = ${cid} ORDER BY l.name, si.code`
  );
  await fetch1(
    "Inventory Negative Layers",
    `SELECT * FROM inventory_negative_layers WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Stock Group Archives",
    `SELECT * FROM stock_group_location_archives WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY id`
  );
  await fetch1(
    "Stock Group Archive Items",
    `SELECT sglai.* FROM stock_group_location_archive_items sglai INNER JOIN stock_group_location_archives sgla ON sgla.id = sglai.archive_id WHERE sgla.company_id = ${cid} ORDER BY sglai.id`
  );
  await fetch1(
    "Stock Transfers",
    `SELECT stv.*, v.voucher_number, v.voucher_date, v.description AS transfer_notes, l1.name AS from_location_name, l2.name AS to_location_name FROM stock_transfer_vouchers stv INNER JOIN vouchers v ON v.id = stv.voucher_id LEFT JOIN locations l1 ON l1.id = stv.source_location_id LEFT JOIN locations l2 ON l2.id = stv.destination_location_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date, stv.id`
  );
  await fetch1(
    "Transfer Items",
    `SELECT sti.* FROM stock_transfer_items sti INNER JOIN stock_transfer_vouchers stv ON stv.id = sti.transfer_id INNER JOIN vouchers v ON v.id = stv.voucher_id WHERE v.company_id = ${cid} ORDER BY sti.id`
  );
  await fetch1(
    "Transfer Revisions",
    `SELECT r.* FROM stock_transfer_revisions r INNER JOIN stock_transfer_vouchers stv ON stv.id = r.transfer_id INNER JOIN vouchers v ON v.id = stv.voucher_id WHERE v.company_id = ${cid} ORDER BY r.id`
  );
  await fetch1(
    "Revision Items",
    `SELECT ri.* FROM stock_transfer_revision_items ri INNER JOIN stock_transfer_revisions r ON r.id = ri.revision_id INNER JOIN stock_transfer_vouchers stv ON stv.id = r.transfer_id INNER JOIN vouchers v ON v.id = stv.voucher_id WHERE v.company_id = ${cid} ORDER BY ri.id`
  );
  await fetch1(
    "Stock Adjustments",
    `SELECT sav.* FROM stock_adjustment_vouchers sav INNER JOIN vouchers v ON v.id = sav.voucher_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY sav.id`
  );
  await fetch1(
    "Adjustment Items",
    `SELECT ai.* FROM stock_adjustment_items ai INNER JOIN stock_adjustment_vouchers av ON av.id = ai.adjustment_id INNER JOIN vouchers v ON v.id = av.voucher_id WHERE v.company_id = ${cid} ORDER BY ai.id`
  );
  await fetch1(
    "Proforma Reservations",
    `SELECT * FROM proforma_stock_reservations WHERE company_id = ${cid} ORDER BY id`
  );
}
