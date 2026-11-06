/**
 * Presentation-only reconciliation. Payment and voucher rows are never changed.
 * All amounts use integer cents and retain the recorded (unconverted) currency.
 */
export type ReceiptRow = {
  id: number;
  paymentDate: string;
  amount: string | number;
  voucherId?: number | null;
  cashAccountId?: number | null;
  postingStatus?: string;
  receiptKind?: string;
  readOnly?: boolean;
  tenantName?: string | null;
  unitNumber?: string | null;
  locationGroup?: string | null;
  forMonth?: number;
  forYear?: number;
  notes?: string | null;
  sourceModule?: string;
};

export const cents = (amount: number | string | null | undefined): number =>
  Math.round(Number(amount ?? 0) * 100);

export const isCashReceipt = (row: ReceiptRow): boolean =>
  row.postingStatus === "POSTED" && row.voucherId != null && row.cashAccountId != null;

export const cashCents = (row: ReceiptRow): number => isCashReceipt(row) ? cents(row.amount) : 0;
export const nonCashCents = (row: ReceiptRow): number =>
  row.postingStatus === "SCHEDULED" || isCashReceipt(row) ? 0 : cents(row.amount);

export function receiptTotals(rows: ReceiptRow[]) {
  return rows.reduce(
    (totals, row) => {
      totals.cash += cashCents(row);
      totals.nonCash += nonCashCents(row);
      totals.scheduled += row.postingStatus === "SCHEDULED" ? cents(row.amount) : 0;
      totals.recorded += cents(row.amount);
      return totals;
    },
    { cash: 0, nonCash: 0, scheduled: 0, recorded: 0 }
  );
}

const month = (n: number | undefined) => n != null && n >= 1 && n <= 12 ? String(n).padStart(2, "0") : "";
const excelSafe = (value: unknown): string => {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  return /^[=+@-]/.test(text) ? "'" + text : text;
};

/** TSV is deliberately Excel-friendly: numeric receipt/adjustment columns and totals. */
export function paymentHistoryTsv(rows: ReceiptRow[]): string {
  const columns = [
    "Date", "Tenant", "Unit", "Location", "Cash Received (USD)",
    "Non-cash Adjustment (USD)", "For Month", "Notes", "Voucher", "Source",
  ];
  const lines = rows.map((row) => [
    String(row.paymentDate ?? "").slice(0, 10),
    excelSafe(row.tenantName),
    excelSafe(row.unitNumber),
    excelSafe(row.locationGroup),
    (cashCents(row) / 100).toFixed(2),
    (nonCashCents(row) / 100).toFixed(2),
    row.forYear != null ? row.forYear + "-" + month(row.forMonth) : "",
    excelSafe(row.notes),
    row.voucherId == null ? "No voucher" : "#" + row.voucherId,
    row.readOnly ? "Voucher-backed guarantee (read-only)" : excelSafe(row.sourceModule),
  ].join("\t"));
  const total = receiptTotals(rows);
  return [
    columns.join("\t"),
    ...lines,
    ["TOTAL", "", "", "", (total.cash / 100).toFixed(2), (total.nonCash / 100).toFixed(2), "", "", "", ""].join("\t"),
  ].join("\n");
}
