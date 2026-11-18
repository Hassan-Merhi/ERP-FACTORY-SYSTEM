import { useState } from "react";

import { ReportExportMenu, REPORT_EXPORT_LABELS, type ReportExportOption } from "@/components/export/ReportExportMenu";
import { useToast } from "@/hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import { useOptionalCompany } from "@/contexts/CompanyContext";
import { decideLegacyCan, type CanResult, type LegacyPermissionRow } from "@/hooks/useCan";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { accessQueryPolicy } from "@/lib/queryPolicies";
import { exportFileName, type ExportFileNameOptions } from "@/lib/exportFile";
import type { AccessControlResource } from "@shared/accessControlV2";

export type RowsExportValue = string | number | boolean | null | undefined;

export interface RowsExportColumn<Row> {
  header: string;
  // Method syntax keeps sheets of different row types assignable to `extraSheets`.
  value(row: Row): RowsExportValue;
  /** "number" keeps the cell numeric in Excel; everything else is written as shown. */
  type?: "text" | "number";
}

export interface RowsExportSheet<Row> {
  name: string;
  rows: readonly Row[];
  columns: readonly RowsExportColumn<Row>[];
  /** A total row the page shows under the table, one value per column. */
  footer?: readonly RowsExportValue[];
}

export interface RowsExportMenuProps<Row> {
  /** Workbook title and the subject of the file name (`subject_YYYY-MM-DD.xlsx`). */
  title: string;
  /** The rows the page shows under its current filters, in display order. */
  rows: readonly Row[];
  columns: readonly RowsExportColumn<Row>[];
  /** The page's total row, one value per column (blank cells as null). */
  footer?: readonly RowsExportValue[];
  /** Further tables on the same page, written as extra worksheets. */
  extraSheets?: readonly RowsExportSheet<unknown>[];
  sheetName?: string;
  /** Business resource the page belongs to; export is checked against it. */
  resource: AccessControlResource;
  /** Reported period, used in the file name. */
  period?: Pick<ExportFileNameOptions, "from" | "to">;
  /** Active filters, written above the table ("Location: Main"). */
  filters?: readonly { label: string; value: string }[];
  disabled?: boolean;
  size?: "default" | "sm";
  variant?: "outline" | "secondary" | "ghost";
  className?: string;
  "data-testid"?: string;
}

/**
 * Permission used by every client-side list/report Excel export: the same
 * check the Suppliers export uses (`export` action + the `exp_excel` feature).
 */
export function useCanExportExcel(resource: AccessControlResource): CanResult {
  // Same decision as useCan(resource, "export", { legacyAllowed: true, featureKey: "exp_excel" }),
  // but without a company provider (standalone panels, tests) the menu is simply hidden.
  const selectedCompany = useOptionalCompany()?.selectedCompany ?? null;
  const companyId = selectedCompany?.id ?? null;
  const role = selectedCompany?.role ?? null;
  const needsPermissions = !!companyId && !!role && role !== "Admin" && role !== "Developer";
  const permissions = useQuery<LegacyPermissionRow[]>({
    queryKey: companyQueryKey("/api/my-permissions", companyId ?? undefined),
    ...accessQueryPolicy,
    enabled: needsPermissions,
  });
  return decideLegacyCan({
    role,
    companyId,
    resource,
    action: "export",
    legacyAllowed: true,
    featureKey: "exp_excel",
    permissions: permissions.data,
    permissionsReady: permissions.isSuccess,
    permissionsError: permissions.isError,
  });
}

function toCell(value: RowsExportValue, numeric: boolean): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (numeric) {
    const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return typeof value === "number" || typeof value === "boolean" ? value : String(value);
}

/** Converts page rows into a strict universal-Excel table sheet (exported for tests). */
export function buildRowsExportSheet<Row>(sheet: RowsExportSheet<Row>) {
  const columns = sheet.columns.map((column, index) => ({
    key: `c${index}`,
    header: column.header,
    type: column.type === "number" ? ("decimal" as const) : ("auto" as const),
    width: column.type === "number" ? 14 : 22,
  }));
  const rows = sheet.rows.map((row) => {
    const record: Record<string, unknown> = {};
    sheet.columns.forEach((column, index) => {
      record[`c${index}`] = toCell(column.value(row), column.type === "number");
    });
    return record;
  });
  const footer = sheet.footer
    ? Object.fromEntries(
        sheet.columns.map((column, index) => [`c${index}`, toCell(sheet.footer?.[index], column.type === "number")])
      )
    : undefined;
  return { name: sheet.name, columns, rows, footer };
}

/**
 * The standard Export menu for list and report pages that build the file from
 * rows they already have. Hidden for users who may not export Excel.
 */
/**
 * A worksheet name Excel accepts: no \\ / * ? : [ ], no leading or trailing apostrophe, at most 31 characters,
 * and unique (case-insensitive) within the workbook. Labels such as "Average Profit / Bale" are made safe here
 * instead of failing the whole export.
 */
export function excelSheetName(name: string, used: Set<string>): string {
  const cleaned =
    name
      .replace(/[\\/*?:[\]]/g, "-")
      .replace(/^'+|'+$/g, "")
      .trim() || "Sheet";
  let candidate = cleaned.slice(0, 31);
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
    const suffix = ` (${n})`;
    candidate = cleaned.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export function RowsExportMenu<Row>({
  title,
  rows,
  columns,
  footer,
  extraSheets = [],
  sheetName,
  resource,
  period,
  filters,
  disabled,
  size = "sm",
  variant,
  className,
  "data-testid": testId = "button-export-menu",
}: RowsExportMenuProps<Row>) {
  const { toast } = useToast();
  const access = useCanExportExcel(resource);
  const [busy, setBusy] = useState(false);
  if (!access.allowed) return null;

  const exportExcel = async () => {
    setBusy(true);
    try {
      const { exportOperationalWorkbook } = await import("@/lib/operationalExcelExport");
      const usedNames = new Set<string>();
      const mainSheet = buildRowsExportSheet({
        name: excelSheetName(sheetName ?? title, usedNames),
        rows,
        columns,
        footer,
      });
      await exportOperationalWorkbook({
        title,
        fileName: exportFileName(title, "xlsx", period ?? {}),
        filters,
        sheets: [
          mainSheet,
          ...extraSheets.map((sheet) =>
            buildRowsExportSheet({ ...sheet, name: excelSheetName(sheet.name, usedNames) })
          ),
        ],
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const options: ReportExportOption[] = [
    { id: "excel", kind: "excel", label: REPORT_EXPORT_LABELS.excel, onSelect: exportExcel },
  ];

  return (
    <ReportExportMenu
      options={options}
      busy={busy}
      disabled={disabled || (rows.length === 0 && extraSheets.every((sheet) => sheet.rows.length === 0))}
      size={size}
      variant={variant}
      className={className}
      data-testid={testId}
    />
  );
}
