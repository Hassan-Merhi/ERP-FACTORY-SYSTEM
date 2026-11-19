import type { RowsExportColumn, RowsExportValue } from "@/components/export/RowsExportMenu";

/** One line of the Stock Item / Location vouchers ledger, as the server returns it. */
export interface StockVoucherExportRow {
  date: string;
  particulars: string;
  vchType: string;
  inwardQty: number;
  inwardRate: number;
  inwardValue: number;
  outwardQty: number;
  outwardRate: number;
  outwardValue: number;
  closingQty: number;
  closingRate: number;
  closingValue: number;
  isOpeningBalance?: boolean;
  isPOS?: boolean;
  posSellingRate?: number;
  posSellingValue?: number;
}

export type StockVoucherTotals = Pick<
  StockVoucherExportRow,
  | "inwardQty"
  | "inwardRate"
  | "inwardValue"
  | "outwardQty"
  | "outwardRate"
  | "outwardValue"
  | "closingQty"
  | "closingRate"
  | "closingValue"
>;

const qty = (value: number) => (value === 0 ? null : value);

/**
 * Columns of the stock vouchers ledger exactly as the page shows them: the
 * opening line has no date, POS lines show the selling rate/value, and
 * `quantitiesOnly` drops the rate and value columns the POS view hides.
 */
export function stockVoucherExportColumns(
  formatDate: (date: string) => string,
  quantitiesOnly = false
): RowsExportColumn<StockVoucherExportRow>[] {
  const money = (header: string, value: (row: StockVoucherExportRow) => number) =>
    quantitiesOnly ? [] : [{ header, value, type: "number" as const }];
  return [
    { header: "Date", value: (row) => (row.isOpeningBalance ? "" : formatDate(row.date)) },
    { header: "Particulars", value: (row) => row.particulars },
    { header: "Vch Type", value: (row) => row.vchType },
    { header: "Inwards Qty", value: (row) => qty(row.inwardQty), type: "number" },
    ...money("Inwards Rate", (row) => row.inwardRate),
    ...money("Inwards Value", (row) => row.inwardValue),
    { header: "Outwards Qty", value: (row) => qty(row.outwardQty), type: "number" },
    ...money("Outwards Rate", (row) => (row.isPOS && row.posSellingRate ? row.posSellingRate : row.outwardRate)),
    ...money("Outwards Value", (row) => (row.isPOS && row.posSellingValue ? row.posSellingValue : row.outwardValue)),
    { header: "Closing Qty", value: (row) => qty(row.closingQty), type: "number" },
    ...money("Closing Rate", (row) => row.closingRate),
    ...money("Closing Value", (row) => row.closingValue),
  ];
}

/** The ledger's Totals row, in the same column order. */
export function stockVoucherExportFooter(totals: StockVoucherTotals, quantitiesOnly = false): RowsExportValue[] {
  const money = (value: number) => (quantitiesOnly ? [] : [value]);
  return [
    "Totals",
    null,
    null,
    qty(totals.inwardQty),
    ...money(totals.inwardRate),
    ...money(totals.inwardValue),
    qty(totals.outwardQty),
    ...money(totals.outwardRate),
    ...money(totals.outwardValue),
    qty(totals.closingQty),
    ...money(totals.closingRate),
    ...money(totals.closingValue),
  ];
}
