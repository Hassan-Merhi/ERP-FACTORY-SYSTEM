import { format } from "date-fns";
import { utils, writeFile } from "@/lib/excelHelper";
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
  const ws = utils.json_to_sheet(data);
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, operationalFiltered ? "Operational Filtered" : "Daybook");
  await writeFile(
    wb,
    `${operationalFiltered ? "Operational_Filtered_Daybook" : "Daybook"}_${format(new Date(), "yyyy-MM-dd")}.xlsx`
  );
}

/** Writes the detailed export workbook and returns the exported detail rows. */
export async function exportDaybookDetail(
  vouchers: Voucher[],
  { operationalFiltered, formatDisplayDate }: DaybookExportOptions
): Promise<ReturnType<typeof buildDetailedDaybookRows>> {
  const detailRows = buildDetailedDaybookRows(vouchers as unknown as Array<Record<string, unknown>>, formatDisplayDate);
  const ws = utils.json_to_sheet(detailRows);
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, operationalFiltered ? "Operational Detail Filtered" : "Daybook Detail");
  await writeFile(
    wb,
    `${operationalFiltered ? "Operational_Filtered_Detail" : "Daybook_Detail"}_${format(new Date(), "yyyy-MM-dd")}.xlsx`
  );
  return detailRows;
}
