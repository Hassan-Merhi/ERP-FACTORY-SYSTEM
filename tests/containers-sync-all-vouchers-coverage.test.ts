/**
 * POST /api/containers/sync-all-vouchers over real HTTP in one rolled-back
 * transaction per test. As the parent company it also scans a subsidiary
 * named by an intercompany POS config; as a non-parent it looks for the
 * parent's INTERCO-PARENT voucher. Pins zero-total skips, the parent-freight
 * warning, stale FREIGHT- / PARENT-FREIGHT- voucher retirement, own and
 * parent embedded freight, container total repair and container-charge
 * insert / update / delete, plus the role refusal.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/containers/sync-all-vouchers";
let seq = 0;

const company = (w: FactoryWorld) =>
  w.one(`INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'erp') RETURNING id`, [
    `${w.tag}C${++seq}`,
  ]);
const ledger = (w: FactoryWorld, companyId: number, name: string) =>
  w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, $3, 'Expense') RETURNING id`,
    [companyId, `${w.tag}L${++seq}`, name]
  );
const supplier = (w: FactoryWorld, companyId: number) =>
  w.one(`INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Acme', '') RETURNING id`, [
    companyId,
    `${w.tag}S${++seq}`,
  ]);
const container = (w: FactoryWorld, companyId: number, supplierId: number, totals = [0, 0, 0]) =>
  w.one(
    `INSERT INTO containers (company_id, container_number, import_date, supplier_id, items_total, charges_total, grand_total)
     VALUES ($1, $2, '2026-01-01', $3, $4, $5, $6) RETURNING id`,
    [companyId, `${w.tag}CN${++seq}`, supplierId, ...totals]
  );
interface PoOpts {
  items: number;
  freight?: number;
  paidBy?: string | null;
  parentAccount?: number | null;
  ownAccount?: number | null;
  discount?: number;
  surcharge?: number;
}
const purchaseOrder = (w: FactoryWorld, companyId: number, supplierId: number, containerId: number, o: PoOpts) =>
  w.one(
    `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id, items_total, freight, freight_paid_by,
       freight_parent_account_id, freight_own_account_id, discount, surcharge)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      companyId,
      containerId,
      `${w.tag}PO${++seq}`,
      supplierId,
      o.items,
      o.freight ?? 0,
      o.paidBy ?? null,
      o.parentAccount ?? null,
      o.ownAccount ?? null,
      o.discount ?? 0,
      o.surcharge ?? 0,
    ]
  );
const poNumber = async (w: FactoryWorld, id: number) =>
  (await w.q<{ po_number: string }>(`SELECT po_number FROM purchase_orders WHERE id = $1`, [id]))[0].po_number;
const staleVoucher = (w: FactoryWorld, companyId: number, number: string) =>
  w.one(
    `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount) VALUES ($1, 'Journal', $2, '2026-01-05', 0) RETURNING id`,
    [companyId, number]
  );

describe("sync-all-vouchers as the parent company", () => {
  it("repairs local and subsidiary POs, retires stale freight vouchers and rewrites container charges", () =>
    withFactoryWorld(async (w) => {
      const sub = await company(w);
      await w.q(
        `INSERT INTO intercompany_pos_configs (source_company_id, dest_company_id, source_interco_account_id, dest_interco_account_id)
         VALUES ($1, $2, $3, $4), ($2, $2, $4, $4)`,
        [sub, w.companyId, await ledger(w, sub, "Due to parent"), await ledger(w, w.companyId, "Due from sub")]
      );
      const sup = await supplier(w, w.companyId);
      const subSup = await supplier(w, sub);
      const freightAcct = await ledger(w, w.companyId, "Freight");

      const cZero = await container(w, w.companyId, sup);
      await purchaseOrder(w, w.companyId, sup, cZero, { items: 0 });

      const cMain = await container(w, w.companyId, sup, [999, 0, 999]);
      const parentNoAcct = await purchaseOrder(w, w.companyId, sup, cMain, {
        items: 100,
        freight: 10,
        paidBy: "parent",
        discount: 5,
      });
      await purchaseOrder(w, w.companyId, sup, cMain, {
        items: 50,
        freight: 4,
        paidBy: "own",
        ownAccount: freightAcct,
      });
      await w.q(
        `INSERT INTO container_charges (container_id, charge_type, amount) VALUES ($1, 'Freight', 1), ($1, 'Surcharge', 3)`,
        [cMain]
      );
      const [mainNumber] = await w.q<{ container_number: string }>(
        `SELECT container_number FROM containers WHERE id = $1`,
        [cMain]
      );
      const pn = await poNumber(w, parentNoAcct);
      const staleFreight = await staleVoucher(w, w.companyId, `FREIGHT-${mainNumber.container_number}-${pn}`);
      const staleParentFreight = await staleVoucher(w, w.companyId, `PARENT-FREIGHT-${pn}`);

      const cSub = await container(w, sub, subSup);
      await purchaseOrder(w, sub, subSup, cSub, {
        items: 80,
        freight: 6,
        paidBy: "parent",
        parentAccount: freightAcct,
      });

      const res = await w.agent.post(URL).send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ scannedPOs: 4, scannedContainers: 3, updatedFreightVouchers: 2, errors: [] });
      expect(res.body.skipped).toEqual([expect.stringContaining("total is 0")]);
      expect(res.body.missingParentFreightAccount).toEqual([
        `PO ${pn}: freight set to parent-paid but no parent account configured`,
      ]);
      // The subsidiary PO's INTERCO-PARENT journal is synced (none exists: the sync writes one).
      expect(res.body).toMatchObject({ notFoundParentVouchers: [], updatedParentVouchers: 1 });
      const retired = await w.q(`SELECT id FROM vouchers WHERE id = ANY($1::int[]) AND deleted_at IS NOT NULL`, [
        [staleFreight, staleParentFreight],
      ]);
      expect(retired).toHaveLength(2);
      const [totals] = await w.q(
        `SELECT items_total::text, charges_total::text, grand_total::text FROM containers WHERE id = $1`,
        [cMain]
      );
      expect(totals).toEqual({ items_total: "150.00", charges_total: "9.00", grand_total: "159.00" });
      const charges = await w.q<{ charge_type: string; amount: string }>(
        `SELECT charge_type, amount::text FROM container_charges WHERE container_id = $1 ORDER BY charge_type`,
        [cMain]
      );
      expect(charges).toEqual([
        { charge_type: "Discount", amount: "-5.00" },
        { charge_type: "Freight", amount: "14.00" },
      ]);

      const again = await w.agent.post(URL).send({});
      expect(again.body).toMatchObject({ updatedContainers: 0, updatedContainerCharges: 0, updatedFreightVouchers: 0 });
    }));
});

describe("sync-all-vouchers as a subsidiary", () => {
  it("looks up the parent's INTERCO-PARENT voucher for its own POs", () =>
    withFactoryWorld(async (w) => {
      const parent = await company(w);
      await w.q(`UPDATE system_settings SET value = $1 WHERE key = 'parentCompanyId'`, [String(parent)]);
      await w.q(`UPDATE companies SET parent_company_id = $1 WHERE id = $2`, [parent, w.companyId]);
      const sup = await supplier(w, w.companyId);
      const c = await container(w, w.companyId, sup, [70, 0, 70]);
      await purchaseOrder(w, w.companyId, sup, c, { items: 70 });
      await purchaseOrder(w, w.companyId, sup, c, {
        items: 30,
        freight: 3,
        paidBy: "parent",
        parentAccount: await ledger(w, parent, "PF"),
      });
      const res = await w.agent.post(URL).send({});
      expect(res.body).toMatchObject({ scannedPOs: 2, scannedContainers: 1, updatedContainers: 1, errors: [] });
      expect(res.body.notFoundParentVouchers).toEqual([
        expect.stringContaining("no INTERCO-PARENT voucher in parent company"),
        expect.stringContaining("no INTERCO-PARENT voucher in parent company"),
      ]);
    }));
});

describe("refusals", () => {
  it("refuses roles other than Admin, Owner or Developer", () =>
    withFactoryWorld(async (w) => {
      const clerk = await w.agentFor("Accountant");
      expect((await clerk.post(URL).send({})).status).toBe(403);
    }));
});
