import { db, sql } from "./reportShardSupport";
import type { DataQueryContext, DataQueryResult } from "../types";

const overrideQueryTypes = new Set([
  "container_list",
  "payroll_summary",
  "container_profitability",
  "worker_productivity",
  "upcoming_arrivals",
  "container_cost_breakdown",
  "stock_item_detail",
  "supplier_container_history",
]);

export function hasSchemaCompatibleReportOverride(queryType: string): boolean {
  return overrideQueryTypes.has(queryType);
}

export async function runSchemaCompatibleReportOverride(ctx: DataQueryContext): Promise<DataQueryResult> {
  const { companyId, params, dateFrom, dateTo, todayDate, rowLimit, fmt, fmtDec } = ctx;

  switch (params.queryType) {
    case "container_list": {
      const statusFilter = params.containerStatus;
      const rows = await db.execute<{
        container_number: string;
        status: string;
        import_date: string | null;
        eta: string | null;
        supplier: string;
        grand_total: string;
        transporter: string | null;
      }>(sql`
        SELECT c.container_number, c.status, c.import_date, c.eta,
          s.legal_name AS supplier,
          CAST(c.grand_total AS numeric) AS grand_total,
          c.transporter
        FROM containers c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.company_id = ${companyId}
          ${statusFilter ? sql`AND c.status ILIKE ${"%" + statusFilter + "%"}` : sql``}
          AND c.import_date BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY c.import_date DESC
        LIMIT ${rowLimit}
      `);
      const tableRows = rows.rows.map((r) => [
        r.container_number,
        r.status,
        String(r.import_date).slice(0, 10),
        r.eta ? String(r.eta).slice(0, 10) : "—",
        r.supplier,
        r.transporter || "—",
        fmtDec(parseFloat(r.grand_total || "0")),
      ]);
      return {
        queryType: "container_list",
        title: statusFilter ? `Containers — ${statusFilter}` : "Container List",
        subtitle: `${dateFrom} → ${dateTo} · ${tableRows.length} container(s)`,
        table: {
          headers: ["Container #", "Status", "Import Date", "ETA", "Supplier", "Transporter", "Grand Total"],
          rows: tableRows,
        },
        noData: tableRows.length === 0,
      };
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
      }>(sql`
        SELECT fw.full_name AS worker_name,
          fp.period_start, fp.period_end, fp.status,
          CAST(fp.net_salary AS numeric) AS net_salary,
          CAST(fp.base_salary AS numeric) AS base_salary,
          CAST(fp.bale_earnings AS numeric) AS bale_earnings,
          CAST(fp.deductions AS numeric) AS deductions
        FROM factory_payrolls fp
        JOIN factory_workers fw ON fw.id = fp.worker_id
        WHERE fp.company_id = ${companyId}
          AND fp.period_start >= ${dateFrom}
          AND fp.period_end <= ${dateTo}
        ORDER BY fp.period_start DESC, fw.full_name
        LIMIT ${rowLimit}
      `);
      let totalNet = 0;
      let totalBase = 0;
      let totalBale = 0;
      let totalDed = 0;
      const tableRows = rows.rows.map((r) => {
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
      return {
        queryType: "payroll_summary",
        title: "Factory Payroll Summary",
        subtitle: `${dateFrom} → ${dateTo}`,
        stats: [
          { label: "Total Workers", value: String(tableRows.length) },
          { label: "Total Base Salary", value: fmt(totalBase) },
          { label: "Total Bale Earnings", value: fmt(totalBale) },
          { label: "Total Deductions", value: fmt(totalDed) },
          { label: "Total Net Payroll", value: fmt(totalNet), highlight: "positive" },
        ],
        table: {
          headers: ["Worker", "Period From", "Period To", "Base", "Bale Earn.", "Deductions", "Net", "Status"],
          rows: tableRows,
        },
        noData: tableRows.length === 0,
      };
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
      }>(sql`
        SELECT c.container_number,
          s.legal_name AS supplier,
          cu.legal_name AS customer,
          cs.currency,
          CAST(c.grand_total AS numeric) AS cost,
          CAST(cs.total_amount AS numeric) AS sale_amount,
          CAST(cs.commission AS numeric) AS commission,
          cs.payment_status
        FROM container_sales cs
        JOIN containers c ON c.id = cs.container_id
        JOIN suppliers s ON s.id = c.supplier_id
        JOIN customers cu ON cu.id = cs.customer_id
        WHERE c.company_id = ${companyId}
          AND CAST(cs.sale_date AS text) BETWEEN ${dateFrom} AND ${dateTo}
        ORDER BY cs.sale_date DESC
        LIMIT ${rowLimit}
      `);
      let totalCost = 0;
      let totalSale = 0;
      let totalProfit = 0;
      const tableRows = rows.rows.map((r) => {
        const cost = parseFloat(r.cost || "0");
        const sale = parseFloat(r.sale_amount || "0");
        const commission = parseFloat(r.commission || "0");
        const profit = sale - cost - commission;
        totalCost += cost;
        totalSale += sale;
        totalProfit += profit;
        return [
          r.container_number,
          r.supplier,
          r.customer,
          r.currency,
          fmt(cost),
          fmt(sale),
          fmt(commission),
          fmt(profit),
          sale > 0 ? `${((profit / sale) * 100).toFixed(1)}%` : "—",
          r.payment_status,
        ];
      });
      if (tableRows.length) {
        tableRows.push([
          "TOTAL",
          "",
          "",
          "",
          fmt(totalCost),
          fmt(totalSale),
          "",
          fmt(totalProfit),
          totalSale > 0 ? `${((totalProfit / totalSale) * 100).toFixed(1)}%` : "—",
          "",
        ]);
      }
      return {
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
          rows: tableRows,
        },
        noData: tableRows.length === 0,
      };
    }

    case "worker_productivity": {
      const rows = await db.execute<{
        full_name: string;
        total_bales: string;
        total_kg: string;
        avg_kg_per_bale: string;
      }>(sql`
        SELECT COALESCE(fw.full_name, fba.worker_name_snapshot, fb.worker_name, 'Unassigned') AS full_name,
          COUNT(fb.id) AS total_bales,
          COALESCE(SUM(CAST(fb.weight_kg AS numeric)), 0) AS total_kg,
          COALESCE(AVG(CAST(fb.weight_kg AS numeric)), 0) AS avg_kg_per_bale
        FROM factory_bales fb
        LEFT JOIN factory_bale_production_attributions fba
          ON fba.bale_id = fb.id AND fba.company_id = fb.company_id
        LEFT JOIN factory_workers fw ON fw.id = fba.worker_id
        WHERE fb.company_id = ${companyId}
          AND fb.deleted_at IS NULL
          AND COALESCE(fba.stock_entry_date, fb.stock_entry_date, CAST(fb.pressed_at AS date)) BETWEEN ${dateFrom} AND ${dateTo}
        GROUP BY COALESCE(fw.full_name, fba.worker_name_snapshot, fb.worker_name, 'Unassigned')
        ORDER BY total_bales DESC
        LIMIT ${rowLimit}
      `);
      const tableRows = rows.rows.map((r, index) => [
        String(index + 1),
        r.full_name,
        String(r.total_bales),
        fmtDec(parseFloat(r.total_kg || "0")),
        fmtDec(parseFloat(r.avg_kg_per_bale || "0")),
      ]);
      return {
        queryType: "worker_productivity",
        title: "Worker Productivity Ranking",
        subtitle: `${dateFrom} → ${dateTo} · by bales produced`,
        table: { headers: ["Rank", "Worker", "Bales", "Total Kg", "Avg Kg/Bale"], rows: tableRows },
        noData: tableRows.length === 0,
      };
    }

    case "upcoming_arrivals": {
      const futureDate = new Date(todayDate.getTime() + 30 * 86400000).toISOString().slice(0, 10);
      const rows = await db.execute<{
        container_number: string;
        status: string;
        eta: string | null;
        supplier: string | null;
        transporter: string | null;
        tracking_location: string | null;
        days_until_eta: number | null;
      }>(sql`
        SELECT c.container_number, c.status, c.eta,
          s.legal_name AS supplier,
          c.transporter, c.tracking_location,
          CAST(c.eta AS date) - CURRENT_DATE AS days_until_eta
        FROM containers c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.company_id = ${companyId}
          AND c.status NOT IN ('Offloaded', 'Arrived')
          AND c.eta IS NOT NULL
          AND CAST(c.eta AS date) <= ${futureDate}
        ORDER BY c.eta ASC
        LIMIT ${rowLimit}
      `);
      const tableRows = rows.rows.map((r) => {
        const days = r.days_until_eta ?? 0;
        return [
          r.container_number,
          r.status,
          String(r.eta).slice(0, 10),
          days <= 0 ? "TODAY/OVERDUE" : `${days}d`,
          r.supplier,
          r.transporter || "—",
          r.tracking_location || "—",
        ];
      });
      return {
        queryType: "upcoming_arrivals",
        title: "Upcoming Container Arrivals",
        subtitle: `Next 30 days · ${tableRows.length} container(s) expected`,
        table: {
          headers: ["Container #", "Status", "ETA", "Days Away", "Supplier", "Transporter", "Last Location"],
          rows: tableRows,
        },
        noData: tableRows.length === 0,
      };
    }

    case "container_cost_breakdown": {
      const containerFilter = params.containerNumber || params.entityName;
      if (!containerFilter) {
        return {
          queryType: "container_cost_breakdown",
          title: "Container Cost Breakdown",
          summary: "Please specify a container number.",
        };
      }
      const containerRows = await db.execute<{
        id: number;
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
        SELECT c.id, c.container_number, c.status, c.import_date,
          COALESCE(
            (SELECT po.currency FROM purchase_orders po WHERE po.container_id = c.id ORDER BY po.id DESC LIMIT 1),
            'USD'
          ) AS currency,
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
          AND c.container_number ILIKE ${"%" + containerFilter + "%"}
        ORDER BY c.import_date DESC
        LIMIT 1
      `);
      if (!containerRows.rows.length) {
        return {
          queryType: "container_cost_breakdown",
          title: "Container Cost Breakdown",
          summary: `No container found matching "${containerFilter}".`,
        };
      }
      const container = containerRows.rows[0];
      const poRows = await db.execute<{
        po_number: string;
        currency: string;
        freight: string;
        surcharge: string;
        fumigation: string;
        doc_charges: string;
        discount: string;
      }>(sql`
        SELECT po.po_number, po.currency,
          CAST(po.freight AS numeric) AS freight,
          CAST(po.surcharge AS numeric) AS surcharge,
          CAST(po.fumigation AS numeric) AS fumigation,
          CAST(po.document_charges AS numeric) AS doc_charges,
          CAST(po.discount AS numeric) AS discount
        FROM purchase_orders po
        WHERE po.container_id = ${container.id}
        ORDER BY po.id
        LIMIT 10
      `);
      const breakdownRows: string[][] = [
        ["Items Total", container.currency, fmt(parseFloat(container.items_total || "0"))],
        ["Charges Total", container.currency, fmt(parseFloat(container.charges_total || "0"))],
      ];
      if (parseFloat(container.transport_fee || "0") > 0) {
        breakdownRows.push(["Transport Fee", container.currency, fmt(parseFloat(container.transport_fee || "0"))]);
      }
      if (parseFloat(container.duty_fee || "0") > 0) {
        breakdownRows.push(["Duty Fee", container.currency, fmt(parseFloat(container.duty_fee || "0"))]);
      }
      for (const po of poRows.rows) {
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
      breakdownRows.push(["GRAND TOTAL", container.currency, fmt(parseFloat(container.grand_total || "0"))]);
      return {
        queryType: "container_cost_breakdown",
        title: `Cost Breakdown: ${container.container_number}`,
        subtitle: container.transporter
          ? `Transporter: ${container.transporter}${container.agent ? ` · Agent: ${container.agent}` : ""}`
          : "",
        stats: [
          { label: "Supplier", value: container.supplier },
          { label: "Status", value: container.status },
          { label: "Import Date", value: String(container.import_date).slice(0, 10) },
          { label: "Total Kg", value: fmtDec(parseFloat(container.total_kg || "0")) },
          { label: "Rate/Kg", value: fmtDec(parseFloat(container.rate_per_kg || "0")) },
          { label: "Grand Total", value: fmt(parseFloat(container.grand_total || "0")), highlight: "positive" },
        ],
        table: { headers: ["Component", "Currency", "Amount"], rows: breakdownRows },
        noData: false,
      };
    }

    case "stock_item_detail": {
      const itemName = params.entityName;
      if (!itemName) {
        return { queryType: "stock_item_detail", title: "Stock Item Detail", summary: "Please specify an item name." };
      }
      const itemRows = await db.execute<{
        id: number;
        code: string;
        name: string;
        uom: string | null;
        selling_price: string | null;
        reorder_level: string | null;
        group_name: string | null;
      }>(sql`
        SELECT si.id, si.code, si.name, si.uom, si.selling_price, si.reorder_level,
          sg.name AS group_name
        FROM stock_items si
        LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id
        WHERE si.company_id = ${companyId}
          AND si.deleted_at IS NULL
          AND si.name ILIKE ${"%" + itemName + "%"}
        ORDER BY si.name
        LIMIT 1
      `);
      if (!itemRows.rows.length) {
        return {
          queryType: "stock_item_detail",
          title: "Stock Item Detail",
          summary: `No item found matching "${itemName}".`,
        };
      }
      const item = itemRows.rows[0];
      const inventoryRows = await db.execute<{
        location: string;
        qty: string;
        average_rate: string;
        total_value: string;
      }>(sql`
        SELECT l.name AS location,
          CAST(inv.quantity AS numeric) AS qty,
          CAST(inv.average_rate AS numeric) AS average_rate,
          CAST(inv.total_value AS numeric) AS total_value
        FROM inventory inv
        JOIN locations l ON l.id = inv.location_id
        WHERE inv.stock_item_id = ${item.id}
          AND inv.company_id = ${companyId}
          AND inv.quantity > 0
        ORDER BY inv.quantity DESC
      `);
      let totalQty = 0;
      let totalValue = 0;
      const tableRows = inventoryRows.rows.map((r) => {
        const qty = parseFloat(r.qty || "0");
        const value = parseFloat(r.total_value || "0");
        totalQty += qty;
        totalValue += value;
        return [r.location, fmtDec(qty), fmtDec(parseFloat(r.average_rate || "0")), fmt(value)];
      });
      return {
        queryType: "stock_item_detail",
        title: `Item: ${item.name}`,
        subtitle: `${tableRows.length} location(s) with stock`,
        stats: [
          { label: "Code", value: item.code },
          { label: "Group", value: item.group_name || "—" },
          { label: "UOM", value: item.uom },
          { label: "Selling Price", value: fmtDec(parseFloat(item.selling_price || "0")) },
          { label: "Reorder Level", value: `${fmtDec(parseFloat(item.reorder_level || "0"))} ${item.uom}` },
          {
            label: "Total Stock",
            value: `${fmtDec(totalQty)} ${item.uom}`,
            highlight: totalQty > 0 ? "positive" : "negative",
          },
          { label: "Total Value", value: fmt(totalValue), highlight: "positive" },
        ],
        table: { headers: ["Location", "Qty", "Avg Rate", "Value"], rows: tableRows },
        noData: tableRows.length === 0,
      };
    }

    case "supplier_container_history": {
      const supplierName = params.entityName;
      if (!supplierName) {
        return {
          queryType: "supplier_container_history",
          title: "Supplier Container History",
          summary: "Please specify a supplier name.",
        };
      }
      const rows = await db.execute<{
        container_number: string;
        status: string;
        import_date: string | null;
        eta: string | null;
        grand_total: string;
        currency: string;
        total_kg: string | null;
        item_name: string | null;
        supplier: string | null;
      }>(sql`
        SELECT c.container_number, c.status, c.import_date, c.eta,
          CAST(c.grand_total AS numeric) AS grand_total,
          COALESCE(
            (SELECT po.currency FROM purchase_orders po WHERE po.container_id = c.id ORDER BY po.id DESC LIMIT 1),
            'USD'
          ) AS currency,
          c.total_kg, c.item_name, s.legal_name AS supplier
        FROM containers c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.company_id = ${companyId}
          AND s.legal_name ILIKE ${"%" + supplierName + "%"}
        ORDER BY c.import_date DESC
        LIMIT ${rowLimit}
      `);
      let totalValue = 0;
      let totalKg = 0;
      const statusCounts: Record<string, number> = {};
      const tableRows = rows.rows.map((r) => {
        const value = parseFloat(r.grand_total || "0");
        const kg = parseFloat(r.total_kg || "0");
        totalValue += value;
        totalKg += kg;
        statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
        return [
          r.container_number,
          r.status,
          String(r.import_date).slice(0, 10),
          r.eta ? String(r.eta).slice(0, 10) : "—",
          fmtDec(kg),
          fmt(value),
          r.currency,
          (r.item_name || "—").slice(0, 25),
        ];
      });
      const supplier = rows.rows[0]?.supplier || supplierName;
      return {
        queryType: "supplier_container_history",
        title: `Containers from: ${supplier}`,
        subtitle: `${tableRows.length} container(s) · most recent first`,
        stats: [
          { label: "Supplier", value: supplier },
          { label: "Total Containers", value: String(tableRows.length) },
          { label: "Total Kg", value: fmtDec(totalKg) },
          { label: "Total Value", value: fmt(totalValue), highlight: "positive" },
          ...Object.entries(statusCounts).map(([status, count]) => ({ label: status, value: String(count) })),
        ],
        table: {
          headers: ["Container #", "Status", "Import Date", "ETA", "Total Kg", "Value", "Currency", "Item"],
          rows: tableRows,
        },
        noData: tableRows.length === 0,
      };
    }

    default:
      return undefined;
  }
}
