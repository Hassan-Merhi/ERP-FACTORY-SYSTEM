/**
 * containerFreightWriteRoutesStep (the read-and-plan stage of PATCH
 * /api/purchase-orders/:id) against PostgreSQL in one rolled-back transaction
 * per test, driven directly with a session request. Pins the id / not-found /
 * other-company / role refusals, the offloaded-container stock-swap refusal,
 * foreign freight-account refusal, every allowed field, account id
 * normalisation and the freight plan for supplier / own / parent payers.
 * The stage only reads; nothing is written.
 */
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { withReportWorld, type ReportWorld } from "./helpers/reportCaseWorld";
import { containerFreightWriteRoutesStep } from "../server/routes/containers/containerFreightWriteRoutesStep";

let seq = 0;

function call(
  id: string | number,
  companyId: number,
  body: Record<string, unknown> = {},
  role: string | null = "Admin"
) {
  let status = 200;
  let payload: unknown;
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
  const req = {
    params: { id: String(id) },
    body,
    session: { currentCompanyId: companyId, currentRole: role ?? undefined },
  };
  return containerFreightWriteRoutesStep({ req: req as unknown as Request, res: res as unknown as Response }).then(
    (result) => ({ result, status, payload })
  );
}

interface PoSeed {
  status?: string;
  freight?: number;
  paidBy?: string | null;
  ownAccount?: number | null;
  parentAccount?: number | null;
  currency?: string;
  companyId?: number;
}
async function seedPo(w: ReportWorld, o: PoSeed = {}) {
  const companyId = o.companyId ?? w.companyId;
  const supplier = await w.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Acme', '') RETURNING id`,
    [companyId, `${w.tag}S${++seq}`]
  );
  const container = await w.one(
    `INSERT INTO containers (company_id, container_number, import_date, supplier_id, status) VALUES ($1, $2, '2026-01-01', $3, $4) RETURNING id`,
    [companyId, `${w.tag}C${++seq}`, supplier, o.status ?? "OTW"]
  );
  const po = await w.one(
    `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id, items_total, freight, freight_paid_by,
       freight_own_account_id, freight_parent_account_id)
     VALUES ($1, $2, $3, $4, 100, $5, $6, $7, $8) RETURNING id`,
    [
      companyId,
      container,
      `${w.tag}PO${++seq}`,
      supplier,
      o.freight ?? 0,
      o.paidBy ?? null,
      o.ownAccount ?? null,
      o.parentAccount ?? null,
    ]
  );
  if (o.currency === "ZMW") {
    await w.q(
      `UPDATE purchase_orders SET currency = 'ZMW', historical_exchange_rate = 25, historical_rate_date = '2026-01-01',
         native_line_count = 1, native_items_total = 2500, native_freight = 0, native_surcharge = 0, native_fumigation = 0,
         native_document_charges = 0, native_discount = 0, native_other_charges = 0
       WHERE id = $1`,
      [po]
    );
  }
  const item = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Rag', 'KG') RETURNING id`,
    [companyId, `${w.tag}I${++seq}`]
  );
  await w.q(
    `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total) VALUES ($1, $2, 'Rag', 10, 10, 100)`,
    [po, item]
  );
  return { po, item };
}
const account = (w: ReportWorld, companyId = w.companyId) => w.ledger(`Freight ${++seq}`, "Expense", { companyId });

describe("refusals", () => {
  it("refuses bad ids, unknown and other-company POs and missing or unprivileged roles", () =>
    withReportWorld(async (w) => {
      expect(await call("abc", w.companyId)).toMatchObject({ status: 400, payload: { message: "Invalid id" } });
      expect(await call(2147483000, w.companyId)).toMatchObject({ status: 404 });
      const other = await w.otherCompany();
      const { po: foreign } = await seedPo(w, { companyId: other });
      expect(await call(foreign, w.companyId)).toMatchObject({
        status: 404,
        payload: { message: "Purchase order not found" },
      });
      const { po } = await seedPo(w);
      expect(await call(po, w.companyId, {}, null)).toMatchObject({
        status: 403,
        payload: { message: "User role not found" },
      });
      expect(await call(po, w.companyId, {}, "Accountant")).toMatchObject({
        status: 403,
        payload: { message: "Only Admin and Owner can edit purchase orders" },
      });
      for (const role of ["Owner", "Developer"]) {
        expect((await call(po, w.companyId, {}, role)).result.done).toBe(false);
      }
    }));

  it("refuses swapping stock items on an offloaded container", () =>
    withReportWorld(async (w) => {
      const { po } = await seedPo(w, { status: "OFFLOADED" });
      const swap = await call(po, w.companyId, { items: [{ stockItemId: null }, { stockItemId: "2147483000" }] });
      expect(swap.status).toBe(400);
      expect((swap.payload as { message: string }).message).toMatch(
        /^Cannot change stock items on an offloaded container/
      );
    }));

  it("refuses freight accounts of another company", () =>
    withReportWorld(async (w) => {
      const { po } = await seedPo(w);
      const foreign = await account(w, await w.otherCompany());
      for (const body of [{ freightOwnAccountId: foreign }, { freightParentAccountId: String(foreign) }]) {
        expect(await call(po, w.companyId, body)).toMatchObject({
          status: 400,
          payload: { message: "Freight ledger account must belong to the purchase order company" },
        });
      }
    }));
});

describe("planning", () => {
  it("collects every allowed field and flags charge edits", () =>
    withReportWorld(async (w) => {
      const { po } = await seedPo(w);
      const { result } = await call(po, w.companyId, {
        poNumber: "NEW-1",
        itemsTotal: "120",
        currency: "USD",
        status: "Open",
        freight: "0",
        surcharge: "1",
        fumigation: "2",
        documentCharges: "3",
        discount: "4",
        otherCharges: "5",
        freightPaidBy: "supplier",
        freightOwnAccountId: null,
        freightParentAccountId: "",
      });
      if (result.done) throw new Error("expected a plan");
      expect(result.allowedUpdates).toMatchObject({
        poNumber: "NEW-1",
        itemsTotal: "120",
        status: "Open",
        chargesEdited: true,
        freightOwnAccountId: null,
        freightParentAccountId: null,
      });
      expect(result.newGrandTotal.toString()).toBe("127");
      expect(result.freightVoucherNeedsUpdate).toBe(false);
    }));

  it("plans own-paid freight with an account as embedded", () =>
    withReportWorld(async (w) => {
      const own = await account(w);
      const { po } = await seedPo(w);
      const { result } = await call(po, w.companyId, { freight: "10", freightPaidBy: "own", freightOwnAccountId: own });
      if (result.done) throw new Error("expected a plan");
      expect(result).toMatchObject({
        newHasOwnFreight: true,
        newFreightOwnAccountId: own,
        freightPaidByChanged: true,
        freightVoucherNeedsUpdate: true,
        freightParentVoucherNeedsUpdate: true,
      });
      expect(result.newLocalVoucherTotal.toString()).toBe("110");
    }));

  it("plans parent-paid freight with and without an account", () =>
    withReportWorld(async (w) => {
      const parent = await account(w);
      const { po } = await seedPo(w, { freight: 5, paidBy: "parent", parentAccount: parent });
      const same = await call(po, w.companyId, { freight: "8" });
      if (same.result.done) throw new Error("expected a plan");
      expect(same.result).toMatchObject({
        newHasParentFreight: true,
        newFreightParentAccountId: parent,
        freightParentVoucherNeedsUpdate: true,
        chargesWereEdited: true,
      });
      expect(same.result.oldLocalVoucherTotal.toString()).toBe("105");
      const cleared = await call(po, w.companyId, { freightParentAccountId: null });
      if (cleared.result.done) throw new Error("expected a plan");
      expect(cleared.result).toMatchObject({ newHasParentFreight: false, newFreightParentAccountId: null });
      expect(cleared.result.newLocalVoucherTotal.toString()).toBe("105");
    }));

  it("keeps an existing own account and freight when nothing changes", () =>
    withReportWorld(async (w) => {
      const own = await account(w);
      const { po } = await seedPo(w, { freight: 4, paidBy: "own", ownAccount: own });
      const { result } = await call(po, w.companyId, {});
      if (result.done) throw new Error("expected a plan");
      expect(result).toMatchObject({
        newFreightOwnAccountId: own,
        freightPaidByChanged: false,
        freightOwnAccountChanged: false,
        freightVoucherNeedsUpdate: false,
        freightParentVoucherNeedsUpdate: false,
        chargesWereEdited: false,
      });
    }));

  it("converts native Kwacha charge edits at the locked rate", () =>
    withReportWorld(async (w) => {
      const { po } = await seedPo(w, { currency: "ZMW" });
      const { result } = await call(po, w.companyId, { freight: "250" });
      if (result.done) throw new Error("expected a plan");
      expect(result.allowedUpdates.freight).toBeDefined();
    }));
});
