import { db, sql } from "./reportShardSupport";
import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";

/** One debit/credit leg aggregated into a journal_entries row by json_agg. */
type JournalEntryLine = { account: string; dr: number; cr: number };

export const phase6QueryTypes = [
  "customer_list",
  "supplier_list",
  "stock_item_detail",
  "factory_mix_batches",
  "customer_proformas",
  "supplier_proformas",
  "weekly_sales",
  "container_items_list",
  "employee_list",
  "journal_entries",
] as const;

async function runPhase6Report(ctx: DataQueryContext): Promise<DataQueryResult> {
  const { companyId, params, dateFrom, dateTo, rowLimit, fmt, fmtDec } = ctx;
  let dataQueryResult: DataQueryResult;

  switch (params.queryType) {
    case "customer_list": {
      const nameFilter6 = params.entityName;
      const rows = await db.execute<{
        code: string;
        legal_name: string;
        phone: string | null;
        payment_terms_days: number | null;
        active: boolean;
        net_balance: string | null;
      }>(sql`
        SELECT c.code, c.legal_name, c.phone, c.payment_terms_days, c.active,
          COALESCE(
            CAST(c.opening_balance AS numeric) * CASE WHEN c.opening_balance_side = 'Dr' THEN 1 ELSE -1 END
            + COALESCE(SUM(CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric)), 0),
            CAST(c.opening_balance AS numeric) * CASE WHEN c.opening_balance_side = 'Dr' THEN 1 ELSE -1 END
          ) AS net_balance
        FROM customers c
        LEFT JOIN ledger_accounts la ON la.id = c.ledger_account_id AND la.deleted_at IS NULL
        LEFT JOIN voucher_entries ve ON ve.ledger_account_id = la.id
        LEFT JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL AND v.optional = false
        WHERE c.company_id = ${companyId}
          AND c.deleted_at IS NULL
          ${nameFilter6 ? sql`AND c.legal_name ILIKE ${"%" + nameFilter6 + "%"}` : sql``}
        GROUP BY c.id, c.code, c.legal_name, c.phone, c.payment_terms_days, c.active, c.opening_balance, c.opening_balance_side
        ORDER BY c.legal_name
        LIMIT ${rowLimit}
      `);
      let totalBalance = 0;
      const tableRows6 = rows.rows.map((r) => {
        const bal = parseFloat(r.net_balance || "0");
        totalBalance += Math.max(bal, 0);
        const balLabel = bal >= 0 ? fmt(bal) + " Dr" : fmt(Math.abs(bal)) + " Cr";
        return [
          r.code,
          r.legal_name,
          r.phone || "—",
          r.payment_terms_days ? `${r.payment_terms_days}d` : "—",
          balLabel,
          r.active ? "Active" : "Inactive",
        ];
      });
      const stats6 = [
        { label: "Total Customers", value: String(tableRows6.length) },
        { label: "Total Outstanding (Dr)", value: fmt(totalBalance), highlight: "positive" },
      ];
      dataQueryResult = {
        queryType: "customer_list",
        title: nameFilter6 ? `Customers: ${nameFilter6}` : "Customer List",
        subtitle: `${tableRows6.length} customer(s)`,
        stats: stats6,
        table: { headers: ["Code", "Name", "Phone", "Terms", "Balance", "Status"], rows: tableRows6 },
        noData: tableRows6.length === 0,
      };
      break;
    }

    case "supplier_list": {
      const nameFilter6 = params.entityName;
      const rows = await db.execute<{
        code: string;
        legal_name: string;
        email: string | null;
        phone: string | null;
        payment_terms: string | null;
        active: boolean;
        po_count: string;
        total_ordered: string;
      }>(sql`
        SELECT s.code, s.legal_name, s.email, s.phone, s.payment_terms, s.active,
          COUNT(DISTINCT po.id) AS po_count,
          COALESCE(SUM(CAST(po.items_total AS numeric)), 0) AS total_ordered
        FROM suppliers s
        JOIN purchase_orders po ON po.supplier_id = s.id AND po.company_id = ${companyId}
        WHERE s.deleted_at IS NULL
          ${nameFilter6 ? sql`AND s.legal_name ILIKE ${"%" + nameFilter6 + "%"}` : sql``}
        GROUP BY s.id, s.code, s.legal_name, s.email, s.phone, s.payment_terms, s.active
        ORDER BY total_ordered DESC
        LIMIT ${rowLimit}
      `);
      const tableRows6 = rows.rows.map((r) => [
        r.code || "—",
        r.legal_name,
        r.email || "—",
        r.phone || "—",
        r.payment_terms || "—",
        String(r.po_count),
        fmt(parseFloat(r.total_ordered || "0")),
        r.active ? "Active" : "Inactive",
      ]);
      const stats6 = [
        { label: "Suppliers", value: String(tableRows6.length) },
        { label: "Total POs", value: String(tableRows6.reduce((s, r) => s + parseInt(r[5]), 0)) },
      ];
      dataQueryResult = {
        queryType: "supplier_list",
        title: nameFilter6 ? `Suppliers: ${nameFilter6}` : "Supplier List",
        subtitle: `${tableRows6.length} supplier(s) · ranked by total ordered`,
        stats: stats6,
        table: {
          headers: ["Code", "Name", "Email", "Phone", "Terms", "POs", "Total Ordered", "Status"],
          rows: tableRows6,
        },
        noData: tableRows6.length === 0,
      };
      break;
    }

    case "stock_item_detail": {
      const itemName6 = params.entityName;
      if (!itemName6) {
        dataQueryResult = {
          queryType: "stock_item_detail",
          title: "Stock Item Detail",
          summary: "Please specify an item name.",
        };
        break;
      }
      const itemRow = await db.execute<{
        id: number;
        code: string;
        name: string;
        uom: string | null;
        selling_price: string | null;
        reorder_level: string | null;
        opening_qty: string | null;
        opening_rate: string | null;
        opening_value: string | null;
        active: boolean;
        group_name: string | null;
      }>(sql`
        SELECT si.id, si.code, si.name, si.uom, si.selling_price, si.reorder_level,
          si.opening_qty, si.opening_rate, si.opening_value, si.active,
          sg.name AS group_name
        FROM stock_items si
        LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id
        WHERE si.company_id = ${companyId}
          AND si.deleted_at IS NULL
          AND si.name ILIKE ${"%" + itemName6 + "%"}
        ORDER BY si.name LIMIT 1
      `);
      if (!itemRow.rows.length) {
        dataQueryResult = {
          queryType: "stock_item_detail",
          title: "Stock Item Detail",
          summary: `No item found matching "${itemName6}".`,
        };
        break;
      }
      const si6 = itemRow.rows[0];
      const invRows = await db.execute<{ location: string; qty: string; avg_rate: string; total_value: string }>(sql`
        SELECT l.name AS location,
          CAST(inv.quantity AS numeric) AS qty,
          CAST(inv.avg_rate AS numeric) AS avg_rate,
          CAST(inv.total_value AS numeric) AS total_value
        FROM inventory inv
        JOIN locations l ON l.id = inv.location_id
        WHERE inv.stock_item_id = ${si6.id}
          AND inv.company_id = ${companyId}
          AND inv.quantity > 0
        ORDER BY inv.quantity DESC
      `);
      let totalQty = 0,
        totalVal = 0;
      const tableRows6 = invRows.rows.map((r) => {
        const qty = parseFloat(r.qty || "0");
        const val = parseFloat(r.total_value || "0");
        totalQty += qty;
        totalVal += val;
        return [r.location, fmtDec(qty), fmtDec(parseFloat(r.avg_rate || "0")), fmt(val)];
      });
      const stats6 = [
        { label: "Code", value: si6.code },
        { label: "Group", value: si6.group_name || "—" },
        { label: "UOM", value: si6.uom },
        { label: "Selling Price", value: fmtDec(parseFloat(si6.selling_price || "0")) },
        { label: "Reorder Level", value: `${fmtDec(parseFloat(si6.reorder_level || "0"))} ${si6.uom}` },
        {
          label: "Total Stock",
          value: `${fmtDec(totalQty)} ${si6.uom}`,
          highlight: totalQty > 0 ? "positive" : "negative",
        },
        { label: "Total Value", value: fmt(totalVal), highlight: "positive" },
      ];
      dataQueryResult = {
        queryType: "stock_item_detail",
        title: `Item: ${si6.name}`,
        subtitle: `${tableRows6.length} location(s) with stock`,
        stats: stats6,
        table: { headers: ["Location", "Qty", "Avg Rate", "Value"], rows: tableRows6 },
        noData: tableRows6.length === 0,
      };
      break;
    }

    case "factory_mix_batches": {
      const statusFilter6 = params.entityName?.toUpperCase() || null;
      const rows = await db.execute<{
        batch_code: string;
        name: string | null;
        batch_date: string | null;
        status: string;
        total_kg: string | null;
        used_kg: string | null;
        cost_per_kg: string | null;
        total_cost: string | null;
        operator_user: string | null;
      }>(sql`
        SELECT fmb.batch_code, fmb.name, fmb.batch_date, fmb.status,
          CAST(fmb.total_weight_kg AS numeric) AS total_kg,
          CAST(fmb.used_kg AS numeric) AS used_kg,
          CAST(fmb.cost_per_kg AS numeric) AS cost_per_kg,
          CAST(fmb.total_cost AS numeric) AS total_cost,
          fmb.operator_user
        FROM factory_mix_batches fmb
        WHERE fmb.company_id = ${companyId}
          AND fmb.deleted_at IS NULL
          ${statusFilter6 ? sql`AND fmb.status = ${statusFilter6}` : sql``}
          ${params.dateFrom ? sql`AND fmb.batch_date >= ${params.dateFrom}` : sql``}
        ORDER BY fmb.batch_date DESC, fmb.id DESC
        LIMIT ${rowLimit}
      `);
      let totWeight = 0,
        totUsed = 0,
        totCost = 0;
      const tableRows6 = rows.rows.map((r) => {
        const totalKg = parseFloat(r.total_kg || "0");
        const usedKg = parseFloat(r.used_kg || "0");
        const remainKg = totalKg - usedKg;
        const pct = totalKg > 0 ? ((usedKg / totalKg) * 100).toFixed(1) + "%" : "—";
        totWeight += totalKg;
        totUsed += usedKg;
        totCost += parseFloat(r.total_cost || "0");
        return [
          r.batch_code,
          r.name || "—",
          r.batch_date ? String(r.batch_date).slice(0, 10) : "—",
          r.status,
          fmtDec(totalKg),
          fmtDec(usedKg),
          fmtDec(remainKg),
          pct,
          fmtDec(parseFloat(r.cost_per_kg || "0")),
          r.operator_user || "—",
        ];
      });
      const stats6 = [
        { label: "Batches", value: String(tableRows6.length) },
        { label: "Total Weight Kg", value: fmtDec(totWeight) },
        { label: "Used Kg", value: fmtDec(totUsed) },
        { label: "Remaining Kg", value: fmtDec(totWeight - totUsed), highlight: "positive" },
        { label: "Total Cost", value: fmt(totCost) },
      ];
      dataQueryResult = {
        queryType: "factory_mix_batches",
        title: statusFilter6 ? `Mix Batches — ${statusFilter6}` : "Factory Mix Batches",
        subtitle: `${tableRows6.length} batch(es)`,
        stats: stats6,
        table: {
          headers: [
            "Code",
            "Name",
            "Date",
            "Status",
            "Total Kg",
            "Used Kg",
            "Remaining",
            "Usage%",
            "Cost/Kg",
            "Operator",
          ],
          rows: tableRows6,
        },
        noData: tableRows6.length === 0,
      };
      break;
    }

    case "customer_proformas": {
      const custFilter6 = params.entityName;
      const rows = await db.execute<{
        id: number;
        proforma_name: string;
        customer: string | null;
        is_active: boolean;
        created_at: Date;
        line_count: string;
        total_qty: string;
        total_value: string;
      }>(sql`
        SELECT cp.id, cp.name AS proforma_name, cu.legal_name AS customer,
          cp.is_active, cp.created_at,
          COUNT(cpl.id) AS line_count,
          COALESCE(SUM(cpl.quantity), 0) AS total_qty,
          COALESCE(SUM(CAST(cpl.price_per_bale AS numeric) * cpl.quantity), 0) AS total_value
        FROM customer_proformas cp
        JOIN customers cu ON cu.id = cp.customer_id
        LEFT JOIN customer_proforma_lines cpl ON cpl.proforma_id = cp.id
        WHERE cp.company_id = ${companyId}
          AND cp.deleted_at IS NULL
          ${custFilter6 ? sql`AND cu.legal_name ILIKE ${"%" + custFilter6 + "%"}` : sql``}
        GROUP BY cp.id, cp.name, cu.legal_name, cp.is_active, cp.created_at
        ORDER BY cp.is_active DESC, cu.legal_name
        LIMIT ${rowLimit}
      `);
      const tableRows6 = rows.rows.map((r) => [
        r.proforma_name,
        r.customer,
        String(r.line_count),
        String(r.total_qty),
        fmt(parseFloat(r.total_value || "0")),
        r.is_active ? "Active" : "Inactive",
        String(r.created_at).slice(0, 10),
      ]);
      dataQueryResult = {
        queryType: "customer_proformas",
        title: custFilter6 ? `Customer Proformas: ${custFilter6}` : "Customer Proformas",
        subtitle: `${tableRows6.length} proforma(s)`,
        table: {
          headers: ["Proforma", "Customer", "Items", "Total Qty", "Total Value", "Status", "Created"],
          rows: tableRows6,
        },
        noData: tableRows6.length === 0,
      };
      break;
    }

    case "supplier_proformas": {
      const suppFilter6 = params.entityName;
      const rows = await db.execute<{
        id: number;
        reference: string;
        supplier: string | null;
        notes: string | null;
        created_at: Date;
        line_count: string;
        total_qty: string;
        total_value: string;
      }>(sql`
        SELECT sp.id, sp.reference, s.legal_name AS supplier, sp.notes, sp.created_at,
          COUNT(spl.id) AS line_count,
          COALESCE(SUM(spl.qty), 0) AS total_qty,
          COALESCE(SUM(CAST(spl.price_per_bale AS numeric) * spl.qty), 0) AS total_value
        FROM supplier_proformas sp
        JOIN suppliers s ON s.id = sp.supplier_id
        LEFT JOIN supplier_proforma_lines spl ON spl.proforma_id = sp.id
        WHERE sp.company_id = ${companyId}
          ${suppFilter6 ? sql`AND s.legal_name ILIKE ${"%" + suppFilter6 + "%"}` : sql``}
        GROUP BY sp.id, sp.reference, s.legal_name, sp.notes, sp.created_at
        ORDER BY sp.created_at DESC
        LIMIT ${rowLimit}
      `);
      const tableRows6 = rows.rows.map((r) => [
        r.reference,
        r.supplier,
        String(r.line_count),
        String(r.total_qty),
        fmt(parseFloat(r.total_value || "0")),
        String(r.created_at).slice(0, 10),
        (r.notes || "").slice(0, 40),
      ]);
      dataQueryResult = {
        queryType: "supplier_proformas",
        title: suppFilter6 ? `Supplier Proformas: ${suppFilter6}` : "Supplier Proformas",
        subtitle: `${tableRows6.length} proforma(s)`,
        table: {
          headers: ["Reference", "Supplier", "Items", "Total Qty", "Total Value", "Date", "Notes"],
          rows: tableRows6,
        },
        noData: tableRows6.length === 0,
      };
      break;
    }

    case "weekly_sales": {
      const rows = await db.execute<{
        week_start: Date;
        sales_count: string;
        revenue: string | null;
        cost: string | null;
        profit: string | null;
      }>(sql`
        SELECT DATE_TRUNC('week', CAST(v.voucher_date AS date)) AS week_start,
          COUNT(DISTINCT v.id) AS sales_count,
          SUM(CAST(sal.total_sales AS numeric)) AS revenue,
          SUM(CAST(sal.total_cost AS numeric)) AS cost,
          SUM(CAST(sal.profit AS numeric)) AS profit
        FROM sales_items sal
        JOIN vouchers v ON v.id = sal.voucher_id AND v.deleted_at IS NULL
        WHERE v.company_id = ${companyId}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY week_start
        ORDER BY week_start DESC
        LIMIT ${rowLimit}
      `);
      let totRev = 0,
        totCost = 0,
        totProfit = 0;
      const tableRows6 = rows.rows.map((r) => {
        const rev = parseFloat(r.revenue || "0");
        const cost = parseFloat(r.cost || "0");
        const profit6 = parseFloat(r.profit || "0");
        const margin = rev > 0 ? ((profit6 / rev) * 100).toFixed(1) + "%" : "—";
        totRev += rev;
        totCost += cost;
        totProfit += profit6;
        const ws = String(r.week_start).slice(0, 10);
        return [ws, String(r.sales_count), fmt(rev), fmt(cost), fmt(profit6), margin];
      });
      if (tableRows6.length) {
        const totMargin = totRev > 0 ? ((totProfit / totRev) * 100).toFixed(1) + "%" : "—";
        tableRows6.push(["TOTAL", "", fmt(totRev), fmt(totCost), fmt(totProfit), totMargin]);
      }
      dataQueryResult = {
        queryType: "weekly_sales",
        title: "Weekly Sales Breakdown",
        subtitle: `${dateFrom} → ${dateTo}`,
        table: {
          headers: ["Week Starting", "Invoices", "Revenue", "Cost", "Profit", "Margin"],
          rows: tableRows6,
        },
        noData: tableRows6.length === 0,
      };
      break;
    }

    case "container_items_list": {
      const cn6 = params.containerNumber || params.entityName;
      if (!cn6) {
        dataQueryResult = {
          queryType: "container_items_list",
          title: "Container Items",
          summary: "Please specify a container number.",
        };
        break;
      }
      const rows = await db.execute<{
        container_number: string;
        supplier: string | null;
        import_date: string | null;
        item_name: string;
        code: string | null;
        uom: string | null;
        qty: string;
        rate: string;
        line_total: string;
        po_number: string;
        currency: string;
      }>(sql`
        SELECT c.container_number, s.legal_name AS supplier, c.import_date,
          pli.item_name, si.code, si.uom,
          CAST(pli.quantity AS numeric) AS qty,
          CAST(pli.rate AS numeric) AS rate,
          CAST(pli.line_total AS numeric) AS line_total,
          po.po_number, po.currency
        FROM po_line_items pli
        JOIN purchase_orders po ON po.id = pli.po_id
        JOIN containers c ON c.id = po.container_id
        JOIN suppliers s ON s.id = c.supplier_id
        JOIN stock_items si ON si.id = pli.stock_item_id
        WHERE c.container_number ILIKE ${"%" + cn6 + "%"}
          AND po.company_id = ${companyId}
        ORDER BY pli.item_name
        LIMIT ${rowLimit}
      `);
      let grandItems = 0;
      const tableRows6 = rows.rows.map((r) => {
        const lt = parseFloat(r.line_total || "0");
        grandItems += lt;
        return [
          r.item_name,
          r.code,
          `${fmtDec(parseFloat(r.qty))} ${r.uom}`,
          fmtDec(parseFloat(r.rate)),
          fmt(lt),
          r.po_number,
          r.currency,
        ];
      });
      const hdr = rows.rows[0];
      tableRows6.push(["TOTAL", "", "", "", fmt(grandItems), "", ""]);
      dataQueryResult = {
        queryType: "container_items_list",
        title: `Items in Container: ${hdr?.container_number || cn6}`,
        subtitle: hdr ? `Supplier: ${hdr.supplier} · Import: ${String(hdr.import_date).slice(0, 10)}` : "",
        table: { headers: ["Item", "Code", "Qty", "Rate", "Total", "PO #", "Currency"], rows: tableRows6 },
        noData: tableRows6.length <= 1,
      };
      break;
    }

    case "employee_list": {
      const deptFilter6 = params.entityName;
      const rows = await db.execute<{
        code: string;
        first_name: string;
        last_name: string | null;
        department: string | null;
        employee_type: string | null;
        monthly_salary: string | null;
        current_balance: string | null;
        join_date: string | null;
        active: boolean;
      }>(sql`
        SELECT e.code, e.first_name, e.last_name, e.department, e.employee_type,
          CAST(e.monthly_salary AS numeric) AS monthly_salary,
          CAST(e.current_balance AS numeric) AS current_balance,
          e.join_date, e.active
        FROM employees e
        WHERE e.company_id = ${companyId}
          AND e.active = true
          AND e.deleted_at IS NULL
          ${deptFilter6 ? sql`AND e.department ILIKE ${"%" + deptFilter6 + "%"}` : sql``}
        ORDER BY e.department, e.first_name, e.last_name
        LIMIT ${rowLimit}
      `);
      let totalSalary = 0,
        totalBalance = 0;
      const tableRows6 = rows.rows.map((r) => {
        const sal = parseFloat(r.monthly_salary || "0");
        const bal = parseFloat(r.current_balance || "0");
        totalSalary += sal;
        totalBalance += bal;
        return [
          r.code || "—",
          `${r.first_name} ${r.last_name}`,
          r.department || "—",
          r.employee_type,
          fmt(sal),
          fmt(bal),
          r.join_date ? String(r.join_date).slice(0, 10) : "—",
        ];
      });
      const stats6 = [
        { label: "Total Employees", value: String(tableRows6.length) },
        { label: "Total Monthly Salary", value: fmt(totalSalary), highlight: "positive" },
        { label: "Total Outstanding Balance", value: fmt(totalBalance) },
      ];
      dataQueryResult = {
        queryType: "employee_list",
        title: deptFilter6 ? `Employees — ${deptFilter6}` : "Employee Roster",
        subtitle: `${tableRows6.length} active employee(s)`,
        stats: stats6,
        table: {
          headers: ["Code", "Name", "Dept", "Type", "Monthly Salary", "Balance", "Join Date"],
          rows: tableRows6,
        },
        noData: tableRows6.length === 0,
      };
      break;
    }

    case "journal_entries": {
      const rows = await db.execute<{
        voucher_date: string;
        voucher_number: string;
        description: string | null;
        total_amount: string;
        currency: string;
        entries: JournalEntryLine[] | string;
      }>(sql`
        SELECT v.voucher_date, v.voucher_number, v.description,
          CAST(v.total_amount AS numeric) AS total_amount,
          v.currency,
          json_agg(json_build_object(
            'account', la.name,
            'dr', CAST(ve.debit_amount AS numeric),
            'cr', CAST(ve.credit_amount AS numeric)
          ) ORDER BY ve.id) AS entries
        FROM vouchers v
        JOIN voucher_entries ve ON ve.voucher_id = v.id
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND v.voucher_type = 'Journal'
          AND v.optional = false
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY v.id, v.voucher_date, v.voucher_number, v.description, v.total_amount, v.currency
        ORDER BY v.voucher_date DESC
        LIMIT ${rowLimit}
      `);
      const tableRows6: string[][] = [];
      for (const r of rows.rows) {
        const entries: JournalEntryLine[] =
          typeof r.entries === "string" ? (JSON.parse(r.entries) as JournalEntryLine[]) : r.entries;
        const firstEntry = entries?.[0];
        tableRows6.push([
          String(r.voucher_date).slice(0, 10),
          r.voucher_number,
          (r.description || "").slice(0, 35),
          firstEntry?.account || "—",
          firstEntry?.dr > 0 ? fmt(firstEntry.dr) : "—",
          firstEntry?.cr > 0 ? fmt(firstEntry.cr) : "—",
          r.currency,
        ]);
        for (let i = 1; i < (entries || []).length && i < 4; i++) {
          const e = entries[i];
          tableRows6.push(["", "", "", e.account, e.dr > 0 ? fmt(e.dr) : "—", e.cr > 0 ? fmt(e.cr) : "—", ""]);
        }
      }
      dataQueryResult = {
        queryType: "journal_entries",
        title: "Journal Entries",
        subtitle: `${dateFrom} → ${dateTo} · ${rows.rows.length} journal(s)`,
        table: {
          headers: ["Date", "Voucher #", "Description", "Account", "Dr", "Cr", "Currency"],
          rows: tableRows6,
        },
        noData: tableRows6.length === 0,
      };
      break;
    }

    default:
      return undefined;
  }

  return dataQueryResult;
}

export const phase6ReportShard: ReportImplementationShard = {
  name: "phase-6",
  queryTypes: phase6QueryTypes,
  run: runPhase6Report,
};
