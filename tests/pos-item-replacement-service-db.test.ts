/**
 * POS item replacement against PostgreSQL. The sale-edit engine, accounting
 * context and audit writer are stubbed so the case can check what this
 * service validates, locks and asks them to do; the sale and stock rows are
 * real, in a rolled-back transaction that every database call is routed to.
 */
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const h = vi.hoisted(() => ({
  context: { context: { spAccounting: true } } as unknown,
  update: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../server/services/pos/edit/posEditSaleHelpers", () => ({
  fetchSpEditAccountingContext: async () => h.context,
}));
vi.mock("../server/services/pos/edit/updateSaleService", () => ({
  applyPosSaleUpdateTx: (...args: unknown[]) => h.update(...args),
}));
vi.mock("../server/routes/helpers/auditHelpers", () => ({ logAudit: (...args: unknown[]) => h.audit(...args) }));

import {
  applyPosItemReplacements,
  listPosItemReplacementCandidates,
  type PosItemReplacementActor,
} from "../server/services/pos/itemReplacementService";

let seq = 0;

async function id(client: PoolClient, text: string, values: unknown[]): Promise<number> {
  return Number((await client.query<{ id: number }>(text, values)).rows[0].id);
}

async function seed(client: PoolClient) {
  const tag = `PIR${process.pid}${++seq}`;
  const companyId = await id(client, "INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [tag, tag]);
  const otherCompanyId = await id(client, "INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [
    `${tag}X`,
    `${tag}X`,
  ]);
  const location = (code: string) =>
    id(client, "INSERT INTO locations(company_id,code,name) VALUES($1,$2,$3) RETURNING id", [
      companyId,
      `${tag}-${code}`,
      code,
    ]);
  const item = (code: string, extra: { deleted?: boolean; companyId?: number } = {}) =>
    id(client, "INSERT INTO stock_items(company_id,code,name,uom,deleted_at) VALUES($1,$2,$3,'Bale',$4) RETURNING id", [
      extra.companyId ?? companyId,
      `${tag}-${code}`,
      `${code} bale`,
      extra.deleted ? new Date() : null,
    ]);
  const shop = await location("Shop");
  const depot = await location("Depot");
  const rice = await item("RICE");
  const beans = await item("BEANS");
  const maize = await item("MAIZE");
  const retired = await item("OLD", { deleted: true });
  const foreign = await item("FOREIGN", { companyId: otherCompanyId });

  async function sale(
    lines: Array<[number, number, number]>,
    v: {
      date?: string;
      locationId?: number;
      type?: string;
      deleted?: boolean;
      description?: string;
      credit?: boolean;
    } = {}
  ) {
    const voucherId = await id(
      client,
      `INSERT INTO vouchers(company_id,voucher_number,voucher_type,voucher_date,total_amount,currency,location_id,deleted_at,description,is_credit_sale)
       VALUES($1,$2,$3,$4,0,'USD',$5,$6,$7,$8) RETURNING id`,
      [
        companyId,
        `${tag}-S${++seq}`,
        v.type ?? "Sales",
        v.date ?? "2026-03-10",
        v.locationId ?? shop,
        v.deleted ? new Date() : null,
        v.description ?? "Counter sale",
        v.credit ?? false,
      ]
    );
    const itemIds: number[] = [];
    for (const [stockItemId, quantity, price] of lines) {
      itemIds.push(
        await id(
          client,
          `INSERT INTO sales_items(voucher_id,stock_item_id,quantity,selling_price,cost_price,total_sales,total_cost,profit)
           VALUES($1,$2,$3,$4,0,$5,0,$5) RETURNING id`,
          [voucherId, stockItemId, quantity, price, quantity * price]
        )
      );
    }
    return { voucherId, itemIds };
  }

  return { tag, companyId, shop, depot, rice, beans, maize, retired, foreign, sale };
}

const actor = (
  w: Awaited<ReturnType<typeof seed>>,
  over: Partial<PosItemReplacementActor> = {}
): PosItemReplacementActor => ({
  companyId: w.companyId,
  locationId: w.shop,
  userId: "7",
  username: "cashier",
  userRole: "Cashier",
  canSellNegativeStock: false,
  ...over,
});

beforeEach(() => {
  h.context = { context: { spAccounting: true } };
  h.update.mockReset().mockResolvedValue({});
  h.audit.mockReset().mockResolvedValue(undefined);
});

describe("listPosItemReplacementCandidates", () => {
  it("lists this location's live sales lines for one item, newest first", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const older = await w.sale([[w.rice, 2, 10]], { date: "2026-03-01" });
      const newer = await w.sale(
        [
          [w.rice, 1, 10],
          [w.beans, 4, 5],
          [w.rice, 3, 11],
        ],
        { date: "2026-03-20", credit: true }
      );
      await w.sale([[w.rice, 9, 10]], { locationId: w.depot });
      await w.sale([[w.rice, 9, 10]], { deleted: true });
      await w.sale([[w.rice, 9, 10]], { type: "Purchase" });

      const rows = await listPosItemReplacementCandidates({
        companyId: w.companyId,
        locationId: w.shop,
        stockItemId: w.rice,
      });
      expect(rows.map((row) => row.saleItemId)).toEqual([newer.itemIds[2], newer.itemIds[0], older.itemIds[0]]);
      expect(rows[0]).toMatchObject({
        voucherId: newer.voucherId,
        voucherDate: "2026-03-20",
        description: "Counter sale",
        locationId: w.shop,
        isCreditSale: true,
        stockItemId: w.rice,
        stockItemName: "RICE bale",
        stockItemCode: `${w.tag}-RICE`,
      });
      expect(Number(rows[0].quantity)).toBe(3);

      const ranged = await listPosItemReplacementCandidates({
        companyId: w.companyId,
        locationId: w.shop,
        stockItemId: w.rice,
        from: "2026-03-05",
        to: "2026-03-20",
      });
      expect(new Set(ranged.map((row) => row.voucherId))).toEqual(new Set([newer.voucherId]));
      await expect(
        listPosItemReplacementCandidates({
          companyId: w.companyId,
          locationId: w.shop,
          stockItemId: w.rice,
          to: "2026-03-05",
        })
      ).resolves.toHaveLength(1);
    });
  });
});

describe("applyPosItemReplacements", () => {
  it("needs at least one replacement and a usable accounting context", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      await expect(applyPosItemReplacements(actor(w), [])).resolves.toEqual({
        status: 400,
        body: { message: "At least one replacement is required" },
      });
      h.context = { error: { status: 423, body: { message: "Accounting locked" } } };
      const { itemIds } = await w.sale([[w.rice, 2, 10]]);
      await expect(
        applyPosItemReplacements(actor(w), [{ saleItemId: itemIds[0], replacementStockItemId: w.beans, quantity: 1 }])
      ).resolves.toEqual({ status: 423, body: { message: "Accounting locked" } });
      expect(h.update).not.toHaveBeenCalled();
    });
  });

  it("rewrites each affected sale once, in voucher order, and audits it", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const second = await w.sale([[w.rice, 5, 10]], { description: "Second" });
      const first = await w.sale(
        [
          [w.rice, 4, 10],
          [w.beans, 1, 5],
        ],
        { description: "First" }
      );
      const result = await applyPosItemReplacements(actor(w), [
        { saleItemId: first.itemIds[0], replacementStockItemId: w.maize, quantity: 3 },
        { saleItemId: second.itemIds[0], replacementStockItemId: w.beans, quantity: 2 },
        { saleItemId: second.itemIds[0], replacementStockItemId: w.maize, quantity: 3 },
      ]);
      expect(result).toEqual({
        status: 200,
        body: {
          message: "Updated 2 POS sales",
          updatedVoucherIds: [second.voucherId, first.voucherId].sort((a, b) => a - b),
          replacedQuantity: "8",
          replacementsApplied: 3,
        },
      });

      const calls = h.update.mock.calls.map(([, input]) => input);
      expect(calls.map((input) => input.voucherId)).toEqual([second.voucherId, first.voucherId].sort((a, b) => a - b));
      const firstCall = calls.find((input) => input.voucherId === first.voucherId);
      expect(firstCall).toMatchObject({
        currentCompanyId: w.companyId,
        userId: "7",
        username: "cashier",
        userRole: "Cashier",
        canSellNegativeStock: false,
        body: {
          description: "First",
          isCreditSale: false,
          voucherDate: "2026-03-10",
          locationId: w.shop,
          paymentAccountType: undefined,
          paymentAccountId: undefined,
        },
      });
      const items = firstCall.body.items as Array<{ stockItemId: number; quantity: number | string }>;
      expect(items.map((line) => [line.stockItemId, Number(line.quantity)])).toEqual(
        expect.arrayContaining([
          [w.rice, 1],
          [w.maize, 3],
          [w.beans, 1],
        ])
      );
      expect(h.update.mock.calls[0][2]).toEqual({ spAccounting: true });

      expect(h.audit).toHaveBeenCalledTimes(2);
      const audits = h.audit.mock.calls.map(([entry]) => entry);
      expect(audits.find((entry) => entry.recordId === second.voucherId)).toMatchObject({
        userId: "7",
        username: "cashier",
        companyId: w.companyId,
        action: "update",
        tableName: "sales_items",
        recordIdentifier: expect.stringContaining(`${w.tag}-S`),
        changes: {
          posItemReplacement: {
            old: null,
            new: [
              { saleItemId: second.itemIds[0], fromStockItemId: w.rice, toStockItemId: w.beans, quantity: 2 },
              { saleItemId: second.itemIds[0], fromStockItemId: w.rice, toStockItemId: w.maize, quantity: 3 },
            ],
          },
        },
      });
    });
  });

  it("locks and edits vouchers in id order whatever order their lines were found in", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const earlier = await w.sale([]);
      const later = await w.sale([[w.rice, 2, 10]]);
      const earlierLine = await id(
        client,
        `INSERT INTO sales_items(voucher_id,stock_item_id,quantity,selling_price,cost_price,total_sales,total_cost,profit)
         VALUES($1,$2,2,10,0,20,0,20) RETURNING id`,
        [earlier.voucherId, w.rice]
      );
      await applyPosItemReplacements(actor(w), [
        { saleItemId: later.itemIds[0], replacementStockItemId: w.beans, quantity: 1 },
        { saleItemId: earlierLine, replacementStockItemId: w.beans, quantity: 1 },
      ]);
      expect(h.update.mock.calls.map(([, input]) => input.voucherId)).toEqual([earlier.voucherId, later.voucherId]);
    });
  });

  it("reports a single corrected sale in the singular and passes the role through as optional", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const { itemIds } = await w.sale([[w.rice, 2, 10]], { credit: true });
      const result = await applyPosItemReplacements(actor(w, { userRole: null, canSellNegativeStock: true }), [
        { saleItemId: itemIds[0], replacementStockItemId: w.beans, quantity: 2 },
      ]);
      expect(result).toMatchObject({ status: 200, body: { message: "Updated 1 POS sale", replacedQuantity: "2" } });
      expect(h.update.mock.calls[0][1]).toMatchObject({
        userRole: undefined,
        canSellNegativeStock: true,
        body: { isCreditSale: true },
      });
    });
  });

  it("refuses lines that are missing, deleted, elsewhere or not sales", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const live = await w.sale([[w.rice, 2, 10]]);
      const deleted = await w.sale([[w.rice, 2, 10]], { deleted: true });
      const purchase = await w.sale([[w.rice, 2, 10]], { type: "Purchase" });
      const depot = await w.sale([[w.rice, 2, 10]], { locationId: w.depot });
      const replace = (saleItemId: number) =>
        applyPosItemReplacements(actor(w), [{ saleItemId, replacementStockItemId: w.beans, quantity: 1 }]);

      await expect(replace(live.itemIds[0] + 100000)).resolves.toEqual({
        status: 404,
        body: { message: "One or more selected POS sale items no longer exist" },
      });
      for (const row of [deleted, purchase]) {
        await expect(replace(row.itemIds[0])).resolves.toEqual({
          status: 400,
          body: { message: `Sale item ${row.itemIds[0]} does not belong to an active Sales voucher` },
        });
      }
      await expect(replace(depot.itemIds[0])).resolves.toEqual({
        status: 400,
        body: { message: `Sale item ${depot.itemIds[0]} is not from the selected location` },
      });
      // Another company's sale is invisible.
      await expect(
        applyPosItemReplacements(actor(w, { companyId: w.companyId + 100000 }), [
          { saleItemId: live.itemIds[0], replacementStockItemId: w.beans, quantity: 1 },
        ])
      ).resolves.toMatchObject({ status: 404 });
      expect(h.update).not.toHaveBeenCalled();
    });
  });

  it("validates the replacement item and quantities", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const { itemIds } = await w.sale([[w.rice, 2, 10]]);
      const replace = (rows: Array<{ replacementStockItemId: number; quantity: number }>) =>
        applyPosItemReplacements(
          actor(w),
          rows.map((row) => ({ saleItemId: itemIds[0], ...row }))
        );

      for (const missing of [w.retired, w.foreign]) {
        await expect(replace([{ replacementStockItemId: missing, quantity: 1 }])).resolves.toEqual({
          status: 404,
          body: { message: `Replacement stock item ${missing} was not found in this company` },
        });
      }
      for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(replace([{ replacementStockItemId: w.beans, quantity }])).resolves.toEqual({
          status: 400,
          body: { message: "Replacement quantity must be greater than zero" },
        });
      }
      await expect(replace([{ replacementStockItemId: w.rice, quantity: 1 }])).resolves.toEqual({
        status: 400,
        body: { message: "Replacement item must be different from the original item" },
      });
      await expect(
        replace([
          { replacementStockItemId: w.beans, quantity: 1.5 },
          { replacementStockItemId: w.maize, quantity: 0.6 },
        ])
      ).resolves.toEqual({
        status: 400,
        body: { message: `Replacement quantity for sale item ${itemIds[0]} exceeds the sold quantity 2` },
      });
      // Exactly the sold quantity is allowed.
      await expect(
        replace([
          { replacementStockItemId: w.beans, quantity: 1.5 },
          { replacementStockItemId: w.maize, quantity: 0.5 },
        ])
      ).resolves.toMatchObject({ status: 200 });
    });
  });

  it("returns the edit engine's refusal and rolls back earlier vouchers", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const a = await w.sale([[w.rice, 2, 10]]);
      const b = await w.sale([[w.rice, 2, 10]]);
      h.update.mockImplementation(
        async (tx: { execute: (q: unknown) => Promise<unknown> }, input: { voucherId: number }) => {
          if (input.voucherId === Math.max(a.voucherId, b.voucherId)) {
            return { error: { status: 409, body: { message: "Stock would go negative" } } };
          }
          // The first voucher's edit writes inside the shared transaction.
          await client.query("UPDATE vouchers SET description = 'edited' WHERE id = $1", [input.voucherId]);
          return {};
        }
      );
      await expect(
        applyPosItemReplacements(actor(w), [
          { saleItemId: a.itemIds[0], replacementStockItemId: w.beans, quantity: 1 },
          { saleItemId: b.itemIds[0], replacementStockItemId: w.beans, quantity: 1 },
        ])
      ).resolves.toEqual({ status: 409, body: { message: "Stock would go negative" } });
      expect(h.audit).toHaveBeenCalledTimes(1);
      const { rows } = await client.query("SELECT description FROM vouchers WHERE id = $1", [
        Math.min(a.voucherId, b.voucherId),
      ]);
      expect(rows[0].description).toBe("Counter sale");
    });
  });

  it("rethrows unexpected failures", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const { itemIds } = await w.sale([[w.rice, 2, 10]]);
      h.audit.mockRejectedValue(new Error("audit unavailable"));
      await expect(
        applyPosItemReplacements(actor(w), [{ saleItemId: itemIds[0], replacementStockItemId: w.beans, quantity: 1 }])
      ).rejects.toThrow("audit unavailable");
    });
  });
});
