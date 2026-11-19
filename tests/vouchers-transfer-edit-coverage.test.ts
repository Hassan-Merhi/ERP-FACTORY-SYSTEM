/**
 * The last PATCH /api/vouchers/:id/transfer handler (vouchers/transfer/transfer.ts)
 * against PostgreSQL in one rolled-back transaction per test.
 *
 * The exact-value edit route and the stock-transfer lifecycle route are
 * registered first and answer every stock-transfer voucher, so this handler
 * only sees unknown vouchers and other voucher types (pinned over HTTP). Its
 * request validation and its guard for a Stock Transfer voucher that would
 * reach it anyway are exercised by invoking the registered handler directly.
 */
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { item, nextSeq, voucher } from "./helpers/voucherReadFixture";
import { registerVoucherTransferOnlyRoutes } from "../server/routes/vouchers/transfer/transfer";

type Handler = (req: Request, res: Response) => Promise<unknown>;
let legacyHandler: Handler | null = null;
registerVoucherTransferOnlyRoutes({
  patch: (_path: string, ...chain: unknown[]) => {
    legacyHandler = chain[chain.length - 1] as Handler;
  },
} as never);

async function direct(w: FactoryWorld, id: number | string, body: Record<string, unknown>) {
  let status = 200;
  let payload: any;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
      return res;
    },
  };
  const session = { currentCompanyId: w.companyId, currentRole: "Admin", userId: w.userId, username: w.username };
  await legacyHandler!({ params: { id: String(id) }, body, session } as unknown as Request, res as unknown as Response);
  return { status, body: payload };
}

async function transferVoucher(w: FactoryWorld) {
  const shop = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`, [
    w.companyId,
    `${w.tag}SH${nextSeq()}`,
  ]);
  const id = await voucher(w, "Stock Transfer", { total: "10" });
  const coat = await item(w, "Coat");
  await w.q(
    `INSERT INTO stock_transfer_vouchers (voucher_id, source_location_id, destination_location_id) VALUES ($1, $2, $3)`,
    [id, w.locationId, shop]
  );
  const body = {
    sourceLocationId: w.locationId,
    destinationLocationId: shop,
    items: [{ stockItemId: coat, quantity: "3", rate: "5" }],
  };
  return { id, body };
}

const header = async (w: FactoryWorld, id: number) =>
  (await w.q(`SELECT total_amount::text AS t, description FROM vouchers WHERE id = $1`, [id]))[0];

describe("PATCH /api/vouchers/:id/transfer over HTTP", () => {
  it("answers unknown vouchers and other voucher types from the last handler", async () => {
    await withFactoryWorld(async (w) => {
      const { body } = await transferVoucher(w);
      const http = (id: number, payload: Record<string, unknown> = body) =>
        w.agent.patch(`/api/vouchers/${id}/transfer`).send(payload);
      expect((await http(2147483000)).status).toBe(404);
      const journal = await voucher(w, "Journal");
      const res = await http(journal);
      expect([res.status, res.body.message]).toEqual([400, "This endpoint only updates Stock Transfer vouchers"]);
      expect((await http(journal, { ...body, items: [] })).body.message).toBe("At least one item is required");
      const noLocations = await http(journal, { ...body, sourceLocationId: null });
      expect(noLocations.body.message).toBe("Source and destination locations are required");
    });
  });
});

describe("last transfer handler invoked directly", () => {
  it("validates the id, items and locations and refuses unknown and non-transfer vouchers", async () => {
    await withFactoryWorld(async (w) => {
      const { id, body } = await transferVoucher(w);
      expect((await direct(w, "abc", body)).body.message).toBe("Invalid voucher ID");
      expect((await direct(w, id, { ...body, items: "x" })).status).toBe(400);
      expect((await direct(w, id, { ...body, destinationLocationId: 0 })).status).toBe(400);
      expect((await direct(w, 2147483000, body)).status).toBe(404);
      const journal = await voucher(w, "Journal");
      expect((await direct(w, journal, body)).status).toBe(400);
    });
  });

  it("refuses a Stock Transfer voucher with 409 and changes nothing", async () => {
    await withFactoryWorld(async (w) => {
      const { id, body } = await transferVoucher(w);
      const before = await header(w, id);
      const res = await direct(w, id, body);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/stock transfer lifecycle/);
      expect(await header(w, id)).toEqual(before);
    });
  });
});
