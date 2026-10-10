import { db, sql, nonPartyAccountTypesSql, accountTypesOfClassSql } from "./reportShardSupport";
import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import { notFiscalClosingVoucher } from "../../../services/accounting/balances/periodReportRules";

export const phase2QueryTypes = [
  "inventory_check",
  "low_stock_items",
  "stock_movement",
  "open_purchase_orders",
  "customer_aging",
  "supplier_aging",
  "container_list",
  "monthly_comparison",
  "rental_summary",
  "payroll_summary",
] as const;

async function runPhase2Report(ctx: DataQueryContext): Promise<DataQueryResult> {
  const {
    companyId,
    params,
    dateFrom,
    dateTo,
    todayStr,
    todayDate,
    thisMonthStart,
    lastMonthStart,
    lastMonthEnd,
    rowLimit,
    fmt,
    fmtDec,
  } = ctx;
  let dataQueryResult: DataQueryResult;

  switch (params.queryType) {
    case "inventory_check": {
      const itemName = params.entityName;
      const locName = params.locationName;
      const rows = await db.execute<{
        item_name: string;
        code: string;
        uom: string;
        location_name: string;
        qty: string;
        avg_rate: string;
        total_value: string;
      }>(sql`
        SELECT si.name AS item_name, si.code, si.uom,
          l.name AS location_name,
          CAST(inv.quantity AS numeric) AS qty,
          CAST(inv.average_rate AS numeric) AS avg_rate,
          CAST(inv.total_value AS numeric) AS total_value
        FROM inventory inv
        JOIN stock_items si ON si.id = inv.stock_item_id AND si.deleted_at IS NULL
        JOIN locations l ON l.id = inv.location_id
        WHERE inv.company_id = ${companyId}
          AND inv.quantity > 0
          ${itemName ? sql`AND si.name ILIKE ${"%" + itemName + "%"}` : sql``}
          ${locName ? sql`AND l.name ILIKE ${"%" + locName + "%"}` : sql``}
        ORDER BY total_value DESC
        LIMIT ${rowLimit}
      `);
      const tableRows2 = rows.rows.map((r) => [
        r.item_name,
        r.code,
        r.location_name,
        `${fmtDec(parseFloat(r.qty))} ${r.uom}`,
        fmtDec(parseFloat(r.avg_rate)),
        fmt(parseFloat(r.total_value)),
      ]);
      dataQueryResult = {
        queryType: "inventory_check",
        title: itemName ? `Stock Levels: ${itemName}` : "Inventory Stock Levels",
        subtitle: locName ? `Location: ${locName}` : "All locations",
        table: { headers: ["Item", "Code", "Location", "Qty", "Avg Rate", "Total Value"], rows: tableRows2 },
        noData: tableRows2.length === 0,
      };
      break;
    }

    case "low_stock_items": {
      const rows = await db.execute<{
        name: string;
        code: string;
        uom: string;
        reorder_level: string;
        total_qty: string;
      }>(sql`
        SELECT si.name, si.code, si.uom,
          CAST(si.reorder_level AS numeric) AS reorder_level,
          COALESCE(SUM(CAST(inv.quantity AS numeric)), 0) AS total_qty
        FROM stock_items si
        LEFT JOIN inventory inv ON inv.stock_item_id = si.id AND inv.company_id = ${companyId}
        WHERE si.company_id = ${companyId}
          AND si.active = true AND si.deleted_at IS NULL
          AND CAST(si.reorder_level AS numeric) > 0
        GROUP BY si.id, si.name, si.code, si.uom, si.reorder_level
        HAVING COALESCE(SUM(CAST(inv.quantity AS numeric)), 0) < CAST(si.reorder_level AS numeric)
        ORDER BY (COALESCE(SUM(CAST(inv.quantity AS numeric)), 0) / NULLIF(CAST(si.reorder_level AS numeric), 0)) ASC
        LIMIT ${rowLimit}
      `);
      const tableRows2 = rows.rows.map((r) => [
        r.name,
        r.code,
        `${fmtDec(parseFloat(r.total_qty))} ${r.uom}`,
        `${fmtDec(parseFloat(r.reorder_level))} ${r.uom}`,
        `${Math.round((parseFloat(r.total_qty) / parseFloat(r.reorder_level)) * 100)}%`,
      ]);
      dataQueryResult = {
        queryType: "low_stock_items",
        title: "Items Below Reorder Level",
        subtitle: `${tableRows2.length} item(s) need restocking`,
        table: { headers: ["Item", "Code", "Current Stock", "Reorder Level", "Stock %"], rows: tableRows2 },
        noData: tableRows2.length === 0,
      };
      break;
    }

    case "stock_movement": {
      const itemName = params.entityName;
      if (!itemName) {
        dataQueryResult = {
          queryType: "stock_movement",
          title: "Stock Movement",
          summary: "Please specify an item name.",
        };
        break;
      }
      const rows = await db.execute<{
        voucher_date: string;
        adjustment_type: string;
        location: string;
        item_name: string;
        uom: string;
        qty: string;
        rate: string;
      }>(sql`
        SELECT v.voucher_date, sav.adjustment_type, l.name AS location,
          si.name AS item_name, si.uom,
          CAST(sai.quantity AS numeric) AS qty,
          CAST(sai.rate AS numeric) AS rate
        FROM stock_adjustment_items sai
        JOIN stock_adjustment_vouchers sav ON sav.id = sai.adjustment_id
        JOIN vouchers v ON v.id = sav.voucher_id AND v.deleted_at IS NULL
        JOIN stock_items si ON si.id = sai.stock_item_id
        JOIN locations l ON l.id = sav.location_id
        WHERE si.company_id = ${companyId}
          AND si.name ILIKE ${"%" + itemName + "%"}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY v.voucher_date DESC
        LIMIT ${rowLimit}
      `);
      const tableRows2 = rows.rows.map((r) => [
        String(r.voucher_date).slice(0, 10),
        r.adjustment_type,
        r.location,
        `${fmtDec(Math.abs(parseFloat(r.qty)))} ${r.uom}`,
        parseFloat(r.qty) >= 0 ? "IN" : "OUT",
      ]);
      dataQueryResult = {
        queryType: "stock_movement",
        title: `Stock Movement: ${itemName}`,
        subtitle: `${dateFrom} → ${dateTo}`,
        table: { headers: ["Date", "Type", "Location", "Qty", "Direction"], rows: tableRows2 },
        noData: tableRows2.length === 0,
      };
      break;
    }

    case "open_purchase_orders": {
      const supplierName = params.entityName;
      const rows = await db.execute<{
        po_number: string;
        supplier: string;
        container_number: string | null;
        currency: string;
        items_total: string;
        status: string;
        created_at: Date;
      }>(sql`
        SELECT po.po_number, s.legal_name AS supplier,
          c.container_number, po.currency,
          CAST(po.items_total AS numeric) AS items_total,
          po.status, po.created_at
        FROM purchase_orders po
        JOIN suppliers s ON s.id = po.supplier_id
        JOIN containers c ON c.id = po.container_id
        WHERE po.company_id = ${companyId}
          AND po.status = 'Open'
          ${supplierName ? sql`AND s.legal_name ILIKE ${"%" + supplierName + "%"}` : sql``}
        ORDER BY po.created_at DESC
        LIMIT ${rowLimit}
      `);
      const tableRows2 = rows.rows.map((r) => [
        r.po_number,
        r.supplier,
        r.container_number,
        r.currency,
        fmtDec(parseFloat(r.items_total || "0")),
        r.status,
      ]);
      dataQueryResult = {
        queryType: "open_purchase_orders",
        title: supplierName ? `Open POs — ${supplierName}` : "Open Purchase Orders",
        subtitle: `${tableRows2.length} open PO(s)`,
        table: {
          headers: ["PO #", "Supplier", "Container", "Currency", "Items Total", "Status"],
          rows: tableRows2,
        },
        noData: tableRows2.length === 0,
      };
      break;
    }

    case "customer_aging": {
      const rows = await db.execute<{
        name: string;
        ob: string;
        total_debit: string;
        total_credit: string;
        bucket_0_30: string;
        bucket_31_60: string;
        bucket_61_90: string;
        bucket_over_90: string;
      }>(sql`
        SELECT la.name,
          COALESCE(CASE WHEN la.opening_balance_side = 'Cr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END, 0) AS ob,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS total_debit,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS total_credit,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) BETWEEN 0 AND 30
            THEN CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS bucket_0_30,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) BETWEEN 31 AND 60
            THEN CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS bucket_31_60,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) BETWEEN 61 AND 90
            THEN CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS bucket_61_90,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) > 90
            THEN CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS bucket_over_90
        FROM ledger_accounts la
        LEFT JOIN voucher_entries ve ON ve.ledger_account_id = la.id
        LEFT JOIN vouchers v ON v.id = ve.voucher_id
        WHERE la.company_id = ${companyId} AND la.active = true AND la.deleted_at IS NULL
          AND LOWER(TRIM(la.account_type)) NOT IN (${nonPartyAccountTypesSql(["Accounts Payable", "Loans"])})
        GROUP BY la.id, la.name, la.opening_balance, la.opening_balance_side
        HAVING (
          COALESCE(CASE WHEN la.opening_balance_side = 'Cr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END, 0)
          + COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0)
        ) > 100
        ORDER BY (
          COALESCE(CASE WHEN la.opening_balance_side = 'Cr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END, 0)
          + COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0)
        ) DESC
        LIMIT ${rowLimit}
      `);
      let grandTotal0_30 = 0,
        grandTotal31_60 = 0,
        grandTotal61_90 = 0,
        grandTotalOver90 = 0,
        grandTotalAll = 0;
      const tableRows2 = rows.rows.map((r) => {
        const balance = parseFloat(r.ob) + parseFloat(r.total_debit) - parseFloat(r.total_credit);
        const b0 = parseFloat(r.bucket_0_30);
        const b1 = parseFloat(r.bucket_31_60);
        const b2 = parseFloat(r.bucket_61_90);
        const b3 = parseFloat(r.bucket_over_90);
        grandTotal0_30 += b0;
        grandTotal31_60 += b1;
        grandTotal61_90 += b2;
        grandTotalOver90 += b3;
        grandTotalAll += balance;
        return [
          r.name,
          fmt(balance),
          fmt(b0 > 0 ? b0 : 0),
          fmt(b1 > 0 ? b1 : 0),
          fmt(b2 > 0 ? b2 : 0),
          fmt(b3 > 0 ? b3 : 0),
        ];
      });
      tableRows2.push([
        "TOTAL",
        fmt(grandTotalAll),
        fmt(grandTotal0_30),
        fmt(grandTotal31_60),
        fmt(grandTotal61_90),
        fmt(grandTotalOver90),
      ]);
      dataQueryResult = {
        queryType: "customer_aging",
        title: "Customer Receivables Aging",
        subtitle: `As of ${todayStr}`,
        table: {
          headers: ["Account", "Total", "0-30 days", "31-60 days", "61-90 days", "90+ days"],
          rows: tableRows2,
        },
        noData: tableRows2.length <= 1,
      };
      break;
    }

    case "supplier_aging": {
      const rows = await db.execute<{
        name: string;
        ob: string;
        total_debit: string;
        total_credit: string;
        bucket_0_30: string;
        bucket_31_60: string;
        bucket_61_90: string;
        bucket_over_90: string;
      }>(sql`
        SELECT la.name,
          COALESCE(CASE WHEN la.opening_balance_side = 'Dr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END, 0) AS ob,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS total_credit,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS total_debit,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) BETWEEN 0 AND 30
            THEN CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS bucket_0_30,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) BETWEEN 31 AND 60
            THEN CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS bucket_31_60,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) BETWEEN 61 AND 90
            THEN CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS bucket_61_90,
          COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false AND CURRENT_DATE - CAST(v.voucher_date AS date) > 90
            THEN CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS bucket_over_90
        FROM ledger_accounts la
        LEFT JOIN voucher_entries ve ON ve.ledger_account_id = la.id
        LEFT JOIN vouchers v ON v.id = ve.voucher_id
        WHERE la.company_id = ${companyId} AND la.active = true AND la.deleted_at IS NULL
          AND LOWER(TRIM(la.account_type)) IN (${accountTypesOfClassSql("liability")})
        GROUP BY la.id, la.name, la.opening_balance, la.opening_balance_side
        HAVING (
          COALESCE(CASE WHEN la.opening_balance_side = 'Dr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END, 0)
          + COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0)
        ) > 100
        ORDER BY (
          COALESCE(CASE WHEN la.opening_balance_side = 'Dr' THEN -CAST(la.opening_balance AS numeric) ELSE CAST(la.opening_balance AS numeric) END, 0)
          + COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.credit_amount AS numeric) ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN v.deleted_at IS NULL AND v.optional = false THEN CAST(ve.debit_amount AS numeric) ELSE 0 END), 0)
        ) DESC
        LIMIT ${rowLimit}
      `);
      let sgTotal0_30 = 0,
        sgTotal31_60 = 0,
        sgTotal61_90 = 0,
        sgTotalOver90 = 0,
        sgTotalAll = 0;
      const tableRows2 = rows.rows.map((r) => {
        const balance = parseFloat(r.ob) + parseFloat(r.total_credit) - parseFloat(r.total_debit);
        const b0 = parseFloat(r.bucket_0_30);
        const b1 = parseFloat(r.bucket_31_60);
        const b2 = parseFloat(r.bucket_61_90);
        const b3 = parseFloat(r.bucket_over_90);
        sgTotal0_30 += b0;
        sgTotal31_60 += b1;
        sgTotal61_90 += b2;
        sgTotalOver90 += b3;
        sgTotalAll += balance;
        return [
          r.name,
          fmt(balance),
          fmt(b0 > 0 ? b0 : 0),
          fmt(b1 > 0 ? b1 : 0),
          fmt(b2 > 0 ? b2 : 0),
          fmt(b3 > 0 ? b3 : 0),
        ];
      });
      tableRows2.push([
        "TOTAL",
        fmt(sgTotalAll),
        fmt(sgTotal0_30),
        fmt(sgTotal31_60),
        fmt(sgTotal61_90),
        fmt(sgTotalOver90),
      ]);
      dataQueryResult = {
        queryType: "supplier_aging",
        title: "Supplier Payables Aging",
        subtitle: `As of ${todayStr}`,
        table: {
          headers: ["Supplier", "Total Owed", "0-30 days", "31-60 days", "61-90 days", "90+ days"],
          rows: tableRows2,
        },
        noData: tableRows2.length <= 1,
      };
      break;
    }

    case "container_list": {
      const statusFilter = params.containerStatus;
      const rows = await db.execute<{
        container_number: string;
        status: string;
        import_date: string | null;
        eta: string | null;
        supplier: string;
        grand_total: string;
        currency: string;
        transporter: string | null;
      }>(sql`
        SELECT c.container_number, c.status, c.import_date, c.eta,
          s.legal_name AS supplier,
          CAST(c.grand_total AS numeric) AS grand_total,
          c.currency, c.transporter
        FROM containers c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.company_id = ${companyId}
          ${statusFilter ? sql`AND c.status ILIKE ${"%" + statusFilter + "%"}` : sql``}
          AND c.import_date BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY c.import_date DESC
        LIMIT ${rowLimit}
      `);
      const tableRows2 = rows.rows.map((r) => [
        r.container_number,
        r.status,
        String(r.import_date).slice(0, 10),
        r.eta ? String(r.eta).slice(0, 10) : "—",
        r.supplier,
        r.transporter || "—",
        fmtDec(parseFloat(r.grand_total || "0")),
      ]);
      dataQueryResult = {
        queryType: "container_list",
        title: statusFilter ? `Containers — ${statusFilter}` : "Container List",
        subtitle: `${dateFrom} → ${dateTo} · ${tableRows2.length} container(s)`,
        table: {
          headers: ["Container #", "Status", "Import Date", "ETA", "Supplier", "Transporter", "Grand Total"],
          rows: tableRows2,
        },
        noData: tableRows2.length === 0,
      };
      break;
    }

    case "monthly_comparison": {
      const runPL = async (from: string, to: string) => {
        const r = await db.execute<{ revenue: string; expenses: string }>(sql`
          SELECT
            COALESCE(SUM(CASE WHEN LOWER(TRIM(la.account_type)) IN (${accountTypesOfClassSql("income")}) THEN CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric) ELSE 0 END), 0) AS revenue,
            COALESCE(SUM(CASE WHEN LOWER(TRIM(la.account_type)) IN (${accountTypesOfClassSql("expense")}) THEN CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric) ELSE 0 END), 0) AS expenses
          FROM voucher_entries ve
          JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL AND v.optional = false
          JOIN ledger_accounts la ON la.id = ve.ledger_account_id
          WHERE la.company_id = ${companyId}
            AND v.company_id = ${companyId}
            AND ${notFiscalClosingVoucher("v")}
            AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${from} AND ${to}
        `);
        const row = r.rows[0];
        const rev = parseFloat(row?.revenue || "0");
        const exp = parseFloat(row?.expenses || "0");
        return { revenue: rev, expenses: exp, net: rev - exp };
      };
      const [thisM, lastM] = await Promise.all([runPL(thisMonthStart, todayStr), runPL(lastMonthStart, lastMonthEnd)]);
      const diff = (a: number, b: number) => {
        if (b === 0) return a > 0 ? "+100%" : "—";
        const pct = ((a - b) / Math.abs(b)) * 100;
        return (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%";
      };
      const tableRows2 = [
        ["Revenue", fmt(lastM.revenue), fmt(thisM.revenue), diff(thisM.revenue, lastM.revenue)],
        ["Expenses", fmt(lastM.expenses), fmt(thisM.expenses), diff(thisM.expenses, lastM.expenses)],
        ["Net Profit", fmt(lastM.net), fmt(thisM.net), diff(thisM.net, lastM.net)],
      ];
      dataQueryResult = {
        queryType: "monthly_comparison",
        title: "Month-over-Month Comparison",
        subtitle: `Last month (${lastMonthStart.slice(0, 7)}) vs This month (${thisMonthStart.slice(0, 7)})`,
        table: { headers: ["Metric", "Last Month", "This Month", "Change"], rows: tableRows2 },
        noData: false,
      };
      break;
    }

    case "rental_summary": {
      const currentYear = todayDate.getFullYear();
      const currentMonth = todayDate.getMonth() + 1;
      const rows = await db.execute<{
        unit_number: string;
        unit_type: string;
        location_group: string | null;
        tenant_name: string | null;
        rental_amount: string | null;
        contract_status: string | null;
        expected: string;
        paid: string;
      }>(sql`
        SELECT pu.unit_number, pu.unit_type, pu.location_group,
          pc.tenant_name, CAST(pc.rental_amount AS numeric) AS rental_amount, pc.status AS contract_status,
          CAST(COALESCE(pml.expected_amount, 0) AS numeric) AS expected,
          CAST(COALESCE(pml.paid_amount, 0) AS numeric) AS paid
        FROM property_units pu
        LEFT JOIN property_contracts pc ON pc.unit_id = pu.id AND pc.status = 'ACTIVE'
        LEFT JOIN property_monthly_ledger pml ON pml.unit_id = pu.id
          AND pml.year = ${currentYear} AND pml.month = ${currentMonth}
        WHERE pu.company_id = ${companyId} AND pu.active = true
        ORDER BY pu.unit_type, pu.location_group, pu.unit_number
        LIMIT ${rowLimit}
      `);
      let totalExpected = 0,
        totalPaid = 0,
        occupied = 0,
        vacant = 0;
      const tableRows2 = rows.rows.map((r) => {
        const exp = parseFloat(r.expected || "0");
        const paid = parseFloat(r.paid || "0");
        totalExpected += exp;
        totalPaid += paid;
        if (r.tenant_name) occupied++;
        else vacant++;
        const balance = exp - paid;
        return [
          r.unit_number,
          r.unit_type,
          r.location_group,
          r.tenant_name || "VACANT",
          fmt(exp),
          fmt(paid),
          fmt(balance),
          balance > 0 ? "OUTSTANDING" : "OK",
        ];
      });
      const stats2 = [
        { label: "Occupied", value: String(occupied) },
        { label: "Vacant", value: String(vacant) },
        { label: "Total Expected", value: fmt(totalExpected) },
        { label: "Total Collected", value: fmt(totalPaid) },
        {
          label: "Outstanding",
          value: fmt(totalExpected - totalPaid),
          highlight: totalExpected - totalPaid > 0 ? "negative" : "positive",
        },
      ];
      dataQueryResult = {
        queryType: "rental_summary",
        title: "Rental Summary",
        subtitle: `${currentYear}-${String(currentMonth).padStart(2, "0")} · ${occupied} occupied, ${vacant} vacant`,
        stats: stats2,
        table: {
          headers: ["Unit", "Type", "Location", "Tenant", "Expected", "Paid", "Balance", "Status"],
          rows: tableRows2,
        },
        noData: tableRows2.length === 0,
      };
      break;
    }

    case "payroll_summary": {
      const rows = await db.execute<{
        worker_name: string;
        period_start: string;
        period_end: string;
        status: string;
        net_salary: string;
        base_salary: string;
        bale_earnings: string;
        deductions: string;
        present_days: string | null;
        absent_days: string | null;
      }>(sql`
        SELECT fw.name AS worker_name,
          fp.period_start, fp.period_end, fp.status,
          CAST(fp.net_salary AS numeric) AS net_salary,
          CAST(fp.base_salary AS numeric) AS base_salary,
          CAST(fp.bale_earnings AS numeric) AS bale_earnings,
          CAST(fp.deductions AS numeric) AS deductions,
          fp.present_days, fp.absent_days
        FROM factory_payrolls fp
        JOIN factory_workers fw ON fw.id = fp.worker_id
        WHERE fp.company_id = ${companyId}
          AND fp.period_start >= ${dateFrom}
          AND fp.period_end <= ${dateTo}
        ORDER BY fp.period_start DESC, fw.name
        LIMIT ${rowLimit}
      `);
      let totalNet = 0,
        totalBase = 0,
        totalBale = 0,
        totalDed = 0;
      const tableRows2 = rows.rows.map((r) => {
        const net = parseFloat(r.net_salary || "0");
        totalNet += net;
        totalBase += parseFloat(r.base_salary || "0");
        totalBale += parseFloat(r.bale_earnings || "0");
        totalDed += parseFloat(r.deductions || "0");
        return [
          r.worker_name,
          String(r.period_start).slice(0, 10),
          String(r.period_end).slice(0, 10),
          fmt(parseFloat(r.base_salary || "0")),
          fmt(parseFloat(r.bale_earnings || "0")),
          fmt(parseFloat(r.deductions || "0")),
          fmt(net),
          r.status,
        ];
      });
      const stats2 = [
        { label: "Total Workers", value: String(tableRows2.length) },
        { label: "Total Base Salary", value: fmt(totalBase) },
        { label: "Total Bale Earnings", value: fmt(totalBale) },
        { label: "Total Deductions", value: fmt(totalDed) },
        { label: "Total Net Payroll", value: fmt(totalNet), highlight: "positive" },
      ];
      dataQueryResult = {
        queryType: "payroll_summary",
        title: "Factory Payroll Summary",
        subtitle: `${dateFrom} → ${dateTo}`,
        stats: stats2,
        table: {
          headers: ["Worker", "Period From", "Period To", "Base", "Bale Earn.", "Deductions", "Net", "Status"],
          rows: tableRows2,
        },
        noData: tableRows2.length === 0,
      };
      break;
    }

    default:
      return undefined;
  }

  return dataQueryResult;
}

export const phase2ReportShard: ReportImplementationShard = {
  name: "phase-2",
  queryTypes: phase2QueryTypes,
  run: runPhase2Report,
};
