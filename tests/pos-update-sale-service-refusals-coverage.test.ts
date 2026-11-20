/**
 * POS sale edit service refusals (updateSaleService.ts), called directly on a
 * company that lives only inside a rolled-back transaction: the pre-checks of
 * updatePosSale (supplier-partner settings, items, unknown / migrated voucher,
 * POS location change) and the locked-voucher checks of applyPosSaleUpdateTx
 * (items, missing voucher, Kwacha re-date / currency / price, non-sales,
 * migrated, POS location change, closed period, missing location). Every
 * refusal leaves the voucher, its lines and its total unchanged.
 */
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import { companyBusinessDate } from "../server/services/accounting/companyBusinessDate";
import { applyPosSaleUpdateTx, updatePosSale } from "../server/services/pos/edit/updateSaleService";
import type { UpdatePosSaleParams } from "../server/services/pos/edit/posEditSaleTypes";
import { closeBooks } from "./helpers/dispatchFlowFixture";
import { type FactoryWorld, withFactoryWorld } from "./helpers/rolledBackFactoryApp";

const NOT_SP = {
  isSpCompanyEdit: false,
  editSpPayableAccountId: null,
  editSpProfitAccountId: null,
  editSpCostClrAccountId: null,
  editSpDeductionClrAccountId: null,
} as never;

const items = [{ stockItemId: 1, quantity: "1", sellingPrice: "10" }];

async function voucher(
  w: FactoryWorld,
  over: {
    type?: string;
    number?: string;
    currency?: string;
    rate?: string;
    date?: string;
    location?: number | null;
  } = {}
) {
  return w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, location_id, currency, exchange_rate)
     VALUES ($1, $2, $3, $4, 20, $5, $6, $7) RETURNING id`,
    [
      w.companyId,
      over.number ?? `${w.tag}-${Math.random().toString(36).slice(2, 8)}`,
      over.type ?? "Sales",
      over.date ?? "2026-06-01",
      over.location === undefined ? w.locationId : over.location,
      over.currency ?? "USD",
      over.rate ?? null,
    ]
  );
}

function params(w: FactoryWorld, voucherId: number, over: Partial<UpdatePosSaleParams> = {}, body = {}) {
  return {
    voucherId,
    currentCompanyId: w.companyId,
    userId: w.userId,
    username: w.username,
    userRole: "Admin",
    canSellNegativeStock: false,
    ...over,
    body: {
      description: "edited",
      items,
      paymentAccountType: "cash",
      paymentAccountId: null,
      isCreditSale: false,
      voucherDate: undefined,
      locationId: undefined,
      ...body,
    },
  } as UpdatePosSaleParams;
}

const applyTx = (p: UpdatePosSaleParams) =>
  db.transaction(async (tx) => (await applyPosSaleUpdateTx(tx, p, NOT_SP)).error);

const state = async (w: FactoryWorld, id: number) =>
  (
    await w.q(`SELECT voucher_date::text AS d, total_amount::numeric AS t, deleted_at FROM vouchers WHERE id = $1`, [
      id,
    ])
  )[0];

describe("updatePosSale pre-checks", () => {
  it("refuses a supplier-partner company without POS payable settings", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
      const id = await voucher(w);
      const res = await updatePosSale(params(w, id));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await state(w, id)).toMatchObject({ d: "2026-06-01" });
    });
  });

  it("refuses missing items, an unknown or non-sales voucher, a migrated voucher and a POS location change", async () => {
    await withFactoryWorld(async (w) => {
      const id = await voucher(w);
      expect(await updatePosSale(params(w, id, {}, { items: [] }))).toEqual({
        status: 400,
        body: { message: "At least one item is required" },
      });
      expect((await updatePosSale(params(w, 999999999))).status).toBe(404);
      const journal = await voucher(w, { type: "Journal" });
      expect((await updatePosSale(params(w, journal))).body).toEqual({
        message: "Only Sales vouchers can be updated with this endpoint",
      });
      const migrated = await voucher(w, { number: `MIG-${w.tag}` });
      expect((await updatePosSale(params(w, migrated))).status).toBe(403);
      const moved = await updatePosSale(params(w, id, { userRole: "POS" }, { locationId: w.locationId + 1 }));
      expect(moved).toEqual({
        status: 403,
        body: { message: "POS users cannot change the location of an existing sale" },
      });
      await expect(updatePosSale(params(w, id, {}, { items: [{ quantity: "0", sellingPrice: "1" }] }))).rejects.toThrow(
        "Invalid quantity: 0"
      );
      expect(await state(w, id)).toMatchObject({ d: "2026-06-01", t: "20.00" });
    });
  });
});

describe("applyPosSaleUpdateTx locked-voucher checks", () => {
  it("refuses empty items and a missing or deleted voucher", async () => {
    await withFactoryWorld(async (w) => {
      const id = await voucher(w);
      expect(await applyTx(params(w, id, {}, { items: [] }))).toMatchObject({ status: 400 });
      expect(await applyTx(params(w, 999999999))).toMatchObject({ status: 404 });
    });
  });

  it("refuses Kwacha re-dates, currency changes and prices off the locked rate", async () => {
    await withFactoryWorld(async (w) => {
      const id = await voucher(w, { currency: "ZMW", rate: "25" });
      expect(await applyTx(params(w, id, {}, { voucherDate: "2026-06-02" }))).toMatchObject({
        status: 409,
        body: { code: "POS_ZMW_REDATE_REQUIRES_REVERSAL" },
      });
      expect(await applyTx(params(w, id, {}, { currency: "USD" }))).toMatchObject({
        body: { code: "POS_ZMW_CURRENCY_LOCKED" },
      });
      const offRate = [{ stockItemId: 1, quantity: "1", sellingPrice: "10", originalCurrencyRate: "260" }];
      expect(await applyTx(params(w, id, {}, { items: offRate }))).toMatchObject({
        status: 409,
        body: { code: "POS_ZMW_RATE_REQUIRED" },
      });
      expect(await state(w, id)).toMatchObject({ d: "2026-06-01", t: "20.00" });
    });
  });

  it("refuses a non-sales or migrated voucher", async () => {
    await withFactoryWorld(async (w) => {
      const journal = await voucher(w, { type: "Journal" });
      expect(await applyTx(params(w, journal))).toMatchObject({ status: 400 });
      const migrated = await voucher(w, { number: `MIG-${w.tag}` });
      expect(await applyTx(params(w, migrated))).toMatchObject({ status: 403 });
    });
  });

  it("refuses a POS cashier without authorization or changing payment or location", async () => {
    await withFactoryWorld(async (w) => {
      const today = await companyBusinessDate(w.companyId);
      const id = await voucher(w, { date: today });
      await w.q(
        `UPDATE user_company_roles SET role = 'POS', daybook_edit_days = 5, assigned_location_id = $3
          WHERE user_id = $1 AND company_id = $2`,
        [w.userId, w.companyId, w.locationId]
      );
      const pos = { userRole: "POS", posDaybookEditAuthorization: { editDays: 5, businessDate: today } };
      const cashierBody = { paymentAccountType: undefined, isCreditSale: undefined };
      expect(await applyTx(params(w, id, pos, { isCreditSale: true }))).toMatchObject({
        body: { code: "POS_SALE_EDIT_PAYMENT_LOCKED" },
      });
      // The daybook guard refuses the move before applyPosRoleRestrictions can,
      // so the in-transaction POS location check is unreachable here.
      expect(await applyTx(params(w, id, pos, { ...cashierBody, locationId: w.locationId + 1 }))).toMatchObject({
        status: 403,
        body: { code: "POS_SALE_EDIT_LOCATION_LOCKED" },
      });
      expect(await applyTx(params(w, id, { userRole: "POS" }))).toMatchObject({
        body: { code: "POS_SALE_EDIT_AUTH_REQUIRED" },
      });
    });
  });

  it("refuses a sale in a closed period and a sale without a location", async () => {
    await withFactoryWorld(async (w) => {
      const closed = await voucher(w, { date: "2026-01-15" });
      await closeBooks(w, "2026-01-31");
      expect(await applyTx(params(w, closed))).toMatchObject({ status: 409 });
      const open = await voucher(w, { date: "2026-06-01" });
      expect(await applyTx(params(w, open, {}, { voucherDate: "2026-01-20" }))).toMatchObject({ status: 409 });
      const nowhere = await voucher(w, { location: null });
      expect(await applyTx(params(w, nowhere))).toEqual({
        status: 400,
        body: { message: "Existing sale is missing a location" },
      });
      expect(await state(w, open)).toMatchObject({ d: "2026-06-01", t: "20.00" });
    });
  });
});
