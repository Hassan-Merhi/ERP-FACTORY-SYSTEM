// Extracted from ./stockValuation.ts
import type Decimal from "decimal.js";

export const STOCK_VALUATION_LOCATION_SCOPE = "ALL_NON_DELETED_LOCATIONS" as const;

export interface LocationStockValue {
  locationId: number;
  locationName: string;
  active: boolean;
  /** Counted value of the location (policy above), 2dp. */
  value: string;
}

export interface StockValuationExclusions {
  /** Value of bale-mirror stock items (valued by the factory, not the ERP). */
  baleMirrorValue: string;
  /** Value left on soft-deleted locations of the company. */
  deletedLocationValue: string;
  /**
   * Provisional value of negative stock (negative): the value short issues
   * relieved at the cost memory, held on short rows until a receipt settles
   * them. Policy, not an anomaly; not counted in `total`.
   */
  shortageValue: string;
  /** Value stored on zero rows, or a positive value on a short row (not counted). */
  shortRowValue: string;
  /** Negative values stored on rows with a positive quantity (not counted). */
  negativeValue: string;
  /** Number of rows behind shortRowValue and negativeValue (shortage rows are not anomalous). */
  anomalousRows: number;
  /**
   * As of a past date only ("0.00" live): the value of evidenced movements
   * after the date that name no stock item, reversed (wave 15). Part of
   * `subLedgerTotal`, not of `total`.
   */
  unitemizedMovementValue: string;
}

export interface CompanyStockValuation {
  companyId: number;
  /** null for the live valuation, else the YYYY-MM-DD date it is as of. */
  asOf: string | null;
  scope: typeof STOCK_VALUATION_LOCATION_SCOPE;
  /** The stock value: active + inactive locations, negative stock not subtracting. */
  total: string;
  /**
   * Signed sub-ledger value (total + shortage + anomalies, deleted locations
   * and the bale mirror left out): what the perpetual INVENTORY account holds.
   */
  subLedgerTotal: string;
  activeLocationValue: string;
  inactiveLocationValue: string;
  /** Non-deleted locations, ordered by id. */
  locations: LocationStockValue[];
  excluded: StockValuationExclusions;
}

export type Accumulator = {
  total: Decimal;
  active: Decimal;
  inactive: Decimal;
  mirror: Decimal;
  deleted: Decimal;
  shortage: Decimal;
  shortRow: Decimal;
  negative: Decimal;
  anomalousRows: number;
  unitemized: Decimal;
};

export const money = (value: Decimal) => value.toDecimalPlaces(2).toFixed(2);

export function finish(
  companyId: number,
  asOf: string | null,
  acc: Accumulator,
  locations: LocationStockValue[]
): CompanyStockValuation {
  return {
    companyId,
    asOf,
    scope: STOCK_VALUATION_LOCATION_SCOPE,
    total: money(acc.total),
    subLedgerTotal: money(acc.total.plus(acc.shortage).plus(acc.shortRow).plus(acc.negative).plus(acc.unitemized)),
    activeLocationValue: money(acc.active),
    inactiveLocationValue: money(acc.inactive),
    locations,
    excluded: {
      baleMirrorValue: money(acc.mirror),
      deletedLocationValue: money(acc.deleted),
      shortageValue: money(acc.shortage),
      shortRowValue: money(acc.shortRow),
      negativeValue: money(acc.negative),
      anomalousRows: acc.anomalousRows,
      unitemizedMovementValue: money(acc.unitemized),
    },
  };
}

export type LiveRow = {
  location_id: number;
  location_name: string;
  active: boolean;
  deleted: boolean;
  mirror: boolean;
  counted: string;
  shortage: string;
  short_row: string;
  negative: string;
  anomalous_rows: number;
};
