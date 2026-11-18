/**
 * Shared Excel / PDF / Print builders for the Factory people screens
 * (Workers and Employees). Each page passes the rows it already shows, so
 * filters, permissions and amounts stay with the page; this module only
 * lays the table out. Heavy libraries load on demand.
 */
import { exportFileName } from "@/lib/exportFile";
import { formatUsd } from "@/lib/moneyDisplay";
import { printDocument } from "@/lib/printDocument";

export type PeopleExportCellType = "text" | "integer" | "money" | "date";

export interface PeopleExportColumn<Row> {
  header: string;
  value: (row: Row, index: number) => string | number | null | undefined;
  type?: PeopleExportCellType;
  /** Excel column width in characters. */
  width?: number;
}

export interface PeopleExportSpec<Row> {
  /** Report title, e.g. "Factory Employees". */
  title: string;
  /** File name stem, e.g. "factory employees" → `factory-employees_2026-11-17.xlsx`. */
  fileStem: string;
  columns: readonly PeopleExportColumn<Row>[];
  rows: readonly Row[];
  /** Optional totals row, one value per column (blank cells may be null). */
  footer?: readonly (string | number | null)[];
  /** Period shown under the title and used in the file name. */
  period?: { from?: string | null; to?: string | null };
  /** Extra line under the title (for example the person's name). */
  subtitle?: string;
}

function columnKey(index: number): string {
  return `c${index}`;
}

function excelType(type: PeopleExportCellType | undefined) {
  if (type === "money") return "money" as const;
  if (type === "integer") return "integer" as const;
  return "text" as const;
}

function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Cell text for PDF and print output. */
export function peopleExportCellText(value: unknown, type: PeopleExportCellType | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (type === "money") {
    const n = numericOrNull(value);
    return n === null ? String(value) : formatUsd(n, 2);
  }
  return String(value);
}

function periodLine(period: PeopleExportSpec<unknown>["period"]): string {
  if (!period?.from && !period?.to) return "";
  return `${period.from ?? "…"} – ${period.to ?? "…"}`;
}

function fileName(spec: PeopleExportSpec<unknown>, extension: "xlsx" | "pdf"): string {
  return exportFileName(spec.fileStem, extension, { from: spec.period?.from, to: spec.period?.to });
}

export async function exportPeopleTableExcel<Row>(spec: PeopleExportSpec<Row>): Promise<void> {
  const columns = spec.columns.map((column, index) => ({
    key: columnKey(index),
    header: column.header,
    type: excelType(column.type),
    width: column.width ?? (column.type === "money" ? 16 : 18),
  }));
  const rows = spec.rows.map((row, rowIndex) => {
    const record: Record<string, unknown> = {};
    spec.columns.forEach((column, index) => {
      const raw = column.value(row, rowIndex);
      record[columnKey(index)] =
        column.type === "money" || column.type === "integer" ? numericOrNull(raw) : raw == null ? "" : String(raw);
    });
    return record;
  });
  const footer = spec.footer
    ? Object.fromEntries(
        spec.columns.map((column, index) => {
          const raw = spec.footer?.[index] ?? null;
          return [
            columnKey(index),
            column.type === "money" || column.type === "integer" ? numericOrNull(raw) : raw == null ? "" : String(raw),
          ];
        })
      )
    : undefined;
  const filters = [
    ...(spec.subtitle ? [{ label: "For", value: spec.subtitle }] : []),
    ...(periodLine(spec.period) ? [{ label: "Period", value: periodLine(spec.period) }] : []),
  ];
  const { exportOperationalWorkbook } = await import("@/lib/operationalExcelExport");
  await exportOperationalWorkbook({
    title: spec.title,
    fileName: fileName(spec as PeopleExportSpec<unknown>, "xlsx"),
    filters: filters.length ? filters : undefined,
    sheets: [{ name: spec.title.slice(0, 31), columns, rows, footer }],
  });
}

function bodyRows<Row>(spec: PeopleExportSpec<Row>): string[][] {
  return spec.rows.map((row, rowIndex) =>
    spec.columns.map((column) => peopleExportCellText(column.value(row, rowIndex), column.type))
  );
}

function footerRow<Row>(spec: PeopleExportSpec<Row>): string[] | null {
  if (!spec.footer) return null;
  return spec.columns.map((column, index) => peopleExportCellText(spec.footer?.[index] ?? null, column.type));
}

export async function exportPeopleTablePdf<Row>(spec: PeopleExportSpec<Row>): Promise<void> {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const autoTable = autoTableModule.default;
  const landscape = spec.columns.length > 6;
  const doc = new jsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text(spec.title, pageWidth / 2, 14, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const lines = [spec.subtitle, periodLine(spec.period)].filter(Boolean) as string[];
  lines.forEach((line, index) => doc.text(line, pageWidth / 2, 20 + index * 5, { align: "center" }));
  const footer = footerRow(spec);
  autoTable(doc, {
    startY: 22 + lines.length * 5,
    head: [spec.columns.map((column) => column.header)],
    body: bodyRows(spec),
    foot: footer ? [footer] : undefined,
    theme: "grid",
    styles: { font: "helvetica", fontSize: 8, cellPadding: 1.5 },
    headStyles: { fillColor: [46, 59, 78], textColor: [255, 255, 255], fontStyle: "bold" },
    footStyles: { fillColor: [232, 236, 242], textColor: [23, 32, 51], fontStyle: "bold" },
    columnStyles: Object.fromEntries(
      spec.columns
        .map((column, index) => [index, column.type === "money" || column.type === "integer" ? "right" : null] as const)
        .filter(([, align]) => align !== null)
        .map(([index, align]) => [index, { halign: align as "right" }])
    ),
  });
  doc.save(fileName(spec as PeopleExportSpec<unknown>, "pdf"));
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Builds the print document; exported for tests. */
export function peopleTablePrintHtml<Row>(spec: PeopleExportSpec<Row>): string {
  const alignOf = (type: PeopleExportCellType | undefined) =>
    type === "money" || type === "integer" ? ' class="num"' : "";
  const head = spec.columns.map((column) => `<th${alignOf(column.type)}>${escapeHtml(column.header)}</th>`).join("");
  const body = bodyRows(spec)
    .map(
      (cells) =>
        `<tr>${cells.map((cell, index) => `<td${alignOf(spec.columns[index].type)} dir="auto">${escapeHtml(cell)}</td>`).join("")}</tr>`
    )
    .join("");
  const footer = footerRow(spec);
  const foot = footer
    ? `<tfoot><tr>${footer.map((cell, index) => `<td${alignOf(spec.columns[index].type)}>${escapeHtml(cell)}</td>`).join("")}</tr></tfoot>`
    : "";
  const lines = [spec.subtitle, periodLine(spec.period)].filter(Boolean) as string[];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(spec.title)}</title>
<style>
  @page { size: A4 ${spec.columns.length > 6 ? "landscape" : "portrait"}; margin: 10mm; }
  body { font-family: 'Segoe UI', Tahoma, Arial, 'Noto Sans Arabic', sans-serif; font-size: 9pt; color: #111; margin: 0; }
  h1 { font-size: 13pt; text-align: center; margin: 0 0 2px; }
  .sub { text-align: center; color: #555; font-size: 9pt; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #e8e8e8; border: 1px solid #aaa; padding: 3px 4px; text-align: left; }
  td { border: 1px solid #ccc; padding: 2px 4px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 700; background: #f2f4f7; }
  tbody tr:nth-child(even) td { background: #f9f9f9; }
</style>
</head>
<body>
<h1>${escapeHtml(spec.title)}</h1>
${lines.map((line) => `<div class="sub">${escapeHtml(line)}</div>`).join("")}
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>
</body>
</html>`;
}

/** Opens the browser print dialog for the table. Returns false when a pop-up blocker stopped it. */
export function printPeopleTable<Row>(spec: PeopleExportSpec<Row>): boolean {
  // Callers show their own "Print failed" toast when this returns false.
  return printDocument(peopleTablePrintHtml(spec), { onBlocked: () => undefined }) !== null;
}
