import { db, sql, accountTypesOfClassSql } from "./reportShardSupport";
import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import { notFiscalClosingVoucher } from "../../../services/accounting/balances/periodReportRules";

export const phase7QueryTypes = [
  "audit_trail",
  "bank_account_list",
  "stock_adjustments",
  "container_tracking",
  "pending_container_sales",
  "supplier_container_history",
  "income_breakdown",
  "factory_worker_profile",
  "location_list",
  "quarterly_comparison",
] as const;

async function runPhase7Report(ctx: DataQueryContext): Promise<DataQueryResult> {
  const { companyId, params, dateFrom, dateTo, todayStr, rowLimit, fmt, fmtDec } = ctx;
  let dataQueryResult: DataQueryResult;

  switch (params.queryType) {
    case "audit_trail": {
      const tableFilter7 = params.entityName;
      const rows = await db.execute<{
        username: string | null;
        action: string;
        table_name: string | null;
        record_identifier: string | null;
        created_at: Date;
      }>(sql`
        SELECT al.username, al.action, al.table_name, al.record_identifier,
          al.created_at
        FROM audit_log al
        WHERE al.company_id = ${companyId}
          AND al.created_at >= ${dateFrom}
          ${tableFilter7 ? sql`AND (al.table_name ILIKE ${"%" + tableFilter7 + "%"} OR al.record_identifier ILIKE ${"%" + tableFilter7 + "%"})` : sql``}
        ORDER BY al.created_at DESC
        LIMIT ${rowLimit}
      `);
      const actionMap: Record<string, number> = {};
      const tableRows7 = rows.rows.map((r) => {
        actionMap[r.action] = (actionMap[r.action] || 0) + 1;
        return [String(r.created_at).slice(0, 16), r.username, r.action, r.table_name, r.record_identifier || "—"];
      });
      const stats7 = [
        { label: "Total Events", value: String(tableRows7.length) },
        ...Object.entries(actionMap).map(([a, c]) => ({
          label: a.charAt(0).toUpperCase() + a.slice(1) + "s",
          value: String(c),
        })),
      ];
      dataQueryResult = {
        queryType: "audit_trail",
        title: tableFilter7 ? `Audit Trail: ${tableFilter7}` : "Audit Trail",
        subtitle: `Since ${dateFrom} · most recent first`,
        stats: stats7,
        table: { headers: ["Timestamp", "User", "Action", "Table", "Record"], rows: tableRows7 },
        noData: tableRows7.length === 0,
      };
      break;
    }

    case "bank_account_list": {
      const rows = await db.execute<{
        code: string;
        name: string;
        bank_name: string | null;
        account_number: string | null;
        opening_balance: string;
        opening_balance_side: string | null;
        active: boolean;
        total_dr: string;
        total_cr: string;
      }>(sql`
        SELECT ba.code, ba.name, ba.bank_name, ba.account_number,
          CAST(ba.opening_balance AS numeric) AS opening_balance,
          ba.opening_balance_side, ba.active,
          COALESCE(SUM(CAST(ve.debit_amount AS numeric)), 0) AS total_dr,
          COALESCE(SUM(CAST(ve.credit_amount AS numeric)), 0) AS total_cr
        FROM bank_accounts ba
        LEFT JOIN voucher_entries ve ON ve.ledger_account_id = ba.linked_ledger_id
        LEFT JOIN vouchers v ON v.id = ve.voucher_id
          AND v.deleted_at IS NULL AND v.optional = false
        WHERE ba.company_id = ${companyId}
          AND ba.deleted_at IS NULL
        GROUP BY ba.id, ba.code, ba.name, ba.bank_name, ba.account_number,
          ba.opening_balance, ba.opening_balance_side, ba.active
        ORDER BY ba.name
      `);
      let grandBalance = 0;
      const tableRows7 = rows.rows.map((r) => {
        const ob = parseFloat(r.opening_balance || "0") * (r.opening_balance_side === "Cr" ? -1 : 1);
        const dr = parseFloat(r.total_dr || "0");
        const cr = parseFloat(r.total_cr || "0");
        const balance = ob + dr - cr;
        grandBalance += balance;
        const balLabel = balance >= 0 ? fmt(balance) + " Dr" : fmt(Math.abs(balance)) + " Cr";
        return [r.code, r.name, r.bank_name, r.account_number, balLabel];
      });
      tableRows7.push([
        "",
        "TOTAL BALANCE",
        "",
        "",
        grandBalance >= 0 ? fmt(grandBalance) + " Dr" : fmt(Math.abs(grandBalance)) + " Cr",
      ]);
      const stats7 = [
        { label: "Bank Accounts", value: String(tableRows7.length - 1) },
        {
          label: "Net Balance",
          value: grandBalance >= 0 ? fmt(grandBalance) + " Dr" : fmt(Math.abs(grandBalance)) + " Cr",
          highlight: grandBalance >= 0 ? "positive" : "negative",
        },
      ];
      dataQueryResult = {
        queryType: "bank_account_list",
        title: "Bank Account Balances",
        subtitle: `As of ${todayStr}`,
        stats: stats7,
        table: { headers: ["Code", "Account Name", "Bank", "Account No.", "Balance"], rows: tableRows7 },
        noData: tableRows7.length <= 1,
      };
      break;
    }

    case "stock_adjustments": {
      const adjTypeFilter = params.entityName?.toLowerCase().includes("consum")
        ? "Consumption"
        : params.entityName?.toLowerCase().includes("prod")
          ? "Production"
          : null;
      const rows = await db.execute<{
        voucher_date: string;
        voucher_number: string;
        adjustment_type: string;
        location: string | null;
        item_name: string;
        code: string | null;
        uom: string | null;
        qty: string;
        rate: string;
        total_amount: string;
      }>(sql`
        SELECT v.voucher_date, v.voucher_number, sav.adjustment_type,
          l.name AS location, si.name AS item_name, si.code, si.uom,
          CAST(sai.quantity AS numeric) AS qty,
          CAST(sai.rate AS numeric) AS rate,
          CAST(sai.total_amount AS numeric) AS total_amount
        FROM stock_adjustment_items sai
        JOIN stock_adjustment_vouchers sav ON sav.id = sai.adjustment_id
        JOIN vouchers v ON v.id = sav.voucher_id AND v.deleted_at IS NULL
        JOIN stock_items si ON si.id = sai.stock_item_id
        JOIN locations l ON l.id = sav.location_id
        WHERE v.company_id = ${companyId}
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
          ${adjTypeFilter ? sql`AND sav.adjustment_type = ${adjTypeFilter}` : sql``}
        ORDER BY v.voucher_date DESC
        LIMIT ${rowLimit}
      `);
      let totalProd = 0,
        totalCons = 0;
      const tableRows7 = rows.rows.map((r) => {
        const qty = parseFloat(r.qty || "0");
        const amt = parseFloat(r.total_amount || "0");
        if (r.adjustment_type === "Production") totalProd += amt;
        else totalCons += amt;
        return [
          String(r.voucher_date).slice(0, 10),
          r.voucher_number,
          r.adjustment_type,
          r.location,
          r.item_name,
          `${fmtDec(Math.abs(qty))} ${r.uom}`,
          fmt(Math.abs(amt)),
        ];
      });
      const stats7 = [
        { label: "Total Entries", value: String(tableRows7.length) },
        { label: "Production Value", value: fmt(totalProd), highlight: "positive" },
        { label: "Consumption Value", value: fmt(totalCons) },
      ];
      dataQueryResult = {
        queryType: "stock_adjustments",
        title: adjTypeFilter ? `Stock Adjustments — ${adjTypeFilter}` : "Stock Adjustments",
        subtitle: `${dateFrom} → ${dateTo}`,
        stats: stats7,
        table: {
          headers: ["Date", "Voucher #", "Type", "Location", "Item", "Qty", "Amount"],
          rows: tableRows7,
        },
        noData: tableRows7.length === 0,
      };
      break;
    }

    case "container_tracking": {
      const cn7 = params.containerNumber || params.entityName;
      if (!cn7) {
        dataQueryResult = {
          queryType: "container_tracking",
          title: "Container Tracking",
          summary: "Please specify a container number.",
        };
        break;
      }
      const containerRow7 = await db.execute<{
        id: number;
        container_number: string;
        status: string;
        eta: string | null;
        transporter: string | null;
        tracking_last_location: string | null;
        tracking_last_description: string | null;
        tracking_changed_at: Date | null;
      }>(sql`
        SELECT c.id, c.container_number, c.status, c.eta, c.transporter,
          c.tracking_last_location, c.tracking_last_description, c.tracking_changed_at
        FROM containers c
        WHERE c.company_id = ${companyId}
          AND c.container_number ILIKE ${"%" + cn7 + "%"}
        LIMIT 1
      `);
      if (!containerRow7.rows.length) {
        dataQueryResult = {
          queryType: "container_tracking",
          title: "Container Tracking",
          summary: `No container found matching "${cn7}".`,
        };
        break;
      }
      const ctr7 = containerRow7.rows[0];
      const evtRows = await db.execute<{
        event_time: Date | null;
        event_status: string | null;
        event_location: string | null;
        event_description: string | null;
        provider: string | null;
      }>(sql`
        SELECT cte.event_time, cte.event_status, cte.event_location, cte.event_description, cte.provider
        FROM container_tracking_events cte
        WHERE cte.container_id = ${ctr7.id}
        ORDER BY cte.event_time DESC
        LIMIT ${rowLimit}
      `);
      const tableRows7 = evtRows.rows.map((r) => [
        r.event_time ? String(r.event_time).slice(0, 16) : "—",
        r.event_status || "—",
        r.event_location || "—",
        (r.event_description || "").slice(0, 50),
        r.provider,
      ]);
      const stats7 = [
        { label: "Container #", value: ctr7.container_number },
        { label: "Status", value: ctr7.status },
        { label: "ETA", value: ctr7.eta ? String(ctr7.eta).slice(0, 10) : "—" },
        { label: "Transporter", value: ctr7.transporter || "—" },
        { label: "Last Location", value: ctr7.tracking_last_location || "—" },
      ];
      dataQueryResult = {
        queryType: "container_tracking",
        title: `Tracking: ${ctr7.container_number}`,
        subtitle: ctr7.tracking_last_description
          ? `Latest: ${(ctr7.tracking_last_description as string).slice(0, 60)}`
          : `${tableRows7.length} event(s)`,
        stats: stats7,
        table: { headers: ["Time", "Status", "Location", "Description", "Provider"], rows: tableRows7 },
        noData: tableRows7.length === 0,
      };
      break;
    }

    case "pending_container_sales": {
      const rows = await db.execute<{
        sale_date: string;
        invoice_number: string | null;
        container_number: string | null;
        customer: string | null;
        currency: string;
        total_amount: string;
        paid_amount: string;
        outstanding: string;
        payment_status: string | null;
      }>(sql`
        SELECT cs.sale_date, cs.invoice_number, c.container_number,
          cu.legal_name AS customer, cs.currency,
          CAST(cs.total_amount AS numeric) AS total_amount,
          CAST(cs.paid_amount AS numeric) AS paid_amount,
          CAST(cs.total_amount AS numeric) - CAST(cs.paid_amount AS numeric) AS outstanding,
          cs.payment_status
        FROM container_sales cs
        JOIN containers c ON c.id = cs.container_id
        JOIN customers cu ON cu.id = cs.customer_id
        WHERE cs.company_id = ${companyId}
          AND cs.payment_status != 'PAID'
        ORDER BY cs.sale_date ASC
        LIMIT ${rowLimit}
      `);
      let totalOutstanding = 0;
      const tableRows7 = rows.rows.map((r) => {
        const outstanding = parseFloat(r.outstanding || "0");
        totalOutstanding += outstanding;
        return [
          String(r.sale_date).slice(0, 10),
          r.invoice_number || "—",
          r.container_number,
          r.customer,
          fmt(parseFloat(r.total_amount)),
          fmt(parseFloat(r.paid_amount)),
          fmt(outstanding),
          r.payment_status,
          r.currency,
        ];
      });
      const stats7 = [
        { label: "Pending Sales", value: String(tableRows7.length) },
        { label: "Total Outstanding", value: fmt(totalOutstanding), highlight: "negative" },
      ];
      dataQueryResult = {
        queryType: "pending_container_sales",
        title: "Pending Container Sales",
        subtitle: `${tableRows7.length} unpaid/partial container sale(s)`,
        stats: stats7,
        table: {
          headers: [
            "Sale Date",
            "Invoice #",
            "Container",
            "Customer",
            "Total",
            "Paid",
            "Outstanding",
            "Status",
            "Currency",
          ],
          rows: tableRows7,
        },
        noData: tableRows7.length === 0,
      };
      break;
    }

    case "supplier_container_history": {
      const suppName7 = params.entityName;
      if (!suppName7) {
        dataQueryResult = {
          queryType: "supplier_container_history",
          title: "Supplier Container History",
          summary: "Please specify a supplier name.",
        };
        break;
      }
      const rows = await db.execute<{
        container_number: string;
        status: string;
        import_date: string | null;
        eta: string | null;
        grand_total: string;
        currency: string;
        total_kg: string | null;
        rate_per_kg: string | null;
        item_name: string | null;
        supplier: string | null;
      }>(sql`
        SELECT c.container_number, c.status, c.import_date, c.eta,
          CAST(c.grand_total AS numeric) AS grand_total, c.currency,
          c.total_kg, c.rate_per_kg, c.item_name, s.legal_name AS supplier
        FROM containers c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.company_id = ${companyId}
          AND s.legal_name ILIKE ${"%" + suppName7 + "%"}
        ORDER BY c.import_date DESC
        LIMIT ${rowLimit}
      `);
      let totalValue = 0,
        totalKg = 0;
      const statusCounts: Record<string, number> = {};
      const tableRows7 = rows.rows.map((r) => {
        const val = parseFloat(r.grand_total || "0");
        const kg = parseFloat(r.total_kg || "0");
        totalValue += val;
        totalKg += kg;
        statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
        return [
          r.container_number,
          r.status,
          String(r.import_date).slice(0, 10),
          r.eta ? String(r.eta).slice(0, 10) : "—",
          fmtDec(kg),
          fmt(val),
          r.currency,
          (r.item_name || "—").slice(0, 25),
        ];
      });
      const supplier7 = (rows.rows[0] as { supplier: unknown })?.supplier || suppName7;
      const stats7 = [
        { label: "Supplier", value: supplier7 },
        { label: "Total Containers", value: String(tableRows7.length) },
        { label: "Total Kg", value: fmtDec(totalKg) },
        { label: "Total Value", value: fmt(totalValue), highlight: "positive" },
        ...Object.entries(statusCounts).map(([s, c]) => ({ label: s, value: String(c) })),
      ];
      dataQueryResult = {
        queryType: "supplier_container_history",
        title: `Containers from: ${supplier7}`,
        subtitle: `${tableRows7.length} container(s) · most recent first`,
        stats: stats7,
        table: {
          headers: ["Container #", "Status", "Import Date", "ETA", "Total Kg", "Value", "Currency", "Item"],
          rows: tableRows7,
        },
        noData: tableRows7.length === 0,
      };
      break;
    }

    case "income_breakdown": {
      const rows = await db.execute<{ name: string; account_type: string; net_income: string }>(sql`
        SELECT la.name, la.account_type,
          COALESCE(SUM(CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric)), 0) AS net_income
        FROM ledger_accounts la
        JOIN voucher_entries ve ON ve.ledger_account_id = la.id
        JOIN vouchers v ON v.id = ve.voucher_id
          AND v.deleted_at IS NULL AND v.optional = false
          AND CAST(COALESCE(v.effective_date, v.voucher_date) AS text) BETWEEN ${dateFrom} AND ${dateTo}
          AND v.company_id = ${companyId}
          AND ${notFiscalClosingVoucher("v")}
        WHERE la.company_id = ${companyId}
          AND LOWER(TRIM(la.account_type)) IN (${accountTypesOfClassSql("income")})
          AND la.deleted_at IS NULL
        GROUP BY la.id, la.name, la.account_type
        HAVING COALESCE(SUM(CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric)), 0) > 0
        ORDER BY net_income DESC
        LIMIT ${rowLimit}
      `);
      let grandIncome = 0;
      const tableRows7 = rows.rows.map((r) => {
        const income = parseFloat(r.net_income || "0");
        grandIncome += income;
        return [r.name, r.account_type, fmt(income)];
      });
      if (tableRows7.length) tableRows7.push(["TOTAL", "", fmt(grandIncome)]);
      dataQueryResult = {
        queryType: "income_breakdown",
        title: "Income Breakdown by Account",
        subtitle: `${dateFrom} → ${dateTo} · Total: ${fmt(grandIncome)}`,
        table: { headers: ["Account", "Type", "Net Income"], rows: tableRows7 },
        noData: tableRows7.length === 0,
      };
      break;
    }

    case "factory_worker_profile": {
      const workerName7 = params.entityName;
      if (!workerName7) {
        dataQueryResult = {
          queryType: "factory_worker_profile",
          title: "Factory Worker Profile",
          summary: "Please specify a worker name.",
        };
        break;
      }
      const wRow = await db.execute<{
        full_name: string;
        employee_code: string | null;
        position: string | null;
        department: string | null;
        gender: string | null;
        nationality: string | null;
        date_of_birth: string | null;
        date_joined: string | null;
        salary_type: string;
        base_salary: string | null;
        per_bale_rate: string | null;
        per_kg_rate: string | null;
        phone1: string | null;
        phone2: string | null;
        active: boolean;
        bank_name: string | null;
        payment_method: string | null;
        visa_expiry: string | null;
        work_permit_expiry: string | null;
        shift_type: string | null;
        transport_allowance: string | null;
      }>(sql`
        SELECT fw.full_name, fw.employee_code, fw.position, fw.department,
          fw.gender, fw.nationality, fw.date_of_birth, fw.date_joined,
          fw.salary_type, fw.base_salary, fw.per_bale_rate, fw.per_kg_rate,
          fw.phone1, fw.phone2, fw.active, fw.bank_name, fw.payment_method,
          fw.visa_expiry, fw.work_permit_expiry, fw.shift_type,
          fw.transport_allowance
        FROM factory_workers fw
        WHERE fw.company_id = ${companyId}
          AND fw.full_name ILIKE ${"%" + workerName7 + "%"}
        ORDER BY fw.full_name LIMIT 1
      `);
      if (!wRow.rows.length) {
        dataQueryResult = {
          queryType: "factory_worker_profile",
          title: "Factory Worker Profile",
          summary: `No worker found matching "${workerName7}".`,
        };
        break;
      }
      const w7 = wRow.rows[0];
      const baleStats7 = await db.execute<{ total_bales: string; total_kg: string }>(sql`
        SELECT COUNT(id) AS total_bales,
          COALESCE(SUM(CAST(weight_kg AS numeric)), 0) AS total_kg
        FROM factory_bales
        WHERE company_id = ${companyId}
          AND pressed_at IS NOT NULL
          AND CAST(pressed_at AS text) BETWEEN ${dateFrom} AND ${dateTo}
          AND worker_name ILIKE ${"%" + workerName7 + "%"}
      `);
      const bs7 = baleStats7.rows[0];
      const stats7 = [
        { label: "Name", value: w7.full_name },
        { label: "Code", value: w7.employee_code || "—" },
        { label: "Position", value: w7.position || "—" },
        { label: "Department", value: w7.department || "—" },
        { label: "Status", value: w7.active ? "Active" : "Inactive" },
        { label: "Salary Type", value: w7.salary_type },
        { label: "Base Salary", value: fmt(parseFloat(w7.base_salary || "0")) },
        { label: "Per Bale Rate", value: fmtDec(parseFloat(w7.per_bale_rate || "0")) },
        { label: "Bales This Period", value: String(bs7?.total_bales || 0) },
        { label: "Kg This Period", value: fmtDec(parseFloat(bs7?.total_kg || "0")) },
      ];
      const profileRows = [
        ["Phone", w7.phone1 || "—"],
        ["Nationality", w7.nationality || "—"],
        ["Gender", w7.gender || "—"],
        ["Date of Birth", w7.date_of_birth ? String(w7.date_of_birth).slice(0, 10) : "—"],
        ["Date Joined", w7.date_joined ? String(w7.date_joined).slice(0, 10) : "—"],
        ["Shift Type", w7.shift_type || "—"],
        ["Bank", w7.bank_name || "—"],
        ["Payment Method", w7.payment_method || "—"],
        ["Visa Expiry", w7.visa_expiry ? String(w7.visa_expiry).slice(0, 10) : "—"],
        ["Work Permit Expiry", w7.work_permit_expiry ? String(w7.work_permit_expiry).slice(0, 10) : "—"],
        ["Transport Allowance", fmt(parseFloat(w7.transport_allowance || "0"))],
      ];
      dataQueryResult = {
        queryType: "factory_worker_profile",
        title: `Worker Profile: ${w7.full_name}`,
        subtitle: `${dateFrom} → ${dateTo} performance`,
        stats: stats7,
        table: { headers: ["Field", "Value"], rows: profileRows },
        noData: false,
      };
      break;
    }

    case "location_list": {
      const rows = await db.execute<{
        code: string;
        name: string;
        city: string | null;
        country: string | null;
        active: boolean;
        item_count: string;
        total_value: string;
      }>(sql`
        SELECT l.code, l.name, l.city, l.country, l.active,
          COUNT(DISTINCT inv.stock_item_id) AS item_count,
          COALESCE(SUM(CAST(inv.total_value AS numeric)), 0) AS total_value
        FROM locations l
        LEFT JOIN inventory inv ON inv.location_id = l.id AND inv.quantity > 0
        WHERE l.company_id = ${companyId}
          AND l.deleted_at IS NULL
        GROUP BY l.id, l.code, l.name, l.city, l.country, l.active
        ORDER BY l.name
      `);
      let grandValue = 0,
        grandItems = 0;
      const tableRows7 = rows.rows.map((r) => {
        const val = parseFloat(r.total_value || "0");
        const items = parseInt(r.item_count || "0");
        grandValue += val;
        grandItems += items;
        return [
          r.code || "—",
          r.name,
          r.city || "—",
          r.country || "—",
          String(items),
          fmt(val),
          r.active ? "Active" : "Inactive",
        ];
      });
      const stats7 = [
        { label: "Total Locations", value: String(tableRows7.length) },
        { label: "Total Stock Items", value: String(grandItems) },
        { label: "Total Inventory Value", value: fmt(grandValue), highlight: "positive" },
      ];
      dataQueryResult = {
        queryType: "location_list",
        title: "Warehouse / Location List",
        subtitle: `${tableRows7.length} location(s)`,
        stats: stats7,
        table: {
          headers: ["Code", "Name", "City", "Country", "Items", "Inv. Value", "Status"],
          rows: tableRows7,
        },
        noData: tableRows7.length === 0,
      };
      break;
    }

    case "quarterly_comparison": {
      const yearStr = params.dateFrom ? params.dateFrom.slice(0, 4) : todayStr.slice(0, 4);
      const rows = await db.execute<{
        quarter: string;
        revenue: string | null;
        cost: string | null;
        profit: string | null;
        sales_count: string;
      }>(sql`
        SELECT EXTRACT(QUARTER FROM CAST(v.voucher_date AS date)) AS quarter,
          SUM(CAST(sal.total_sales AS numeric)) AS revenue,
          SUM(CAST(sal.total_cost AS numeric)) AS cost,
          SUM(CAST(sal.profit AS numeric)) AS profit,
          COUNT(DISTINCT v.id) AS sales_count
        FROM sales_items sal
        JOIN vouchers v ON v.id = sal.voucher_id AND v.deleted_at IS NULL
        WHERE v.company_id = ${companyId}
          AND EXTRACT(YEAR FROM CAST(v.voucher_date AS date)) = ${parseInt(yearStr)}
        GROUP BY quarter
        ORDER BY quarter
      `);
      let totRev = 0,
        totCost = 0,
        totProfit = 0;
      const qLabels = ["Q1 (Jan-Mar)", "Q2 (Apr-Jun)", "Q3 (Jul-Sep)", "Q4 (Oct-Dec)"];
      const tableRows7 = rows.rows.map((r) => {
        const q = parseInt(r.quarter || "1");
        const rev = parseFloat(r.revenue || "0");
        const cost = parseFloat(r.cost || "0");
        const profit7 = parseFloat(r.profit || "0");
        const margin = rev > 0 ? ((profit7 / rev) * 100).toFixed(1) + "%" : "—";
        totRev += rev;
        totCost += cost;
        totProfit += profit7;
        return [qLabels[q - 1] || `Q${q}`, String(r.sales_count), fmt(rev), fmt(cost), fmt(profit7), margin];
      });
      if (tableRows7.length) {
        const totMargin = totRev > 0 ? ((totProfit / totRev) * 100).toFixed(1) + "%" : "—";
        tableRows7.push(["FULL YEAR", "", fmt(totRev), fmt(totCost), fmt(totProfit), totMargin]);
      }
      const stats7 = [
        { label: "Year", value: yearStr },
        { label: "Total Revenue", value: fmt(totRev) },
        { label: "Total Cost", value: fmt(totCost) },
        { label: "Total Profit", value: fmt(totProfit), highlight: "positive" },
        { label: "Overall Margin", value: totRev > 0 ? ((totProfit / totRev) * 100).toFixed(1) + "%" : "—" },
      ];
      dataQueryResult = {
        queryType: "quarterly_comparison",
        title: `Quarterly Comparison — ${yearStr}`,
        subtitle: `Sales revenue and profit by quarter`,
        stats: stats7,
        table: { headers: ["Quarter", "Invoices", "Revenue", "Cost", "Profit", "Margin"], rows: tableRows7 },
        noData: tableRows7.length === 0,
      };
      break;
    }

    default:
      return undefined;
  }

  return dataQueryResult;
}

export const phase7ReportShard: ReportImplementationShard = {
  name: "phase-7",
  queryTypes: phase7QueryTypes,
  run: runPhase7Report,
};
