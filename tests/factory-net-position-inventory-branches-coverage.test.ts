/**
 * computeNetPositionInventory (server/routes/factory/employee-pos/netPositionInventory.ts)
 * against a real company inside one rolled-back transaction (withFactoryWorld): container stock
 * valued at the context's locked rate, unattached containers at their own USD
 * cost, a manual-only supplier at its legacy locked rate after ADD (USD and
 * non-USD), usage, skipped DEDUCT and completed-batch draw-downs, manual
 * buckets drawn to zero, the stock-on-the-water currency buckets and the
 * blended selling Balance on Table.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld } from "./helpers/rolledBackFactoryApp";
import { computeNetPositionInventory } from "../server/routes/factory/employee-pos/netPositionInventory";

const AS_OF = "2026-03-31";

describe("net position inventory branches", () => {
  it("values raw material, OTW and Balance on Table from every adjustment path", () =>
    withFactoryWorld(async (w) => {
      // The world's own factory company; its Admin login is not used here.
      const { q, one, companyId, tag } = w;
      const supplier = (name: string, rate: string | null) =>
        one(
          `INSERT INTO factory_suppliers (company_id, name, current_raw_material_cost_per_kg_usd) VALUES ($1, $2, $3) RETURNING id`,
          [companyId, name, rate]
        );
      const a = await supplier("Container A", null);
      const b = await supplier("Manual B", "1.5");
      const c = await supplier("Usage only C", "9");
      const d = await supplier("Batch only D", "9");

      const container = (supplierId: number | null, currency: string) =>
        one(
          `INSERT INTO factory_containers (company_id, container_number, supplier_id, status, currency_code)
           VALUES ($1, $2, $3, 'OFFLOADED', $4) RETURNING id`,
          [companyId, `${tag}-${supplierId ?? "U"}-${currency}`, supplierId, currency]
        );
      const stock = (containerId: number, recv: string, used: string, cpk: string, cpkUsd: string | null) =>
        q(
          `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [companyId, containerId, recv, used, cpk, cpkUsd]
        );
      await stock(await container(a, "USD"), "100", "20", "2", null);
      await stock(await container(null, "EUR"), "10", "0", "4", "5");
      await stock(await container(null, "AUD"), "10", "0", "4", null);

      const adjust = (
        supplierId: number | null,
        type: string,
        kg: string,
        cpk: string,
        currency: string,
        label: string | null
      ) =>
        q(
          `INSERT INTO factory_raw_material_adjustments (company_id, supplier_id, type, kg, cost_per_kg, currency_code, material_label, date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-03-01')`,
          [companyId, supplierId, type, kg, cpk, currency, label]
        );
      await adjust(b, "ADD", "100", "3", "USD", null);
      await adjust(b, "ADD", "50", "9", "EUR", null);
      await adjust(b, "USAGE", "30", "0", "USD", null);
      await adjust(b, "DEDUCT", "999", "0", "USD", null);
      await adjust(c, "USAGE", "5", "0", "USD", null);
      await adjust(null, "ADD", "10", "2", "USD", null);
      await adjust(null, "USAGE", "10", "0", "USD", null);
      await adjust(null, "USAGE", "5", "0", "USD", null);
      await adjust(null, "ADD", "0", "1", "USD", "Cotton");
      await adjust(null, "ADD", "0", "1", "USD", "Cotton");

      const batch = (status: string, kg: string, cost: string) =>
        one(
          `INSERT INTO factory_mix_batches (company_id, status, total_weight_kg, total_cost, batch_date, batch_number)
           VALUES ($1, $2, $3, $4, '2026-03-02', $5) RETURNING id`,
          [companyId, status, kg, cost, `${tag}-${status}`]
        );
      const completed = await batch("COMPLETED", "1000", "500");
      const open = await batch("OPEN", "0", "0");
      const source = (batchId: number, supplierId: number, kg: string) =>
        q(`INSERT INTO factory_mix_batch_sources (mix_batch_id, supplier_id, weight_kg) VALUES ($1, $2, $3)`, [
          batchId,
          supplierId,
          kg,
        ]);
      await source(completed, a, "5");
      await source(completed, b, "20");
      await source(completed, d, "7");
      await source(open, a, "3");

      const product = await one(
        `INSERT INTO factory_bale_products (company_id, code, name, production_price, selling_price)
         VALUES ($1, $2, 'Grade A', 100, 300) RETURNING id`,
        [companyId, `${tag}P`]
      );
      await q(
        `INSERT INTO factory_bales (company_id, reference_number, bale_code, weight_kg, status, product_id, stock_entry_date)
         VALUES ($1, $2, $2, 200, 'IN_STOCK', $3, '2026-03-05')`,
        [companyId, `${tag}B`, product]
      );

      const containers = [
        { status: null },
        { status: "OFFLOADED", finalPayableAmount: "999" },
        {
          status: "PENDING",
          currencyCode: null,
          finalPayableAmount: "100",
          freight: "10",
          freightCurrencyCode: null,
          commissionAmount: "5",
          commissionCurrencyCode: null,
          otherCharges: "2",
        },
        {
          status: "IN_TRANSIT",
          currencyCode: "EUR",
          finalPayableAmount: null,
          ratePerKg: "2",
          totalKg: "10",
          freight: "0",
          freightCurrencyCode: "USD",
          commissionAmount: "0",
          commissionCurrencyCode: "EUR",
          otherCharges: null,
        },
      ];
      const inventory = await computeNetPositionInventory({
        companyId,
        asOf: AS_OF,
        getConfigFx: (cc) => (cc === "EUR" ? 1.1 : 1),
        configFxRates: { EUR: 1.1 },
        supplierLockedRateMapNp: new Map([[a, 2.5]]),
        allContainersF: containers as never,
      });

      // A: 80 kg x 2.5 = 200; unattached EUR row 10 kg x USD 5 = 50, AUD row unvalued;
      // B: 150 - 30 - 20 = 100 kg x legacy 1.5 = 150; manual buckets drawn to 0.
      expect(inventory.rawMaterialStockValue).toBe(400);
      // USD 100 + 10 + 5 + 2, EUR 20 x 1.1.
      expect(inventory.stockOtwValue).toBe(139);
      expect(inventory.inventorySellValue).toBe(100);
      expect(inventory.inventorySellingValue).toBe(300);
      // 1000 kg mixed - 200 kg baled = 800 kg at 0.5; selling at 300 / 200 kg = 1.5.
      expect(inventory.balanceOnTableValue).toBe(400);
      expect(inventory.balanceOnTableSellingValue).toBe(1200);
      expect(inventory).toMatchObject({ reservedBaleCount: 0, reservedBaleCost: 0 });
    }));
});
