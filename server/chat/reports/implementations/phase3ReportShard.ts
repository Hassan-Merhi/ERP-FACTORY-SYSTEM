import { db, sql, accountTypesOfClassSql } from "./reportShardSupport";
import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import { notFiscalClosingVoucher } from "../../../services/accounting/balances/periodReportRules";

export const phase3QueryTypes = [
  "sales_analysis",
  "top_selling_items",
  "container_profitability",
  "stock_valuation",
  "expense_breakdown",
  "customer_order_status",
  "credit_notes_summary",
  "bank_transactions",
  "fixed_assets_summary",
  "factory_kpi",
] as const;

async function runPhase3Report(ctx: DataQueryContext): Promise<DataQueryResult> {
  const { companyId, params, dateFrom, dateTo, todayStr, rowLimit, fmt, fmtDec } = ctx;
  let dataQueryResult: DataQueryResult;

  switch (params.queryType) {
    case "sales_analysis": {
      const itemNameFilter = params.entityName;
      const rows = await db.execute<{
        item_name: string;
        code: string;
        uom: string;
        tx_count: string;
        total_qty: string;
        total_revenue: string;
        total_cost: string;
        total_profit: string;
      }>(sql`
        SELECT si.name AS item_name, si.code, si.uom,
          COUNT(sal.id) AS tx_count,
          SUM(CAST(sal.quantity AS numeric)) AS total_qty,
          SUM(CAST(sal.total_sales AS numeric)) AS total_revenue,
          SUM(CAST(sal.total_cost AS numeric)) AS total_cost,
          SUM(CAST(sal.profit AS numeric)) AS total_profit
        FROM sales_items sal
        JOIN stock_items si ON si.id = sal.stock_item_id
        JOIN vouchers v ON v.id = sal.voucher_id AND v.deleted_at IS NULL
        WHERE si.company_id = ${companyId}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
          ${itemNameFilter ? sql`AND si.name ILIKE ${"%" + itemNameFilter + "%"}` : sql``}
        GROUP BY si.id, si.name, si.code, si.uom
        ORDER BY total_revenue DESC
        LIMIT ${rowLimit}
      `);
      let totRev = 0,
        totCost = 0,
        totProfit = 0,
        totQty = 0;
      const tableRows2 = rows.rows.map((r) => {
        const rev = parseFloat(r.total_revenue || "0");
        const cost = parseFloat(r.total_cost || "0");
        const profit3 = parseFloat(r.total_profit || "0");
        const qty = parseFloat(r.total_qty || "0");
        const margin = rev > 0 ? ((profit3 / rev) * 100).toFixed(1) + "%" : "—";
        totRev += rev;
        totCost += cost;
        totProfit += profit3;
        totQty += qty;
        return [r.item_name, `${fmtDec(qty)} ${r.uom}`, fmt(rev), fmt(cost), fmt(profit3), margin];
      });
      if (tableRows2.length) {
        const totMargin = totRev > 0 ? ((totProfit / totRev) * 100).toFixed(1) + "%" : "—";
        tableRows2.push(["TOTAL", fmtDec(totQty), fmt(totRev), fmt(totCost), fmt(totProfit), totMargin]);
      }
      dataQueryResult = {
        queryType: "sales_analysis",
        title: itemNameFilter ? `Sales Analysis: ${itemNameFilter}` : "Sales Analysis by Item",
        subtitle: `${dateFrom} → ${dateTo}`,
        table: { headers: ["Item", "Qty Sold", "Revenue", "Cost", "Profit", "Margin"], rows: tableRows2 },
        noData: tableRows2.length === 0,
      };
      break;
    }

    case "top_selling_items": {
      const rows = await db.execute<{
        item_name: string;
        code: string;
        uom: string;
        total_qty: string;
        total_revenue: string;
        total_profit: string;
        num_transactions: string;
      }>(sql`
        SELECT si.name AS item_name, si.code, si.uom,
          SUM(CAST(sal.quantity AS numeric)) AS total_qty,
          SUM(CAST(sal.total_sales AS numeric)) AS total_revenue,
          SUM(CAST(sal.profit AS numeric)) AS total_profit,
          COUNT(DISTINCT v.id) AS num_transactions
        FROM sales_items sal
        JOIN stock_items si ON si.id = sal.stock_item_id
        JOIN vouchers v ON v.id = sal.voucher_id AND v.deleted_at IS NULL
        WHERE si.company_id = ${companyId}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY si.id, si.name, si.code, si.uom
        ORDER BY total_revenue DESC
        LIMIT ${rowLimit}
      `);
      const tableRows2 = rows.rows.map((r, i) => [
        String(i + 1),
        r.item_name,
        r.code,
        `${fmtDec(parseFloat(r.total_qty || "0"))} ${r.uom}`,
        fmt(parseFloat(r.total_revenue || "0")),
        fmt(parseFloat(r.total_profit || "0")),
        String(r.num_transactions),
      ]);
      dataQueryResult = {
        queryType: "top_selling_items",
        title: "Top Selling Items",
        subtitle: `${dateFrom} → ${dateTo} · by revenue`,
        table: {
          headers: ["#", "Item", "Code", "Qty Sold", "Revenue", "Profit", "Transactions"],
          rows: tableRows2,
        },
        noData: tableRows2.length === 0,
      };
      break;
    }

    case "container_profitability": {
      const rows = await db.execute<{
        container_number: string;
        supplier: string | null;
        customer: string | null;
        currency: string;
        cost: string;
        sale_amount: string | null;
        commission: string | null;
        payment_status: string | null;
        import_date: string | null;
      }>(sql`
        SELECT c.container_number,
          s.legal_name AS supplier,
          cu.legal_name AS customer,
          c.currency,
          CAST(c.grand_total AS numeric) AS cost,
          CAST(cs.total_amount AS numeric) AS sale_amount,
          CAST(cs.commission AS numeric) AS commission,
          cs.payment_status,
          c.import_date
        FROM container_sales cs
        JOIN containers c ON c.id = cs.container_id
        JOIN suppliers s ON s.id = c.supplier_id
        JOIN customers cu ON cu.id = cs.customer_id
        WHERE c.company_id = ${companyId}
          AND CAST(cs.sale_date AS text) BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY cs.sale_date DESC
        LIMIT ${rowLimit}
      `);
      let totCost = 0,
        totSale = 0,
        totProfit = 0;
      const tableRows2 = rows.rows.map((r) => {
        const cost = parseFloat(r.cost || "0");
        const sale = parseFloat(r.sale_amount || "0");
        const comm = parseFloat(r.commission || "0");
        const profit3 = sale - cost - comm;
        const margin = sale > 0 ? ((profit3 / sale) * 100).toFixed(1) + "%" : "—";
        totCost += cost;
        totSale += sale;
        totProfit += profit3;
        return [
          r.container_number,
          r.supplier,
          r.customer,
          r.currency,
          fmt(cost),
          fmt(sale),
          fmt(comm),
          fmt(profit3),
          margin,
          r.payment_status,
        ];
      });
      if (tableRows2.length) {
        const totMargin = totSale > 0 ? ((totProfit / totSale) * 100).toFixed(1) + "%" : "—";
        tableRows2.push(["TOTAL", "", "", "", fmt(totCost), fmt(totSale), "", fmt(totProfit), totMargin, ""]);
      }
      dataQueryResult = {
        queryType: "container_profitability",
        title: "Container Profitability",
        subtitle: `${dateFrom} → ${dateTo}`,
        table: {
          headers: [
            "Container #",
            "Supplier",
            "Customer",
            "Curr.",
            "Cost",
            "Sale",
            "Comm.",
            "Profit",
            "Margin",
            "Payment",
          ],
          rows: tableRows2,
        },
        noData: tableRows2.length === 0,
      };
      break;
    }

    case "stock_valuation": {
      const rows = await db.execute<{
        group_name: string;
        item_count: string;
        total_qty: string | null;
        total_value: string | null;
      }>(sql`
        SELECT COALESCE(sg.name, 'Ungrouped') AS group_name,
          COUNT(DISTINCT si.id) AS item_count,
          SUM(CAST(inv.quantity AS numeric)) AS total_qty,
          SUM(CAST(inv.total_value AS numeric)) AS total_value
        FROM inventory inv
        JOIN stock_items si ON si.id = inv.stock_item_id AND si.deleted_at IS NULL
        LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id
        WHERE inv.company_id = ${companyId} AND inv.quantity > 0
        GROUP BY sg.id, sg.name
        ORDER BY total_value DESC
        LIMIT ${rowLimit}
      `);
      let grandTotalValue = 0,
        grandTotalItems = 0;
      const tableRows2 = rows.rows.map((r) => {
        const val = parseFloat(r.total_value || "0");
        grandTotalValue += val;
        grandTotalItems += parseInt(r.item_count || "0");
        return [r.group_name, String(r.item_count), fmtDec(parseFloat(r.total_qty || "0")), fmt(val)];
      });
      tableRows2.push(["GRAND TOTAL", String(grandTotalItems), "—", fmt(grandTotalValue)]);
      const stats3 = [
        { label: "Total Stock Groups", value: String(tableRows2.length - 1) },
        { label: "Total Distinct Items", value: String(grandTotalItems) },
        { label: "Total Inventory Value", value: fmt(grandTotalValue), highlight: "positive" },
      ];
      dataQueryResult = {
        queryType: "stock_valuation",
        title: "Stock Valuation by Group",
        subtitle: `As of ${todayStr}`,
        stats: stats3,
        table: { headers: ["Stock Group", "Items", "Total Qty", "Total Value"], rows: tableRows2 },
        noData: tableRows2.length <= 1,
      };
      break;
    }

    case "expense_breakdown": {
      const rows = await db.execute<{ name: string; account_type: string; net_spend: string | null }>(sql`
        SELECT la.name, la.account_type,
          SUM(CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric)) AS net_spend
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL AND v.optional = false
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE la.company_id = ${companyId}
          AND v.company_id = ${companyId}
          AND ${notFiscalClosingVoucher("v")}
          AND LOWER(TRIM(la.account_type)) IN (${accountTypesOfClassSql("expense")})
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY la.id, la.name, la.account_type
        HAVING SUM(CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric)) > 0
        ORDER BY net_spend DESC
        LIMIT ${rowLimit}
      `);
      let grandSpend = 0;
      const tableRows2 = rows.rows.map((r) => {
        const spend = parseFloat(r.net_spend || "0");
        grandSpend += spend;
        return [r.name, r.account_type, fmt(spend)];
      });
      if (tableRows2.length) tableRows2.push(["TOTAL", "", fmt(grandSpend)]);
      dataQueryResult = {
        queryType: "expense_breakdown",
        title: "Expense Breakdown",
        subtitle: `${dateFrom} → ${dateTo} · top ${tableRows2.length - 1} accounts`,
        table: { headers: ["Account", "Type", "Amount"], rows: tableRows2 },
        noData: tableRows2.length === 0,
      };
      break;
    }

    case "customer_order_status": {
      const statusFilter = (params.entityName || "").toUpperCase() || null;
      const rows = await db.execute<{
        invoice_number: string | null;
        customer: string | null;
        order_date: string | null;
        status: string;
        grand_total: string;
        total_qty_bales: number | null;
        destination: string | null;
        container_number: string | null;
      }>(sql`
        SELECT co.invoice_number, cu.legal_name AS customer,
          co.order_date, co.status,
          CAST(co.grand_total AS numeric) AS grand_total,
          co.total_qty_bales, co.destination, co.container_number
        FROM customer_orders co
        JOIN customers cu ON cu.id = co.customer_id
        WHERE co.company_id = ${companyId}
          AND co.deleted_at IS NULL
          ${statusFilter ? sql`AND co.status = ${statusFilter}` : sql``}
          AND co.order_date BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY co.order_date DESC
        LIMIT ${rowLimit}
      `);
      const tableRows2 = rows.rows.map((r) => [
        r.invoice_number || "—",
        r.customer,
        String(r.order_date).slice(0, 10),
        r.status,
        fmt(parseFloat(r.grand_total || "0")),
        String(r.total_qty_bales || 0),
        r.destination || "—",
      ]);
      dataQueryResult = {
        queryType: "customer_order_status",
        title: statusFilter ? `Customer Orders — ${statusFilter}` : "Customer Orders",
        subtitle: `${dateFrom} → ${dateTo} · ${tableRows2.length} order(s)`,
        table: {
          headers: ["Invoice", "Customer", "Date", "Status", "Total", "Bales", "Destination"],
          rows: tableRows2,
        },
        noData: tableRows2.length === 0,
      };
      break;
    }

    case "credit_notes_summary": {
      const rows = await db.execute<{
        voucher_date: string;
        description: string | null;
        item_name: string;
        uom: string;
        location: string;
        qty: string;
        rate: string;
        total_value: string;
      }>(sql`
        SELECT v.voucher_date, v.description,
          si.name AS item_name, si.uom,
          l.name AS location,
          CAST(cni.quantity AS numeric) AS qty,
          CAST(cni.rate AS numeric) AS rate,
          CAST(cni.total_value AS numeric) AS total_value
        FROM credit_note_items cni
        JOIN vouchers v ON v.id = cni.voucher_id AND v.deleted_at IS NULL
        JOIN stock_items si ON si.id = cni.stock_item_id
        JOIN locations l ON l.id = cni.location_id
        WHERE si.company_id = ${companyId}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY v.voucher_date DESC
        LIMIT ${rowLimit}
      `);
      let totValue = 0;
      const tableRows2 = rows.rows.map((r) => {
        const val = parseFloat(r.total_value || "0");
        totValue += val;
        return [
          String(r.voucher_date).slice(0, 10),
          r.item_name,
          r.location,
          `${fmtDec(parseFloat(r.qty))} ${r.uom}`,
          fmtDec(parseFloat(r.rate)),
          fmt(val),
          (r.description || "").slice(0, 35),
        ];
      });
      dataQueryResult = {
        queryType: "credit_notes_summary",
        title: "Credit Notes",
        subtitle: `${dateFrom} → ${dateTo} · Total returned: ${fmt(totValue)}`,
        table: {
          headers: ["Date", "Item", "Location", "Qty", "Rate", "Value", "Description"],
          rows: tableRows2,
        },
        noData: tableRows2.length === 0,
      };
      break;
    }

    case "bank_transactions": {
      const accountName = params.entityName || params.locationName;
      const acctRows = await db.execute<{ id: number; name: string; account_type: string }>(sql`
        SELECT id, name, account_type FROM ledger_accounts
        WHERE company_id = ${companyId} AND LOWER(TRIM(account_type)) IN ('bank', 'cash') AND deleted_at IS NULL
          ${accountName ? sql`AND name ILIKE ${"%" + accountName + "%"}` : sql``}
        ORDER BY account_type, name
        LIMIT 1
      `);
      if (!acctRows.rows.length) {
        dataQueryResult = {
          queryType: "bank_transactions",
          title: "Bank/Cash Transactions",
          summary: accountName ? `No account found matching "${accountName}".` : "Please specify an account name.",
        };
        break;
      }
      const acct3 = acctRows.rows[0];
      const txRows3 = await db.execute<{
        voucher_date: string;
        voucher_type: string;
        description: string | null;
        debit: string;
        credit: string;
      }>(sql`
        SELECT v.voucher_date, v.voucher_type, v.description,
          CAST(ve.debit_amount AS numeric) AS debit,
          CAST(ve.credit_amount AS numeric) AS credit
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL AND v.optional = false
        WHERE ve.ledger_account_id = ${acct3.id}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY v.voucher_date DESC, v.id DESC
        LIMIT ${rowLimit}
      `);
      const tableRows2 = txRows3.rows.map((r) => [
        String(r.voucher_date).slice(0, 10),
        r.voucher_type || "—",
        (r.description || "").slice(0, 40),
        parseFloat(r.debit || "0") > 0 ? fmt(parseFloat(r.debit)) : "—",
        parseFloat(r.credit || "0") > 0 ? fmt(parseFloat(r.credit)) : "—",
      ]);
      dataQueryResult = {
        queryType: "bank_transactions",
        title: `Transactions: ${acct3.name}`,
        subtitle: `${dateFrom} → ${dateTo} · ${acct3.account_type} account`,
        table: { headers: ["Date", "Type", "Description", "In (Dr)", "Out (Cr)"], rows: tableRows2 },
        noData: tableRows2.length === 0,
      };
      break;
    }

    case "fixed_assets_summary": {
      const categoryFilter = params.entityName;
      const rows = await db.execute<{
        code: string;
        name: string;
        category: string | null;
        purchase_date: string | null;
        purchase_amount: string;
        depreciation_method: string | null;
        useful_life: number | null;
        active: boolean;
      }>(sql`
        SELECT fa.code, fa.name, fa.category,
          fa.purchase_date,
          CAST(fa.purchase_amount AS numeric) AS purchase_amount,
          fa.depreciation_method, fa.useful_life, fa.active
        FROM fixed_assets fa
        WHERE fa.company_id = ${companyId}
          ${categoryFilter ? sql`AND fa.category ILIKE ${"%" + categoryFilter + "%"}` : sql``}
        ORDER BY fa.category, fa.purchase_date DESC
        LIMIT ${rowLimit}
      `);
      let grandTotal = 0;
      const tableRows2 = rows.rows.map((r) => {
        const amt = parseFloat(r.purchase_amount || "0");
        grandTotal += amt;
        return [
          r.code,
          r.name,
          r.category,
          String(r.purchase_date).slice(0, 10),
          fmt(amt),
          r.depreciation_method,
          r.useful_life ? `${r.useful_life} yr` : "—",
          r.active ? "Active" : "Inactive",
        ];
      });
      const stats3 = [
        { label: "Total Assets", value: String(tableRows2.length) },
        { label: "Total Purchase Value", value: fmt(grandTotal), highlight: "positive" },
      ];
      dataQueryResult = {
        queryType: "fixed_assets_summary",
        title: categoryFilter ? `Fixed Assets — ${categoryFilter}` : "Fixed Assets Register",
        subtitle: `${tableRows2.length} asset(s)`,
        stats: stats3,
        table: {
          headers: ["Code", "Name", "Category", "Purchase Date", "Amount", "Depreciation", "Life", "Status"],
          rows: tableRows2,
        },
        noData: tableRows2.length === 0,
      };
      break;
    }

    case "factory_kpi": {
      const rows = await db.execute<{
        date: string;
        kg_in: string | null;
        kg_pressed: string | null;
        total_bales_produced: number | null;
        waste_kg: string | null;
      }>(sql`
        SELECT date,
          CAST(total_kg_in AS numeric) AS kg_in,
          CAST(total_kg_pressed AS numeric) AS kg_pressed,
          total_bales_produced,
          CAST(total_waste_kg AS numeric) AS waste_kg
        FROM factory_daily_kpi_snapshots
        WHERE company_id = ${companyId}
          AND date BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY date DESC
        LIMIT ${rowLimit}
      `);
      let totKgIn = 0,
        totKgPressed = 0,
        totBales = 0,
        totWaste = 0;
      const tableRows2 = rows.rows.map((r) => {
        const kgIn = parseFloat(r.kg_in || "0");
        const kgPressed = parseFloat(r.kg_pressed || "0");
        const bales = r.total_bales_produced ?? 0;
        const waste = parseFloat(r.waste_kg || "0");
        const efficiency = kgIn > 0 ? ((kgPressed / kgIn) * 100).toFixed(1) + "%" : "—";
        totKgIn += kgIn;
        totKgPressed += kgPressed;
        totBales += bales;
        totWaste += waste;
        return [String(r.date).slice(0, 10), fmtDec(kgIn), fmtDec(kgPressed), String(bales), fmtDec(waste), efficiency];
      });
      const avgEff = totKgIn > 0 ? ((totKgPressed / totKgIn) * 100).toFixed(1) + "%" : "—";
      if (tableRows2.length)
        tableRows2.push(["TOTAL", fmtDec(totKgIn), fmtDec(totKgPressed), String(totBales), fmtDec(totWaste), avgEff]);
      const stats3 = [
        { label: "Total Kg In", value: fmtDec(totKgIn) },
        { label: "Total Kg Pressed", value: fmtDec(totKgPressed) },
        { label: "Total Bales", value: String(totBales) },
        { label: "Total Waste Kg", value: fmtDec(totWaste) },
        { label: "Avg Efficiency", value: avgEff, highlight: "positive" },
      ];
      dataQueryResult = {
        queryType: "factory_kpi",
        title: "Factory Daily KPIs",
        subtitle: `${dateFrom} → ${dateTo}`,
        stats: stats3,
        table: {
          headers: ["Date", "Kg In", "Kg Pressed", "Bales", "Waste Kg", "Efficiency"],
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

export const phase3ReportShard: ReportImplementationShard = {
  name: "phase-3",
  queryTypes: phase3QueryTypes,
  run: runPhase3Report,
};
