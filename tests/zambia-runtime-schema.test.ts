/**
 * Zambia native-Kwacha purchase cost schema.
 *
 * The columns and the NOT VALID evidence constraint used to be added at boot by
 * ensureZambiaHistoricalPurchaseCost (server/startup/). Migrations now define
 * them and startup only verifies the schema, so they are asserted against the
 * schema manifest.
 */
import { describe, expect, it } from "vitest";

import { hasColumn, manifestEntry } from "./helpers/schemaManifest";

const PURCHASE_ORDER_COLUMNS = [
  "historical_exchange_rate",
  "historical_rate_date",
  "native_discount",
  "native_document_charges",
  "native_freight",
  "native_fumigation",
  "native_items_total",
  "native_line_count",
  "native_other_charges",
  "native_surcharge",
];
const LINE_COLUMNS = ["native_line_total", "native_rate"];

describe("Zambia purchase cost schema", () => {
  it("defines the native-Kwacha columns on purchase orders and their lines", () => {
    for (const column of PURCHASE_ORDER_COLUMNS) {
      expect(hasColumn("purchase_orders", column), column).toBe(true);
    }
    for (const column of LINE_COLUMNS) {
      expect(hasColumn("po_line_items", column), column).toBe(true);
    }
  });

  it("refuses a Kwacha order without its evidence, without validating historical rows", () => {
    const constraint = manifestEntry("constraint", "public.purchase_orders.purchase_orders_zmw_historical_rate_ck")
      ?.def as { def: string; validated: boolean } | undefined;
    // NOT VALID: existing (USD) rows are never scanned or rewritten.
    expect(constraint?.validated).toBe(false);
    expect(constraint?.def).toContain("upper(currency) <> 'ZMW'::text OR historical_exchange_rate > 0::numeric");
    for (const column of PURCHASE_ORDER_COLUMNS.filter((name) => name.startsWith("native_") && name !== "native_line_count")) {
      expect(constraint?.def).toContain(`${column} IS NOT NULL`);
    }
    expect(constraint?.def).toContain("native_line_count > 0");
    expect(constraint?.def).toContain("historical_rate_date IS NOT NULL");
  });
});
