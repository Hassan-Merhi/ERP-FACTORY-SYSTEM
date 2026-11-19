// Extracted from ./workbook.ts: a stage of workbook.
import ExcelJS from "exceljs";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { addSheet } from "./sheet-helpers";
import { qStream, assertExportDate } from "./workbookHelpers";

export async function workbookStep({
  companyId,
  fromDate,
  toDate,
}: {
  companyId: number;
  fromDate: string | undefined;
  toDate: string | undefined;
}) {
  const cid = Number(companyId);
  if (!Number.isSafeInteger(cid) || cid <= 0) throw new Error("EXPORT_COMPANY_INVALID");
  // The date range arrives from request bodies (POST /api/export/start, the
  // WhatsApp manual send). It is validated as a calendar date and travels as a
  // bound parameter; `df` only emits the `$n` placeholder text and a column
  // name chosen by the literal call sites below.
  const dateParams: string[] = [];
  const fromPlaceholder = fromDate ? `$${dateParams.push(assertExportDate(fromDate, "fromDate"))}` : null;
  const toPlaceholder = toDate ? `$${dateParams.push(assertExportDate(toDate, "toDate"))}` : null;
  const df = (col: string): string => {
    const parts: string[] = [];
    if (fromPlaceholder) parts.push(`AND ${col} >= ${fromPlaceholder}`);
    if (toPlaceholder) parts.push(`AND ${col} <= ${toPlaceholder}`);
    return parts.join(" ");
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = "ERP System";
  wb.created = new Date();

  const summaryRows: [string, number][] = [];

  // Create SUMMARY worksheet first so it is always the first tab in the workbook.
  // ExcelJS has no ws.moveTo() API — sheet order is determined by creation order.
  const summaryWs = wb.addWorksheet("SUMMARY");
  summaryWs.getColumn(1).width = 38;
  summaryWs.getColumn(2).width = 18;
  // Content is written after all data sheets are fetched (summaryRows must be complete).

  async function fetch1(sheetName: string, sql: string): Promise<void> {
    // Only queries that contain a date filter reference the bound date values.
    const rows = await qStream(sql, /\$\d/.test(sql) ? dateParams : []);
    try {
      addSheet(wb, sheetName, rows);
    } catch (sheetErr: unknown) {
      logger.warn(`[FullExport] Sheet failed: ${sheetName} - ${getErrorMessage(sheetErr)}`);
    }
    summaryRows.push([sheetName, rows.length]);
    // rows goes out of scope here — GC can reclaim it before next fetch
  }

  // ── Company ────────────────────────────────────────────────────────────────
  await fetch1("Company Info", `SELECT * FROM companies WHERE id = ${cid}`);
  await fetch1("Company Settings", `SELECT * FROM company_settings WHERE company_id = ${cid}`);
  await fetch1("Locations", `SELECT * FROM locations WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY name`);

  // ── Finance ────────────────────────────────────────────────────────────────
  await fetch1(
    "Ledger Accounts",
    `SELECT * FROM ledger_accounts WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY code`
  );
  await fetch1(
    "Bank Accounts",
    `SELECT * FROM bank_accounts WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY name`
  );
  await fetch1("Fixed Assets", `SELECT * FROM fixed_assets WHERE company_id = ${cid} ORDER BY name`);
  await fetch1(
    "Exchange Rates",
    `SELECT * FROM exchange_rates WHERE company_id = ${cid} ${df("effective_date")} ORDER BY effective_date DESC, id`
  );
  await fetch1("Fiscal Period Closures", `SELECT * FROM fiscal_period_closures WHERE company_id = ${cid} ORDER BY id`);
  await fetch1("Reference Sequences", `SELECT * FROM reference_sequences WHERE company_id = ${cid} ORDER BY id`);
  await fetch1("Agent Accounts", `SELECT * FROM agent_accounts WHERE company_id = ${cid} ORDER BY id`);

  // ── Vouchers ───────────────────────────────────────────────────────────────
  await fetch1(
    "Vouchers",
    `SELECT * FROM vouchers WHERE company_id = ${cid} ${df("voucher_date")} ORDER BY voucher_date, id`
  );
  await fetch1(
    "Voucher Entries",
    `SELECT ve.* FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY ve.id`
  );

  // ── Suppliers ──────────────────────────────────────────────────────────────
  await fetch1(
    "Suppliers",
    `SELECT s.* FROM suppliers s INNER JOIN ledger_accounts la ON la.id = s.ledger_account_id WHERE la.company_id = ${cid} AND s.deleted_at IS NULL ORDER BY s.legal_name`
  );
  await fetch1(
    "Supplier Transactions",
    `SELECT ve.*, v.voucher_number, v.voucher_type, v.voucher_date, v.description AS voucher_narration FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = ${cid} AND ve.supplier_id IS NOT NULL ${df("v.voucher_date")} ORDER BY v.voucher_date, ve.id`
  );
  await fetch1("Supplier Proformas", `SELECT * FROM supplier_proformas WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Supplier Proforma Lines",
    `SELECT spl.* FROM supplier_proforma_lines spl INNER JOIN supplier_proformas sp ON sp.id = spl.proforma_id WHERE sp.company_id = ${cid} ORDER BY spl.id`
  );
  await fetch1(
    "Supplier Containers",
    `SELECT sc.* FROM supplier_containers sc INNER JOIN suppliers s ON s.id = sc.supplier_id INNER JOIN ledger_accounts la ON la.id = s.ledger_account_id WHERE la.company_id = ${cid} ORDER BY sc.id DESC`
  );
  await fetch1(
    "Supplier Container Items",
    `SELECT scl.* FROM supplier_container_loaded_items scl INNER JOIN supplier_containers sc ON sc.id = scl.container_id INNER JOIN suppliers s ON s.id = sc.supplier_id INNER JOIN ledger_accounts la ON la.id = s.ledger_account_id WHERE la.company_id = ${cid} ORDER BY scl.id`
  );

  // ── Customers ──────────────────────────────────────────────────────────────
  await fetch1(
    "Customers",
    `SELECT * FROM customers WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY legal_name`
  );
  await fetch1(
    "Customer Transactions",
    `SELECT ve.*, v.voucher_number, v.voucher_type, v.voucher_date, v.description AS voucher_narration FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = ${cid} AND ve.customer_id IS NOT NULL ${df("v.voucher_date")} ORDER BY v.voucher_date, ve.id`
  );
  await fetch1("Customer Balances", `SELECT * FROM customer_balances WHERE company_id = ${cid} ORDER BY id`);
  await fetch1(
    "Customer Orders",
    `SELECT * FROM customer_orders WHERE company_id = ${cid} ${df("order_date")} ORDER BY order_date DESC, id`
  );
  await fetch1(
    "Customer Order Lines",
    `SELECT col.* FROM customer_order_lines col INNER JOIN customer_orders co ON co.id = col.order_id WHERE co.company_id = ${cid} ORDER BY col.id`
  );
  await fetch1(
    "Customer Order Bales",
    `SELECT cob.* FROM customer_order_bales cob INNER JOIN customer_orders co ON co.id = cob.order_id WHERE co.company_id = ${cid} ORDER BY cob.id`
  );
  await fetch1(
    "Customer Order Charges",
    `SELECT coc.* FROM customer_order_charges coc INNER JOIN customer_orders co ON co.id = coc.order_id WHERE co.company_id = ${cid} ORDER BY coc.id`
  );
  await fetch1("Customer Proformas", `SELECT * FROM customer_proformas WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Customer Proforma Lines",
    `SELECT cpl.* FROM customer_proforma_lines cpl INNER JOIN customer_proformas cp ON cp.id = cpl.proforma_id WHERE cp.company_id = ${cid} ORDER BY cpl.id`
  );
  await fetch1(
    "Credit Note Items",
    `SELECT cni.* FROM credit_note_items cni INNER JOIN vouchers v ON v.id = cni.voucher_id WHERE v.company_id = ${cid} ORDER BY cni.id`
  );

  // ── Employees ──────────────────────────────────────────────────────────────
  await fetch1(
    "Employees",
    `SELECT * FROM employees WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY first_name, last_name`
  );
  await fetch1(
    "Payroll Runs",
    `SELECT * FROM erp_payroll_runs WHERE company_id = ${cid} ${df("date")} ORDER BY date, id`
  );
  await fetch1(
    "Payroll Run Items",
    `SELECT p.* FROM erp_payroll_run_items p INNER JOIN erp_payroll_runs r ON r.id = p.run_id WHERE r.company_id = ${cid} ${df("r.date")} ORDER BY r.date, p.id`
  );
  await fetch1("Employee Advances", `SELECT * FROM employee_advances WHERE company_id = ${cid} ORDER BY id`);
  await fetch1(
    "Salary Advances",
    `SELECT * FROM salary_advances WHERE company_id = ${cid} ${df("advance_date")} ORDER BY advance_date, id`
  );
  await fetch1(
    "Salary Advance Deductions",
    `SELECT sad.* FROM salary_advance_deductions sad INNER JOIN salary_advances sa ON sa.id = sad.salary_advance_id WHERE sa.company_id = ${cid} ORDER BY sad.id`
  );
  await fetch1(
    "Employee Advance Repayments",
    `SELECT * FROM employee_advance_repayments WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Employee Attendance",
    `SELECT * FROM employee_attendance WHERE company_id = ${cid} ${df("attendance_date")} ORDER BY attendance_date, id`
  );
  await fetch1(
    "Employee Bonuses",
    `SELECT * FROM employee_bonuses WHERE company_id = ${cid} ${df("bonus_date")} ORDER BY bonus_date, id`
  );
  await fetch1("Employee Groups", `SELECT * FROM employee_groups WHERE company_id = ${cid} ORDER BY name`);
  await fetch1(
    "Employee Group Members",
    `SELECT egm.* FROM employee_group_members egm INNER JOIN employee_groups eg ON eg.id = egm.employee_group_id WHERE eg.company_id = ${cid} ORDER BY egm.id`
  );
  await fetch1("Employee Bale Rates", `SELECT * FROM employee_bale_rates WHERE company_id = ${cid} ORDER BY id`);
  await fetch1(
    "Employee Bale Pct Rates",
    `SELECT * FROM employee_bale_pct_rates WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1("Worker Documents", `SELECT * FROM erp_worker_docs WHERE company_id = ${cid} ORDER BY id`);

  // ── Factory Workers ────────────────────────────────────────────────────────
  await fetch1("Factory Workers", `SELECT * FROM factory_workers WHERE company_id = ${cid} ORDER BY full_name`);
  await fetch1(
    "Factory Worker Categories",
    `SELECT * FROM factory_worker_categories WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Factory Worker Documents",
    `SELECT * FROM factory_worker_documents WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Factory Worker Advances",
    `SELECT * FROM factory_worker_advances WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Factory Advance Repayments",
    `SELECT * FROM factory_advance_repayments WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Factory Payrolls",
    `SELECT * FROM factory_payrolls WHERE company_id = ${cid} ${df("period_start")} ORDER BY period_start, id`
  );
  await fetch1(
    "Factory Attendance",
    `SELECT * FROM factory_attendance WHERE company_id = ${cid} ${df("attendance_date")} ORDER BY attendance_date, id`
  );
  await fetch1("Worker Bonuses", `SELECT * FROM worker_bonuses WHERE company_id = ${cid} ORDER BY id`);

  // ── Factory Operations ─────────────────────────────────────────────────────
  await fetch1("Factory Settings", `SELECT * FROM factory_settings WHERE company_id = ${cid}`);
  await fetch1("Factory Categories", `SELECT * FROM factory_categories WHERE company_id = ${cid} ORDER BY name`);
  await fetch1(
    "Factory Daybook",
    `SELECT * FROM factory_daybook_entries WHERE company_id = ${cid} ${df("tx_date")} ORDER BY tx_date, id`
  );
  await fetch1(
    "Daybook Entry Edits",
    `SELECT fde.* FROM factory_daybook_entry_edits fde INNER JOIN factory_daybook_entries fdb ON fdb.id = fde.daybook_entry_id WHERE fdb.company_id = ${cid} ORDER BY fde.id`
  );

  return { wb, summaryRows, summaryWs, fetch1 };
}
