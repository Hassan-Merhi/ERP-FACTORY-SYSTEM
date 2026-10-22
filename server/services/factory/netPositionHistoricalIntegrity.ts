/**
 * Phase 8 - structural integrity checks for historical Factory Net Position.
 *
 * The check does not assert that legacy records are complete. It prevents a
 * numerically inconsistent report from being delivered as a historical 200.
 * The query/migration evidence report supplies the separate provenance status.
 */
import { MoneyDecimal, toMoney } from "../../lib/money";
import { sumPositionRows, type HistoricalPositionRow, type HistoricalPositionReport } from "./netPositionReportTotals";

type DatedOrder = { grandTotal: number };
type HistoricalResponse<R extends HistoricalPositionRow> = HistoricalPositionReport<R> & {
  inventoryValue: number;
  rawMaterialValue: number;
  balanceOnTableValue: number;
  stockOtwValue: number;
  supplierLiabilities: number;
  supplierOverpayments: number;
  payrollPayable: number;
  pendingOrders: DatedOrder[];
  verifiedOrders: DatedOrder[];
  loadingOrders: DatedOrder[];
  pendingTotal: number;
  verifiedTotal: number;
  loadingTotal: number;
};

const cents = (value: string | number) => toMoney(value).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toNumber();

const sum = (items: readonly { grandTotal: number }[]) =>
  cents(
    items
      .reduce((amount, item) => {
        if (!Number.isFinite(item.grandTotal)) throw new Error("HISTORICAL_INTEGRITY_NONFINITE_ORDER");
        return amount.plus(toMoney(item.grandTotal));
      }, new MoneyDecimal(0))
      .toFixed()
  );

const rowTotal = (rows: readonly HistoricalPositionRow[], code: string) =>
  sumPositionRows(rows.filter((row) => row.code === code));

const equal = (actual: number, expected: number, field: string) => {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || cents(actual) !== cents(expected)) {
    throw new Error(`HISTORICAL_INTEGRITY_MISMATCH:${field}`);
  }
};

/** Run only on a previously date-scoped and reconciled historical response. */
export function assertHistoricalReportIntegrity<R extends HistoricalPositionRow>(report: HistoricalResponse<R>): void {
  equal(report.forUs.total, sumPositionRows(report.forUs.accounts), "forUsRows");
  equal(report.onUs.total, sumPositionRows(report.onUs.accounts), "onUsRows");
  equal(report.forUs.total, report.forUsTotal, "forUsHeader");
  equal(report.onUs.total, report.onUsTotal, "onUsHeader");
  equal(
    report.netPosition,
    cents(toMoney(report.forUsTotal).minus(toMoney(report.onUsTotal)).toFixed()),
    "netPosition"
  );
  equal(
    report.forUs.breakdown.reduce((v, b) => v + b.value, 0),
    report.forUsTotal,
    "assetCategories"
  );
  equal(
    report.onUs.breakdown.reduce((v, b) => v + b.value, 0),
    report.onUsTotal,
    "liabilityCategories"
  );

  equal(rowTotal(report.forUs.accounts, "INVENTORY"), report.inventoryValue, "inventory");
  equal(rowTotal(report.forUs.accounts, "RAW_MATERIAL"), report.rawMaterialValue, "rawMaterial");
  equal(rowTotal(report.forUs.accounts, "BALANCE_ON_TABLE"), report.balanceOnTableValue, "balanceOnTable");
  equal(rowTotal(report.onUs.accounts, "EMPLOYEE_PAYROLL_PAYABLE"), report.payrollPayable, "payroll");

  equal(sum(report.pendingOrders), report.pendingTotal, "pendingOrderDetails");
  equal(sum(report.verifiedOrders), report.verifiedTotal, "verifiedOrderDetails");
  equal(sum(report.loadingOrders), report.loadingTotal, "loadingOrderDetails");
  equal(rowTotal(report.forUs.accounts, "VERIFIED_ORDERS"), report.verifiedTotal, "verifiedOrderAsset");
  equal(rowTotal(report.forUs.accounts, "LOADING_ORDERS"), report.loadingTotal, "loadingOrderAsset");
  equal(rowTotal(report.forUs.accounts, "STOCK_OTW"), report.stockOtwValue, "otw");

  equal(rowTotal(report.onUs.accounts, "SUPPLIER"), report.supplierLiabilities, "supplierPayables");
  equal(rowTotal(report.forUs.accounts, "SUPPLIER_OVERPAID"), report.supplierOverpayments, "supplierOverpayments");
}
