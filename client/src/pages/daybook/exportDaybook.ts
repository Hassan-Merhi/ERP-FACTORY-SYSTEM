import { erpReportFileName, exportErpReportRowsExcel } from "@/erp-core";
import { buildDetailedDaybookRows } from "@/lib/daybook-export";
import type { Voucher } from "./types";

interface DaybookExportOptions {
  /** Operational (routine-accounting) filtered view: sheet and file names say so. */
  operationalFiltered: boolean;
  formatDisplayDate: (date: string | Date) => string;
}

export async function exportDaybookSummary(
  vouchers: Voucher[],
  {
    operationalFiltered,
    formatDisplayDate,
    formatAmount,
  }: DaybookExportOptions & {
    formatAmount: (value: string) => string;
  }
) {
  const data = vouchers.map((v) => ({
    "Voucher Number": v.voucherNumber,
    Date: formatDisplayDate(v.voucherDate),
    Type: v.voucherType,
    Description: v.description || "",
    "Total Amount": formatAmount(v.totalAmount),
    Optional: v.optional ? "Yes" : "No",
  }));
  await exportErpReportRowsExcel({
    rows: data,
    sheetName: operationalFiltered ? "Operational Filtered" : "Daybook",
    fileName: erpReportFileName(operationalFiltered ? "Operational_Filtered_Daybook" : "Daybook", "xlsx"),
    universalDesign: true,
  });
}

/** Writes the detailed export workbook and returns the exported detail rows. */
export async function exportDaybookDetail(
  vouchers: Voucher[],
  { operationalFiltered, formatDisplayDate }: DaybookExportOptions
): Promise<ReturnType<typeof buildDetailedDaybookRows>> {
  const detailRows = buildDetailedDaybookRows(vouchers as unknown as Array<Record<string, unknown>>, formatDisplayDate);
  await exportErpReportRowsExcel({
    rows: detailRows,
    sheetName: operationalFiltered ? "Operational Detail Filtered" : "Daybook Detail",
    fileName: erpReportFileName(operationalFiltered ? "Operational_Filtered_Detail" : "Daybook_Detail", "xlsx"),
    universalDesign: true,
  });
  return detailRows;
}
