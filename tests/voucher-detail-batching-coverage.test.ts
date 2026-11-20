/**
 * server/routes/vouchers/voucherDetailBatching.ts: the related-data loader
 * behind GET /api/vouchers/:id. Covers each voucher-type branch (purchase,
 * sales, adjustment, transfer, other), the "no detail row" fallbacks, the
 * configured-price fallback to location prices, and missing names. Rows live
 * in one rolled-back transaction.
 */
import { describe, expect, it } from "vitest";

import { loadVoucherRelatedData } from "../server/routes/vouchers/voucherDetailBatching";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { item, voucher } from "./helpers/voucherReadFixture";

type VoucherArg = Parameters<typeof loadVoucherRelatedData>[0];

function header(w: FactoryWorld, id: number, voucherType: string, extra: Partial<VoucherArg> = {}): VoucherArg {
  return {
    id,
    description: null,
    createdAt: new Date(),
    companyId: w.companyId,
    locationId: null,
    optional: false,
    exchangeRate: null,
    currency: "USD",
    effectiveDate: null,
    deletedAt: null,
    locationName: null,
    voucherNumber: `V${id}`,
    voucherType,
    voucherDate: "2026-05-01",
    totalAmount: "0",
    shiftId: null,
    sourceModule: null,
    isCreditSale: null,
    clientSaleId: null,
    ...extra,
  };
}

describe("loadVoucherRelatedData", () => {
  it("returns all-null data for an unrelated voucher type and a purchase voucher without a PO", async () => {
    await withFactoryWorld(async (w) => {
      const journal = await voucher(w, "Journal");
      expect(await loadVoucherRelatedData(header(w, journal, "Journal"))).toEqual({
        purchaseOrder: null,
        salesItems: null,
        adjustmentData: null,
        transferData: null,
      });
      const purchase = await voucher(w, "Purchase");
      expect((await loadVoucherRelatedData(header(w, purchase, "Purchase"))).purchaseOrder).toBeNull();
    });
  });

  it("loads the purchase order with its line items, scoped to the voucher company", async () => {
    await withFactoryWorld(async (w) => {
      const supplierId = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Supp', 's@x.test') RETURNING id`,
        [w.companyId, `${w.tag}S`]
      );
      const containerId = await w.one(
        `INSERT INTO containers (company_id, container_number, import_date, supplier_id) VALUES ($1, $2, '2026-05-01', $3) RETURNING id`,
        [w.companyId, `${w.tag}C`, supplierId]
      );
      const purchase = await voucher(w, "Purchase");
      const stock = await item(w, "Jeans");
      const poId = await w.one(
        `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id, voucher_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [w.companyId, containerId, `${w.tag}PO`, supplierId, purchase]
      );
      await w.q(
        `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total) VALUES ($1, $2, 'Jeans', 2, 5, 10)`,
        [poId, stock]
      );
      const result = await loadVoucherRelatedData(header(w, purchase, "Purchase"));
      expect(result.purchaseOrder?.id).toBe(poId);
      expect(result.purchaseOrder?.items).toHaveLength(1);

      const foreign = await loadVoucherRelatedData(
        header(w, purchase, "Purchase", { companyId: w.companyId + 100000 })
      );
      expect(foreign.purchaseOrder).toBeNull();
    });
  });

  it("returns null sales items when a sales voucher has no lines", async () => {
    await withFactoryWorld(async (w) => {
      const sale = await voucher(w, "Sales");
      expect((await loadVoucherRelatedData(header(w, sale, "Sales"))).salesItems).toBeNull();
    });
  });

  it("enriches sales lines with names and the configured or location price", async () => {
    await withFactoryWorld(async (w) => {
      const sale = await voucher(w, "Sales", { locationId: w.locationId });
      const shirt = await item(w, "Shirt");
      const cap = await item(w, "Cap");
      await w.q(
        `INSERT INTO stock_item_location_prices (stock_item_id, location_id, selling_price) VALUES ($1, $2, 8)`,
        [cap, w.locationId]
      );
      const addLine = (stockItemId: number, configured: string | null, price: string) =>
        w.q(
          `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, configured_price, cost_price, total_sales, total_cost, profit)
           VALUES ($1, $2, 2, $3, $4, 1, $3::numeric * 2, 2, 0)`,
          [sale, stockItemId, price, configured]
        );
      await addLine(shirt, "10", "12");
      await addLine(cap, "0", "10");
      await addLine(cap, null, "10");

      const withLocation = await loadVoucherRelatedData(header(w, sale, "Sales", { locationId: w.locationId }));
      const rows = withLocation.salesItems ?? [];
      expect(rows.map((r) => [r.stockItemName, r.stockItemUom, String(r.configuredPrice)])).toEqual([
        ["Shirt", "PCS", "10.000000"],
        // configured_price is numeric(15,6): a stored zero reads back as
        // "0.000000" and still falls back to the location price.
        ["Cap", "PCS", "8.00"],
        ["Cap", "PCS", "8.00"],
      ]);
      expect(rows[0]).toMatchObject({ hassansProfit: "4.00", hassansTotal: "20.00", hassansPercentage: "20.0" });
      expect(rows[1]).toMatchObject({ hassansProfit: "4.00", hassansTotal: "16.00", hassansPercentage: "25.0" });

      const noLocation = await loadVoucherRelatedData(header(w, sale, "Sales"));
      const fallback = (noLocation.salesItems ?? [])[2];
      expect(fallback).toMatchObject({ configuredPrice: "0", hassansTotal: "0.00", hassansPercentage: "0.0" });
      // A stored zero with no location price falls back to "0" as well.
      expect((noLocation.salesItems ?? [])[1]).toMatchObject({ configuredPrice: "0", hassansTotal: "0.00" });
    });
  });

  it("builds adjustment fallbacks per voucher type when no adjustment row exists", async () => {
    await withFactoryWorld(async (w) => {
      const types: Array<[string, string]> = [
        ["Consumption", "consumption"],
        ["Mixed", "mixed"],
        ["Production", "production"],
      ];
      for (const [type, expected] of types) {
        const id = await voucher(w, type);
        const data = (await loadVoucherRelatedData(header(w, id, type, { description: "note" }))).adjustmentData;
        expect(data).toMatchObject({ id: 0, adjustmentType: expected, locationId: 1, notes: "note", items: [] });
      }
      const located = await voucher(w, "Mixed");
      const data = (await loadVoucherRelatedData(header(w, located, "Mixed", { locationId: w.locationId })))
        .adjustmentData;
      expect(data).toMatchObject({ locationId: w.locationId, notes: "" });
    });
  });

  it("loads adjustment items with stock and location names, blank for unknown items", async () => {
    await withFactoryWorld(async (w) => {
      const id = await voucher(w, "Production");
      const stock = await item(w, "Bale");
      const adjustmentId = await w.one(
        `INSERT INTO stock_adjustment_vouchers (voucher_id, location_id, adjustment_type) VALUES ($1, $2, 'production') RETURNING id`,
        [id, w.locationId]
      );
      await w.q(
        `INSERT INTO stock_adjustment_items (adjustment_id, stock_item_id, quantity, rate, total_amount) VALUES ($1, $2, 1, 2, 2)`,
        [adjustmentId, stock]
      );
      const data = (await loadVoucherRelatedData(header(w, id, "Production"))).adjustmentData;
      expect(data).toMatchObject({ id: adjustmentId, locationName: "Yard" });
      expect(data?.items).toEqual([expect.objectContaining({ stockItemName: "Bale", stockItemUom: "PCS" })]);
    });
  });

  it("builds a transfer fallback and loads transfer items with per-line source names", async () => {
    await withFactoryWorld(async (w) => {
      const empty = await voucher(w, "Transfer");
      expect((await loadVoucherRelatedData(header(w, empty, "Transfer"))).transferData).toMatchObject({
        id: 0,
        sourceLocationId: 1,
        destinationLocationId: 1,
        items: [],
      });

      const shop = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`, [
        w.companyId,
        `${w.tag}SH`,
      ]);
      const store = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Store') RETURNING id`,
        [w.companyId, `${w.tag}ST`]
      );
      const stock = await item(w, "Shirt");
      const id = await voucher(w, "Stock Transfer");
      const transferId = await w.one(
        `INSERT INTO stock_transfer_vouchers (voucher_id, source_location_id, destination_location_id) VALUES ($1, $2, $3) RETURNING id`,
        [id, w.locationId, shop]
      );
      await w.q(
        `INSERT INTO stock_transfer_items (transfer_id, stock_item_id, quantity, rate, total_amount, source_location_id)
         VALUES ($1, $2, 1, 1, 1, $3), ($1, $2, 1, 1, 1, NULL)`,
        [transferId, stock, store]
      );
      const data = (await loadVoucherRelatedData(header(w, id, "StockTransfer"))).transferData;
      expect(data).toMatchObject({ sourceLocationName: "Yard", destinationLocationName: "Shop" });
      expect(data?.items.map((row) => row.sourceLocationName)).toEqual(["Store", "Yard"]);

      const noSource = await voucher(w, "Transfer");
      await w.q(`INSERT INTO stock_transfer_vouchers (voucher_id, destination_location_id) VALUES ($1, $2)`, [
        noSource,
        shop,
      ]);
      const bare = (await loadVoucherRelatedData(header(w, noSource, "Transfer"))).transferData;
      expect(bare).toMatchObject({ sourceLocationName: "", destinationLocationName: "Shop", items: [] });
    });
  });
});
