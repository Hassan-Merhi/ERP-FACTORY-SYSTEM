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
  currency?: string | null;
};

export const cents = (amount: number | string | null | undefined): number => Math.round(Number(amount ?? 0) * 100);

export const isCashReceipt = (row: ReceiptRow): boolean =>
  row.postingStatus === "POSTED" && row.voucherId != null && row.cashAccountId != null;

export const cashCents = (row: ReceiptRow): number => (isCashReceipt(row) ? cents(row.amount) : 0);
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

/**
 * Build the same balance-based split for Rentals and the Payments Log.
 * Amounts are signed integer cents from posted ledger statements, not
 * voucher amounts created or adjusted by this calculation.
 */
export function propertiesAccountBalanceSplit(
  historicalWithdrawal: number | null,
  tenantDeposits: number | null,
  aliCash: number | null,
  propertiesCashbox: number | null = 0
) {
  const rentAndCashBalance =
    historicalWithdrawal !== null && aliCash !== null && propertiesCashbox !== null
      ? historicalWithdrawal + aliCash + propertiesCashbox
      : null;
  const accountSum =
    rentAndCashBalance !== null && tenantDeposits !== null ? rentAndCashBalance + tenantDeposits : null;
  return { rentAndCashBalance, depositBalance: tenantDeposits, accountSum };
}

/**
 * Bridge a complete, unfiltered Properties payment history to the requested
 * sum of account balances. This is an accounting *presentation*, not cash:
 * the same GUAR voucher posts both a cash debit and a deposit-liability credit.
 *
 * The bridge consists only of independently identifiable source facts.
 * Never plug the remainder of an account discrepancy into an invented receipt.
 */
export function accountBalanceHistoryBridge(
  rows: ReceiptRow[],
  cashLedgerIds: number | readonly number[] | null | undefined
) {
  const history = receiptTotals(rows);
  const ledgerIds =
    cashLedgerIds == null ? null : new Set<number>(typeof cashLedgerIds === "number" ? [cashLedgerIds] : cashLedgerIds);
  const cashAndLiabilityOverlap =
    ledgerIds === null
      ? null
      : rows
          .filter(
            (row) =>
              row.receiptKind === "GUARANTEE_DEPOSIT" &&
              row.cashAccountId != null &&
              ledgerIds.has(row.cashAccountId) &&
              isCashReceipt(row)
          )
          .reduce((sum, row) => sum + cents(row.amount), 0);
  const removeNonCashBilling = history.nonCash;
  const netAdjustment = cashAndLiabilityOverlap === null ? null : cashAndLiabilityOverlap - removeNonCashBilling;
  const reconciledTotal = netAdjustment === null ? null : history.recorded + netAdjustment;
  return {
    history,
    cashAndLiabilityOverlap,
    removeNonCashBilling,
    netAdjustment,
    reconciledTotal,
  };
}

export type HistoryReconciliationExport = {
  aliCashLedgerId: number;
  cashboxLedgerId?: number | null;
  threeAccountsTotal: number;
};

/**
 * Export source history and separate account-bridge lines. No synthetic receipt
 * is inserted among dated payments. Three-account total is fetched separately;
 * the residual must be zero for the history to be fully reconciled.
 */
export function reconciledHistoryTsv(rows: ReceiptRow[], snapshot: HistoryReconciliationExport): string {
  assertUsdHistoryExport(rows);
  const bridge = accountBalanceHistoryBridge(rows, [
    snapshot.aliCashLedgerId,
    ...(snapshot.cashboxLedgerId == null ? [] : [snapshot.cashboxLedgerId]),
  ]);
  const base = paymentHistoryTsv(rows);
  const totals = bridge.history;
  const fmt = (amount: number | null) => (amount === null ? "" : (amount / 100).toFixed(2));
  const bridgeLine = (label: string, description: string, amount: number | null) => [
    label,
    "",
    "",
    "",
    "",
    "",
    "",
    description,
    "",
    "",
    fmt(amount),
  ];
  const historyLine = [
    "RECORDED HISTORY TOTAL",
    "",
    "",
    "",
    fmt(totals.cash),
    fmt(totals.nonCash),
    "",
    "Gross history = cash + non-cash",
    "",
    "",
    "",
  ];
  const tail = [
    historyLine,
    bridgeLine(
      "ACCOUNT RECONCILIATION: GUARANTEE OVERLAP",
      "Cash debit and deposit liability credit of the same voucher; not another payment",
      bridge.cashAndLiabilityOverlap
    ),
    bridgeLine(
      "ACCOUNT RECONCILIATION: REMOVE NON-CASH BILLING",
      "Billing allocation already included in history; not new cash",
      -bridge.removeNonCashBilling
    ),
    bridgeLine("NET RECONCILIATION ADJUSTMENT", "Source classifications only; no journal posted", bridge.netAdjustment),
    bridgeLine(
      "RECONCILED HISTORY + ADJUSTMENT",
      "Recorded history plus net reconciliation adjustment",
      bridge.reconciledTotal
    ),
    bridgeLine(
      "TRACKED ACCOUNT BALANCES",
      "HP Rental Withdrawal + Tenant Deposits + ALI KOLWEZI RENT CASH" +
        (snapshot.cashboxLedgerId == null ? "" : " + Properties Rent Cashbox"),
      snapshot.threeAccountsTotal
    ),
    bridgeLine(
      "UNRECONCILED DIFFERENCE",
      "Tracked account balances minus reconciled history",
      bridge.reconciledTotal === null ? null : snapshot.threeAccountsTotal - bridge.reconciledTotal
    ),
  ];
  // Add a separate reconciliation column, so bridge lines never masquerade
  // as payments or change what the cash/adjustment columns sum to.
  const lines = base.split("\n");
  const [header, ...historyLines] = lines;
  return [
    header + "\tAccount Reconciliation (USD)",
    ...historyLines.slice(0, -1).map((line) => line + "\t0.00"),
    ...tail.map((line) => line.join("\t")),
  ].join("\n");
}

const month = (n: number | undefined) => (n != null && n >= 1 && n <= 12 ? String(n).padStart(2, "0") : "");
const excelSafe = (value: unknown): string => {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return /^[=+@-]/.test(text) ? "'" + text : text;
};

/** Exports name their numeric columns USD; non-USD must never be silently relabeled. */
function assertUsdHistoryExport(rows: readonly ReceiptRow[]): void {
  if (rows.some((row) => row.currency?.trim() && row.currency.trim().toUpperCase() !== "USD")) {
    throw new Error("Cannot export mixed-currency payment history as USD without booked conversion");
  }
}

/** TSV is deliberately Excel-friendly: numeric receipt/adjustment columns and totals. */
export function paymentHistoryTsv(rows: ReceiptRow[]): string {
  assertUsdHistoryExport(rows);
  const columns = [
    "Date",
    "Tenant",
    "Unit",
    "Location",
    "Cash Received (USD)",
    "Non-cash Adjustment (USD)",
    "For Month",
    "Notes",
    "Voucher",
    "Source",
  ];
  const lines = rows.map((row) =>
    [
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
    ].join("\t")
  );
  const total = receiptTotals(rows);
  return [
    columns.join("\t"),
    ...lines,
    ["TOTAL", "", "", "", (total.cash / 100).toFixed(2), (total.nonCash / 100).toFixed(2), "", "", "", ""].join("\t"),
  ].join("\n");
}
