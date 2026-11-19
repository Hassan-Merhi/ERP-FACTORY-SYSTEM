import { buildUniversalExcelWorkbook } from "@shared/universal-excel/engine";
import { styleUniversalFinancialWorkbook } from "@shared/universal-excel/financialWorkbookStyle";
/**
 * Cost Centers Phase 6: historical-USD analytical budgets and reporting.
 * Nothing here creates vouchers, changes stock value, or alters the GL.
 * Reporting is based only on the authoritative source posting.
 */
import type { Express, Response } from "express";
import PDFDocument from "pdfkit";
import { pool } from "../db";
import { requireAuth } from "../auth";
import { z } from "zod";
import { emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../lib/validateRequest";
import { toMoney } from "../lib/money";
import {
  ERP_PREFIX,
  ReportError,
  decimalFormat,
  fail,
  isCostCenterExportView,
  monthFormat,
  parseFilters,
  resolveScope,
  transactional,
  valueId,
  type Filters,
  type Scope,
} from "./costCenterReportingRoutesReversalPairSql";
import { activityData, auditBudget, summaryData } from "./costCenterReportingRoutesSummaryData";
export {
  COST_CENTER_EXPORT_VIEWS,
  isCostCenterExportView,
  reversalPairSql,
  sourceCte,
} from "./costCenterReportingRoutesReversalPairSql";
// The handler checks the decimal format, notes length and reason itself.
const budgetInput = {
  params: z.strictObject({ costCenterId: stringParam, month: stringParam }),
  query: emptyQuery,
  body: z.strictObject({
    amountUsd: z.union([z.string(), z.number()]).optional(),
    notes: z.string().nullable().optional(),
    reason: z.string().optional(),
  }),
} satisfies RequestSchemas;
async function exportReport(res: Response, scope: Scope, filters: Filters, format: string, view: string) {
  const data = await summaryData(scope, filters);
  const layouts: Record<string, string[]> = {
    activity: [
      "sourceDate",
      "companyId",
      "costCenterCode",
      "accountName",
      "sourceModule",
      "voucherNumber",
      "treatment",
      "allocationOrigin",
      "currency",
      "amountNative",
      "amountUsd",
    ],
    summary: ["companyName", "code", "name", "expense", "budget", "variance", "inventoryCost", "entries"],
    departments: ["companyName", "code", "name", "expense", "budget", "variance", "inventoryCost", "members"],
    accounts: ["companyId", "accountName", "expense", "inventoryCost", "entries"],
    months: ["month", "expense", "unallocated", "budget", "variance", "inventoryCost"],
  };
  const cols = layouts[view];
  if (!cols) throw new ReportError(400, "Invalid export view");
  const centerExport =
    view === "summary" && data.totals.unallocatedApplicable && !toMoney(data.totals.unallocated).isZero()
      ? [
          ...data.centers,
          {
            companyName: scope.companyIds.length > 1 ? "Authorized companies" : "Current company",
            code: "UNALLOCATED",
            name: "Unallocated expense",
            expense: data.totals.unallocated,
            budget: "0",
            variance: data.totals.unallocated,
            inventoryCost: "0",
            entries: 0,
          },
        ]
      : data.centers;
  const items =
    view === "activity"
      ? (await activityData(scope, filters, 5001, 0)).activity
      : view === "departments"
        ? data.departments
        : view === "accounts"
          ? data.accounts
          : view === "months"
            ? data.months
            : centerExport;
  if (items.length > 5000) throw new ReportError(413, "Narrow your dates or center for exports above 5,000 rows");
  const name = "cost-centers-" + view + "-" + filters.from + "-" + filters.to;
  const rowData = (items as unknown as Array<Record<string, unknown>>).map((item) =>
    cols.map((col) => String(item[col] ?? ""))
  );
  const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) && !/^[-+]?\d+(?:\.\d+)?$/.test(v) ? "'" + v : v);
  if (format === "csv") {
    const escape = (v: string) => '"' + safe(v).replace(/"/g, '""') + '"';
    const contents = "\uFEFF" + [cols, ...rowData].map((c) => c.map(escape).join(",")).join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="' + name + '.csv"');
    return res.send(contents);
  }
  if (format === "xlsx") {
    // The underlying scoped report controls company access and the 5,000-row
    // ceiling above. Preserve original precision for 20,6 historical FX: values
    // too large for faithful Excel doubles remain text, not rounded amounts.
    const numericColumns = new Set([
      "expense",
      "inventoryCost",
      "budget",
      "variance",
      "unallocated",
      "amountNative",
      "amountUsd",
      "entries",
      "members",
    ]);
    const rows = rowData.map((line) =>
      Object.fromEntries(
        line.map((value, index) => {
          if (numericColumns.has(cols[index]) && /^[-+]?\d+(?:\.\d+)?$/.test(value)) {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && Math.abs(parsed) < 1e12) {
              return [cols[index], parsed];
            }
          }
          return [cols[index], value];
        })
      )
    );
    const { workbook } = buildUniversalExcelWorkbook({
      schemaVersion: 1,
      mode: "import-template",
      title: "Cost Center — " + view,
      filters: [
        { label: "Date from", value: filters.from },
        { label: "Date to", value: filters.to },
      ],
      sheets: [
        {
          kind: "table",
          name: "Cost Centers",
          headerRow: 1,
          freezeHeader: true,
          autoFilter: true,
          columns: cols.map((key) => ({
            key,
            header: key,
            type: "auto" as const,
            width: 22,
          })),
          rows,
        },
      ],
    });
    // Row 1 is part of the legacy CSV/XLSX round-trip contract. Apply shared
    // branding to its EXISTING header and print area without inserting rows.
    styleUniversalFinancialWorkbook(workbook, [{ name: "Cost Centers", headerRow: 1 }]);
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="' + name + '.xlsx"');
    return res.end(Buffer.from(buffer));
  }
  if (format === "pdf") {
    const pdf = new PDFDocument({ margin: 34, size: "A4", layout: "landscape" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="' + name + '.pdf"');
    pdf.pipe(res);
    const viewTitle: Record<string, string> = {
      summary: "Budget & Expense Report",
      activity: "Activity Report",
      departments: "Budget & Expense Report by Department",
      accounts: "Expense Report by Account",
      months: "Budget & Expense Report by Month",
    };
    pdf.fontSize(16).text("Cost Center " + viewTitle[view]);
    pdf.fontSize(9).text(filters.from + " to " + filters.to + " | Historical USD | Whole-month budgets");
    if (view !== "activity") {
      pdf.text(
        "Allocated expense: " +
          data.totals.expense +
          " | Unallocated: " +
          data.totals.unallocated +
          " | Budget: " +
          data.totals.budget +
          " | Variance: " +
          data.totals.variance +
          " | Inventory costs (separate): " +
          data.totals.inventoryCost
      );
    }
    pdf.moveDown();
    const widths = view === "activity" ? [65, 42, 80, 100, 66, 80, 60, 55, 38, 62, 62] : cols.map(() => 80);
    const pageW = pdf.page.width - 68;
    const scale = pageW / widths.reduce((s, v) => s + v, 0);
    let y = pdf.y;
    function draw(line: string[], header = false) {
      if (y > pdf.page.height - 45) {
        pdf.addPage();
        y = 38;
      }
      let x = 34;
      if (header) pdf.font("Helvetica-Bold");
      else pdf.font("Helvetica");
      for (let i = 0; i < line.length; i++) {
        const w = widths[i] * scale;
        pdf.fontSize(7.5).text(line[i].slice(0, 38), x, y, { width: w - 4, height: 16, ellipsis: true });
        x += w;
      }
      y += 19;
    }
    draw(cols, true);
    rowData.forEach((row) => draw(row));
    pdf.end();
    return;
  }
  throw new ReportError(400, "Invalid export format");
}

function registerPrefix(app: Express, prefix: string) {
  app.get(prefix + "/reports/summary", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      res.json(await summaryData(scope, parseFilters(req)));
    } catch (e) {
      fail(res, e);
    }
  });
  app.get(prefix + "/reports/consolidated", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req, false, true, prefix === ERP_PREFIX);
      res.json(await summaryData(scope, parseFilters(req)));
    } catch (e) {
      fail(res, e);
    }
  });
  app.get(prefix + "/reports/consolidated/activity", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req, false, true, prefix === ERP_PREFIX);
      const limit = req.query.limit === undefined ? 50 : valueId(req.query.limit);
      const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
      if (limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 2000000)
        throw new ReportError(400, "Invalid pagination");
      res.json(await activityData(scope, parseFilters(req), limit, offset));
    } catch (e) {
      fail(res, e);
    }
  });
  app.get(prefix + "/reports/consolidated/export", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req, false, true, prefix === ERP_PREFIX);
      const format = req.query.format;
      const view = req.query.view ?? "summary";
      if (!["csv", "xlsx", "pdf"].includes(String(format)) || !isCostCenterExportView(view))
        throw new ReportError(400, "Invalid export request");
      await exportReport(res, scope, parseFilters(req), String(format), String(view));
    } catch (e) {
      if (!res.headersSent) fail(res, e);
      else res.end();
    }
  });
  app.get(prefix + "/reports/activity", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      const limit = req.query.limit === undefined ? 50 : valueId(req.query.limit);
      const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
      if (limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 2000000)
        throw new ReportError(400, "Invalid pagination");
      res.json(await activityData(scope, parseFilters(req), limit, offset));
    } catch (e) {
      fail(res, e);
    }
  });
  app.get(prefix + "/reports/export", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      const format = req.query.format;
      const view = req.query.view ?? "summary";
      if (!["csv", "xlsx", "pdf"].includes(String(format)) || !isCostCenterExportView(view))
        throw new ReportError(400, "Invalid export request");
      await exportReport(res, scope, parseFilters(req), String(format), String(view));
    } catch (e) {
      if (!res.headersSent) fail(res, e);
      else res.end();
    }
  });
  app.get(prefix + "/budgets", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      const filters = parseFilters(req);
      const result = await pool.query(
        'SELECT id,company_id AS "companyId",cost_center_id AS "costCenterId",' +
          ' budget_month::text AS month,amount_usd::text AS "amountUsd",notes,' +
          ' updated_by AS "updatedBy",updated_at AS "updatedAt"' +
          " FROM cost_center_monthly_budgets" +
          " WHERE company_id=$1 AND budget_month BETWEEN date_trunc('month',$2::date)::date" +
          " AND date_trunc('month',$3::date)::date" +
          " ORDER BY budget_month,cost_center_id",
        [scope.companyId, filters.from, filters.to]
      );
      res.json({ budgets: result.rows });
    } catch (e) {
      fail(res, e);
    }
  });
  // Auditable budget history, scoped to the active company and selected center.
  app.get(prefix + "/budgets/:costCenterId/:month/history", requireAuth, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      const centerId = valueId(req.params.costCenterId);
      const period = req.params.month;
      if (!monthFormat.test(period)) throw new ReportError(400, "Invalid budget month");
      const budget = await pool.query(
        "SELECT id FROM cost_center_monthly_budgets" +
          " WHERE company_id=$1 AND cost_center_id=$2 AND budget_month=$3::date",
        [scope.companyId, centerId, period + "-01"]
      );
      if (!budget.rows.length) return res.json({ history: [] });
      const history = await pool.query(
        'SELECT id,username,action,changes,created_at AS "createdAt"' +
          " FROM audit_log WHERE company_id=$1 AND table_name='cost_center_monthly_budgets'" +
          " AND record_id=$2 ORDER BY id DESC LIMIT 100",
        [scope.companyId, budget.rows[0].id]
      );
      res.json({ history: history.rows });
    } catch (e) {
      fail(res, e);
    }
  });
  app.put(prefix + "/budgets/:costCenterId/:month", requireAuth, validateRequest(budgetInput), async (req, res) => {
    try {
      const scope = await resolveScope(req, true);
      const centerId = valueId(req.params.costCenterId);
      const period = req.params.month;
      if (!monthFormat.test(period)) throw new ReportError(400, "Invalid budget month");
      const amount = String(req.body?.amountUsd ?? "");
      if (!decimalFormat.test(amount)) throw new ReportError(400, "Invalid nonnegative USD budget");
      const notes = req.body?.notes === undefined ? null : req.body.notes;
      const reason = req.body?.reason;
      if (
        (notes !== null && (typeof notes !== "string" || notes.length > 1200)) ||
        typeof reason !== "string" ||
        reason.trim().length < 3 ||
        reason.length > 500
      )
        throw new ReportError(400, "Notes or audit reason is invalid");
      const result = await transactional(async (client) => {
        const exists = await client.query(
          "SELECT id FROM cost_centers WHERE company_id=$1 AND id=$2 AND active=true FOR SHARE",
          [scope.companyId, centerId]
        );
        if (!exists.rowCount) throw new ReportError(409, "Budget center must be active in this company");
        const before = await client.query(
          "SELECT * FROM cost_center_monthly_budgets WHERE company_id=$1" +
            " AND cost_center_id=$2 AND budget_month=$3::date FOR UPDATE",
          [scope.companyId, centerId, period + "-01"]
        );
        const after = await client.query(
          "INSERT INTO cost_center_monthly_budgets" +
            "(company_id,cost_center_id,budget_month,amount_usd,notes,created_by,updated_by)" +
            " VALUES($1,$2,$3::date,$4,$5,$6,$6)" +
            " ON CONFLICT(company_id,cost_center_id,budget_month)" +
            " DO UPDATE SET amount_usd=excluded.amount_usd,notes=excluded.notes," +
            "updated_by=excluded.updated_by,updated_at=now() RETURNING *",
          [scope.companyId, centerId, period + "-01", toMoney(amount).toFixed(6), notes, scope.userId]
        );
        await auditBudget(client, scope, after.rows[0].id, before.rows[0] ?? null, after.rows[0], reason.trim());
        return after.rows[0];
      });
      res.json({ budget: result });
    } catch (e) {
      fail(res, e);
    }
  });
}
export function registerCostCenterReportingRoutes(app: Express): void {
  registerPrefix(app, ERP_PREFIX);
  registerPrefix(app, "/api/factory/cost-centers");
}
