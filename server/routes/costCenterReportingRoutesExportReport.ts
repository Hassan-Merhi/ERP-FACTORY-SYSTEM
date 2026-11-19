// Extracted from ./costCenterReportingRoutes.ts
import { buildUniversalExcelWorkbook } from "@shared/universal-excel/engine";
import { styleUniversalFinancialWorkbook } from "@shared/universal-excel/financialWorkbookStyle";
import type { Response } from "express";
import PDFDocument from "pdfkit";
import { toMoney } from "../lib/money";
import { ReportError, type Filters, type Scope } from "./costCenterReportingRoutesReversalPairSql";
import { activityData, summaryData } from "./costCenterReportingRoutesSummaryData";

export async function exportReport(res: Response, scope: Scope, filters: Filters, format: string, view: string) {
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
