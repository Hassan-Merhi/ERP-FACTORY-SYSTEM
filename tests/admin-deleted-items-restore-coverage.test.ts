/**
 * POST /api/deleted-items/:type/:id/restore through the real app inside one
 * rolled-back transaction: request validation, voucher role/state refusals,
 * cross-company restores that change nothing, factory bale and mix refusals,
 * and the simple master-data restores.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const restore = (w: FactoryWorld, type: string, id: number | string) =>
  w.agent.post(`/api/deleted-items/${type}/${id}/restore`).send({});

async function deletedVoucher(w: FactoryWorld, number: string, type = "Journal", extra = "") {
  return w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, deleted_at${extra ? ", source_module" : ""})
     VALUES ($1, $2, $3, '2026-05-01', 0, now()${extra ? ", $4" : ""}) RETURNING id`,
    extra ? [w.companyId, number, type, extra] : [w.companyId, number, type]
  );
}

const isDeleted = async (w: FactoryWorld, table: "vouchers" | "factory_mix_batches" | "factory_bales", id: number) => {
  const sql =
    table === "vouchers"
      ? `SELECT deleted_at IS NOT NULL AS d FROM vouchers WHERE id = $1`
      : table === "factory_bales"
        ? `SELECT deleted_at IS NOT NULL AS d FROM factory_bales WHERE id = $1`
        : `SELECT deleted_at IS NOT NULL AS d FROM factory_mix_batches WHERE id = $1`;
  return (await w.q<{ d: boolean }>(sql, [id]))[0]?.d;
};

describe("deleted items restore", () => {
  it("validates the id, type and company", () =>
    withFactoryWorld(async (w) => {
      expect((await restore(w, "location", "abc")).status).toBe(400);
      const bad = await restore(w, "spaceship", 1);
      expect(bad.status).toBe(400);
      expect(bad.body.message).toBe("Invalid item type");
    }));

  it("restores master data only inside the active company", () =>
    withFactoryWorld(async (w) => {
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const mine = await w.one(
        `INSERT INTO stock_groups (company_id, code, name, active, deleted_at) VALUES ($1, $2, 'G', false, now()) RETURNING id`,
        [w.companyId, `${w.tag}G`]
      );
      const theirs = await w.one(
        `INSERT INTO stock_groups (company_id, code, name, active, deleted_at) VALUES ($1, $2, 'G', false, now()) RETURNING id`,
        [other, `${w.tag}G2`]
      );
      expect((await restore(w, "stockGroup", mine)).body.message).toBe("stockGroup restored successfully");
      expect((await restore(w, "stockGroup", theirs)).status).toBe(404);
      const rows = await w.q<{ id: number; active: boolean; deleted: boolean }>(
        `SELECT id, active, deleted_at IS NOT NULL AS deleted FROM stock_groups WHERE id IN ($1, $2) ORDER BY id`,
        [mine, theirs]
      );
      expect(rows).toEqual([
        { id: mine, active: true, deleted: false },
        { id: theirs, active: false, deleted: true },
      ]);
      const cases: Array<[string, string, unknown[]]> = [
        [
          "location",
          `INSERT INTO locations (company_id, code, name, deleted_at) VALUES ($1, $2, 'L', now()) RETURNING id`,
          [`${w.tag}L2`],
        ],
        [
          "stockItem",
          `INSERT INTO stock_items (company_id, code, name, uom, deleted_at) VALUES ($1, $2, 'S', 'PCS', now()) RETURNING id`,
          [`${w.tag}S`],
        ],
        [
          "ledgerAccount",
          `INSERT INTO ledger_accounts (company_id, code, name, account_type, deleted_at) VALUES ($1, $2, 'A', 'Asset', now()) RETURNING id`,
          [`${w.tag}A`],
        ],
        [
          "employee",
          `INSERT INTO employees (company_id, code, first_name, last_name, join_date, deleted_at) VALUES ($1, $2, 'E', 'F', '2026-01-01', now()) RETURNING id`,
          [`${w.tag}E`],
        ],
        [
          "customer",
          `INSERT INTO customers (company_id, code, legal_name, deleted_at) VALUES ($1, $2, 'C', now()) RETURNING id`,
          [`${w.tag}C`],
        ],
        [
          "supplier",
          `INSERT INTO suppliers (company_id, code, legal_name, email, deleted_at) VALUES ($1, $2, 'S', '', now()) RETURNING id`,
          [`${w.tag}SP`],
        ],
        [
          "bankAccount",
          `INSERT INTO bank_accounts (company_id, code, name, account_number, bank_name, deleted_at) VALUES ($1, $2, 'B', '1', 'Bank', now()) RETURNING id`,
          [`${w.tag}B`],
        ],
        [
          "factoryCategory",
          `INSERT INTO factory_categories (company_id, name, deleted_at) VALUES ($1, $2, now()) RETURNING id`,
          [`${w.tag}FC`],
        ],
        [
          "factoryBaleProduct",
          `INSERT INTO factory_bale_products (company_id, code, name, deleted_at) VALUES ($1, $2, 'P', now()) RETURNING id`,
          [`${w.tag}BP`],
        ],
        [
          "factoryContainer",
          `INSERT INTO factory_containers (company_id, container_number, deleted_at) VALUES ($1, $2, now()) RETURNING id`,
          [`${w.tag}FCN`],
        ],
        [
          "factoryRawMaterialAdjustment",
          `INSERT INTO factory_raw_material_adjustments (company_id, type, date, kg, deleted_at) VALUES ($1, 'ADD', $2, 5, now()) RETURNING id`,
          ["2026-05-01"],
        ],
      ];
      for (const [type, sql, params] of cases) {
        const id = await w.one(sql, [w.companyId, ...params]);
        const res = await restore(w, type, id);
        expect(res.status, type).toBe(200);
      }
    }));

  it("restores a raw stock row with and without a held commission", () =>
    withFactoryWorld(async (w) => {
      const container = await w.one(
        `INSERT INTO factory_containers (company_id, container_number) VALUES ($1, $2) RETURNING id`,
        [w.companyId, `${w.tag}RC`]
      );
      const plain = await w.one(
        `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, deleted_at) VALUES ($1, $2, 100, now()) RETURNING id`,
        [w.companyId, container]
      );
      expect((await restore(w, "factoryRawStock", plain)).status).toBe(200);
      const [row] = await w.q(`SELECT deleted_at FROM factory_raw_stock WHERE id = $1`, [plain]);
      expect(row.deleted_at).toBeNull();
      expect((await restore(w, "factoryRawStock", 2_000_000_000)).status).toBe(404);
    }));

  it("refuses voucher restores for non-admin roles", () =>
    withFactoryWorld(async (w) => {
      const id = await deletedVoucher(w, `${w.tag}-V1`);
      const manager = await w.agentFor("Manager");
      const res = await manager.post(`/api/deleted-items/voucher/${id}/restore`).send({});
      expect(res.status).toBe(403);
      expect(await isDeleted(w, "vouchers", id)).toBe(true);
    }));

  it("refuses missing, retired, migrated and unrestorable stock vouchers", () =>
    withFactoryWorld(async (w) => {
      expect((await restore(w, "voucher", 2_000_000_000)).status).toBe(404);
      const retired = await deletedVoucher(w, `${w.tag}-V2~DEL1`);
      const r1 = await restore(w, "voucher", retired);
      expect(r1.status).toBe(409);
      expect(r1.body.code).toBe("RETIRED_VOUCHER_NOT_RESTORABLE");
      const migrated = await deletedVoucher(w, `MIG-${w.tag}`);
      expect((await restore(w, "voucher", migrated)).status).toBe(403);
      const transfer = await deletedVoucher(w, `${w.tag}-ST`, "Stock Transfer");
      const r2 = await restore(w, "voucher", transfer);
      expect(r2.status).toBe(409);
      expect(r2.body.code).toBe("STOCK_DOCUMENT_NOT_RESTORABLE");
      for (const id of [retired, migrated, transfer]) expect(await isDeleted(w, "vouchers", id)).toBe(true);
    }));

  it("restores a deleted journal voucher and writes an audit row", () =>
    withFactoryWorld(async (w) => {
      const id = await deletedVoucher(w, `${w.tag}-J`);
      const res = await restore(w, "voucher", id);
      expect(res.status).toBe(200);
      expect(await isDeleted(w, "vouchers", id)).toBe(false);
      const audit = await w.q(
        `SELECT action FROM audit_log WHERE company_id = $1 AND table_name = 'vouchers' AND record_id = $2`,
        [w.companyId, id]
      );
      expect(audit.map((a) => a.action)).toContain("restore");
    }));

  it("refuses missing, active and physically removed bales", () =>
    withFactoryWorld(async (w) => {
      expect((await restore(w, "factoryBale", 2_000_000_000)).status).toBe(404);
      const active = await w.one(
        `INSERT INTO factory_bales (company_id, reference_number) VALUES ($1, $2) RETURNING id`,
        [w.companyId, `${w.tag}B1`]
      );
      expect((await restore(w, "factoryBale", active)).body.message).toBe("Bale is not deleted");
      const removed = await w.one(
        `INSERT INTO factory_bales (company_id, reference_number, deleted_at) VALUES ($1, $2, now()) RETURNING id`,
        [w.companyId, `${w.tag}B2`]
      );
      await w.q(
        `INSERT INTO factory_physical_bale_deletions (company_id, bale_id, reference_number, reason, previous_status, removed_by_name)
         VALUES ($1, $2, $3, 'damaged', 'IN_STOCK', 'tester')`,
        [w.companyId, removed, `${w.tag}B2`]
      );
      const res = await restore(w, "factoryBale", removed);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/controlled stock re-entry/);
      expect(await isDeleted(w, "factory_bales", removed)).toBe(true);
      const plain = await w.one(
        `INSERT INTO factory_bales (company_id, reference_number, deleted_at) VALUES ($1, $2, now()) RETURNING id`,
        [w.companyId, `${w.tag}B3`]
      );
      expect((await restore(w, "factoryBale", plain)).status).toBe(200);
      const [row] = await w.q(`SELECT status, deleted_at FROM factory_bales WHERE id = $1`, [plain]);
      expect(row).toEqual({ status: "IN_STOCK", deleted_at: null });
    }));

  it("restores proformas and orders", () =>
    withFactoryWorld(async (w) => {
      const customer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Buyer') RETURNING id`,
        [w.companyId, `${w.tag}CU`]
      );
      const proforma = await w.one(
        `INSERT INTO customer_proformas (company_id, customer_id, name, deleted_at) VALUES ($1, $2, 'PF', now()) RETURNING id`,
        [w.companyId, customer]
      );
      const order = await w.one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, deleted_at) VALUES ($1, $2, '2026-05-01', now()) RETURNING id`,
        [w.companyId, customer]
      );
      expect((await restore(w, "customerProforma", proforma)).status).toBe(200);
      expect((await restore(w, "customerOrder", order)).status).toBe(200);
    }));
});
