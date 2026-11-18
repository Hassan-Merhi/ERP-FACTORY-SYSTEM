import { format } from "date-fns";

import type { RowsExportColumn } from "@/components/export/RowsExportMenu";

interface DeletedItemExportRow {
  type: string;
  name: string;
  code?: string | null;
  accountType?: string | null;
  voucherType?: string | null;
  locationName?: string | null;
  amount?: number | null;
  deletedAt?: string | null;
}

/** The Deleted Items table as shown: type label, code, name (with its detail line) and deletion time. */
export function deletedItemsExportColumns(
  typeLabels: Readonly<Record<string, string>>,
  formatDisplayDate: (date: string) => string
): RowsExportColumn<DeletedItemExportRow>[] {
  return [
    { header: "Type", value: (item) => typeLabels[item.type] || item.type },
    { header: "Code", value: (item) => item.code || "-" },
    { header: "Name", value: (item) => item.name },
    {
      header: "Detail",
      value: (item) =>
        item.type === "orphanedPosSale"
          ? item.locationName
          : item.type === "voucher"
            ? item.voucherType
            : item.accountType,
    },
    {
      header: "Amount",
      value: (item) => (item.type === "orphanedPosSale" || item.type === "voucher" ? (item.amount ?? 0) : null),
      type: "number",
    },
    {
      header: "Deleted At",
      value: (item) =>
        item.deletedAt ? `${formatDisplayDate(item.deletedAt)} ${format(new Date(item.deletedAt), "h:mm a")}` : "-",
    },
  ];
}
