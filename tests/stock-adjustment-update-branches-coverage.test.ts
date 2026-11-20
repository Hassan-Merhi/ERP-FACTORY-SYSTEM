/**
 * Stock adjustment edits (server/storage/stock-ops/updateStockAdjustment.ts)
 * in a rolled-back factory company: unknown adjustments and locations,
 * optional (draft) vouchers that never touch inventory, consumption with no
 * stock row (opening-rate costing, and the refusal without an opening rate),
 * a move to another location, a restored soft-deleted adjustment account,
 * unchanged production lines keeping their historical value, voucher header
 * changes and the caller's in-transaction audit hook.
 */
import { describe, expect, it, vi } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { createStockAdjustment } from "../server/storage/stock-ops/transfers-create";
import { updateStockAdjustment } from "../server/storage/stock-ops/updateStockAdjustment";

async function item(world: FactoryWorld, code: string, openingRate: string | null) {
  return world.one(
    `INSERT INTO stock_items (company_id, code, name, uom, opening_rate) VALUES ($1, $2::varchar, $2::text, 'kg', $3) RETURNING id`,
    [world.companyId, `${world.tag}-${code}`, openingRate]
  );
}

async function voucher(world: FactoryWorld, type: string, optional = false) {
  return world.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional, location_id)
     VALUES ($1, $2, $3, '2026-06-01', '0', $4, $5) RETURNING id`,
    [world.companyId, `${world.tag}-SA${Math.floor(Math.random() * 1e9)}`, type, optional, world.locationId]
  );
}

const inventory = async (world: FactoryWorld, locationId: number, stockItemId: number) =>
  (
    await world.q(
      `SELECT quantity::float AS q, total_value::float AS v FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
      [locationId, stockItemId]
    )
  )[0];

describe("updateStockAdjustment refusals", () => {
  it("refuses unknown adjustments and unknown target locations", () =>
    withFactoryWorld(async (world) => {
      await expect(updateStockAdjustment(2_000_000_000, world.locationId, "Production", "", [])).rejects.toThrow(
        "Stock adjustment 2000000000 not found"
      );
      const stock = await item(world, "A", "2");
      const created = await createStockAdjustment(
        await voucher(world, "Production"),
        world.locationId,
        "Production",
        "",
        [{ stockItemId: stock, quantity: "2", rate: "3" }]
      );
      await expect(
        updateStockAdjustment(created.adjustment.id, 2_000_000_000, "Production", "", [
          { stockItemId: stock, quantity: "2", rate: "3" },
        ])
      ).rejects.toThrow(/stock_adjustment_vouchers/);
      const foreignCompany = await world.one(
        `INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`,
        [`${world.tag}F`]
      );
      const foreignLocation = await world.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Elsewhere') RETURNING id`,
        [foreignCompany, `${world.tag}-FL`]
      );
      // Another company's location is refused by the inventory company guard; nothing moves.
      await expect(
        updateStockAdjustment(created.adjustment.id, foreignLocation, "Production", "", [
          { stockItemId: stock, quantity: "2", rate: "3" },
        ])
      ).rejects.toThrow(/does not belong to company/);
      const [row] = await world.q(`SELECT location_id FROM stock_adjustment_vouchers WHERE id = $1`, [
        created.adjustment.id,
      ]);
      expect(row.location_id).toBe(world.locationId);
    }));

  it("refuses a consumption with no stock row and no opening rate", () =>
    withFactoryWorld(async (world) => {
      const made = await item(world, "M", "1");
      const bare = await item(world, "B", null);
      const created = await createStockAdjustment(
        await voucher(world, "Production"),
        world.locationId,
        "Production",
        "",
        [{ stockItemId: made, quantity: "1", rate: "1" }]
      );
      await expect(
        updateStockAdjustment(created.adjustment.id, world.locationId, "Consumption", "", [
          { stockItemId: bare, quantity: "-2", rate: "1" },
        ])
      ).rejects.toThrow(/has no opening rate set/);
    }));
});

describe("updateStockAdjustment edits", () => {
  it("edits a draft without touching inventory or the ledger", () =>
    withFactoryWorld(async (world) => {
      const stock = await item(world, "D", "2");
      const draftVoucher = await voucher(world, "Production", true);
      const created = await createStockAdjustment(draftVoucher, world.locationId, "Production", "draft", [
        { stockItemId: stock, quantity: "1", rate: "5" },
      ]);
      const result = await updateStockAdjustment(created.adjustment.id, world.locationId, "Production", "draft 2", [
        { stockItemId: stock, quantity: "4", rate: "5" },
      ]);
      expect(result.items[0]).toMatchObject({ valueMoved: null, totalAmount: "20.00" });
      expect(await inventory(world, world.locationId, stock)).toBeUndefined();
      expect(await world.q(`SELECT id FROM voucher_entries WHERE voucher_id = $1`, [draftVoucher])).toHaveLength(0);
    }));

  it("costs a consumption without a stock row at the opening rate and restores a deleted adjustment account", () =>
    withFactoryWorld(async (world) => {
      const made = await item(world, "P", "1");
      const consumed = await item(world, "C", "4");
      const v = await voucher(world, "Production");
      const created = await createStockAdjustment(v, world.locationId, "Production", "", [
        { stockItemId: made, quantity: "1", rate: "1" },
      ]);
      await world.q(`UPDATE ledger_accounts SET active = false WHERE company_id = $1 AND code = 'STOCK_ADJUSTMENT'`, [
        world.companyId,
      ]);
      const audit = vi.fn(async () => undefined);
      const result = await updateStockAdjustment(
        created.adjustment.id,
        world.locationId,
        "Consumption",
        "used",
        [{ stockItemId: consumed, quantity: "-3", rate: "9" }],
        { voucherDate: "2026-06-05", description: "Re-dated" },
        audit
      );
      expect(result.items[0]).toMatchObject({ rate: expect.stringMatching(/^4\.0*$/), totalAmount: "12.00" });
      expect(result.voucher).toMatchObject({ voucherDate: "2026-06-05", description: "Re-dated" });
      expect(audit).toHaveBeenCalledWith(expect.anything(), result);
      const [account] = await world.q(
        `SELECT active FROM ledger_accounts WHERE company_id = $1 AND code = 'STOCK_ADJUSTMENT'`,
        [world.companyId]
      );
      expect(account.active).toBe(true);
      expect((await inventory(world, world.locationId, consumed)).q).toBe(-3);
    }));

  it("keeps an unchanged production line's historical value and re-costs a moved adjustment", () =>
    withFactoryWorld(async (world) => {
      const stock = await item(world, "H", "1");
      const v = await voucher(world, "Production");
      const created = await createStockAdjustment(v, world.locationId, "Production", "", [
        { stockItemId: stock, quantity: "3", rate: "1.115" },
      ]);
      const same = await updateStockAdjustment(created.adjustment.id, world.locationId, "Production", "again", [
        { stockItemId: stock, quantity: "3", rate: "1.115" },
      ]);
      expect(same.items[0].totalAmount).toBe(created.items[0].totalAmount);

      const otherLocation = await world.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Annex') RETURNING id`,
        [world.companyId, `${world.tag}-L2`]
      );
      const moved = await updateStockAdjustment(created.adjustment.id, otherLocation, "Production", "moved", [
        { stockItemId: stock, quantity: "3", rate: "2" },
      ]);
      expect(moved.adjustment.locationId).toBe(otherLocation);
      expect(moved.items[0].totalAmount).toBe("6.00");
      expect((await inventory(world, otherLocation, stock)).q).toBe(3);
      expect((await inventory(world, world.locationId, stock)).q).toBe(0);
    }));
});
