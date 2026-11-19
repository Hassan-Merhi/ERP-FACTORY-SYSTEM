/**
 * POST /api/cleanup/orphaned-charges (admin/deleted-items/location-summary.ts)
 * through the real HTTP app in one rolled-back transaction per test: a
 * Developer-only global maintenance operation (the global guard refuses even
 * Admin), scoped to the active company, retires (never hard-deletes) live
 * CHARGE- vouchers whose container has no purchase order, and keeps charge
 * vouchers whose container still has one, already-retired vouchers and other
 * companies' vouchers untouched. The read-only location summary profiles are
 * covered by tests/location-summary-bandwidth-coverage.test.ts.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/cleanup/orphaned-charges";

async function chargeVoucher(w: FactoryWorld, companyId: number, number: string, deleted = false) {
  return w.one(
    `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount, deleted_at)
     VALUES ($1, 'Journal', $2, '2026-03-01', 25, $3) RETURNING id`,
    [companyId, number, deleted ? new Date() : null]
  );
}

const live = (w: FactoryWorld, ids: number[]) =>
  w.q<{ id: number }>(`SELECT id FROM vouchers WHERE id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY id`, [ids]);

describe("orphaned charge voucher cleanup", () => {
  it("refuses Admin and Manager callers", async () => {
    await withFactoryWorld(async (w) => {
      const id = await chargeVoucher(w, w.companyId, `CHARGE-${w.tag}-1-FREIGHT`);
      const admin = await w.agent.post(URL);
      expect(admin.status).toBe(403);
      expect(admin.body.code).toBe("GLOBAL_MAINTENANCE_DEVELOPER_REQUIRED");
      const manager = await w.agentFor("Manager");
      expect((await manager.post(URL)).status).toBe(403);
      expect(await live(w, [id])).toEqual([{ id }]);
    });
  });

  it("reports nothing to clean for a company without charge vouchers", async () => {
    await withFactoryWorld(async (w) => {
      const dev = await w.agentFor("Developer");
      const res = await dev.post(URL);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: "Cleaned up 0 orphaned charge vouchers", deletedCount: 0 });
    });
  });

  it("retires only this company's live charge vouchers whose container has no purchase order", async () => {
    await withFactoryWorld(async (w) => {
      const supplierId = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2::varchar, $2::text, 'c@example.test')
         RETURNING id`,
        [w.companyId, `${w.tag}SUP`]
      );
      const containerId = await w.one(
        `INSERT INTO containers (company_id, container_number, import_date, supplier_id)
         VALUES ($1, $2, '2026-03-01', $3) RETURNING id`,
        [w.companyId, `${w.tag}-KEEP`, supplierId]
      );
      await w.q(
        `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id) VALUES ($1, $2, $3, $4)`,
        [w.companyId, containerId, `${w.tag}-PO1`, supplierId]
      );
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const kept = await chargeVoucher(w, w.companyId, `CHARGE-${w.tag}-KEEP-FREIGHT`);
      const orphan = await chargeVoucher(w, w.companyId, `CHARGE-${w.tag}-GONE-FREIGHT`);
      const alreadyRetired = await chargeVoucher(w, w.companyId, `CHARGE-${w.tag}-OLD-FREIGHT`, true);
      const plain = await chargeVoucher(w, w.companyId, `${w.tag}-JV-1`);
      const foreign = await chargeVoucher(w, other, `CHARGE-${w.tag}-FOREIGN-FREIGHT`);

      const dev = await w.agentFor("Developer");
      const res = await dev.post(URL);
      expect(res.status).toBe(200);
      expect(res.body.deletedCount).toBe(1);
      expect(await live(w, [kept, orphan, alreadyRetired, plain, foreign])).toEqual([
        { id: kept },
        { id: plain },
        { id: foreign },
      ]);
      const [row] = await w.q(`SELECT deleted_at IS NOT NULL AS retired FROM vouchers WHERE id = $1`, [orphan]);
      expect(row.retired).toBe(true);

      const again = await dev.post(URL);
      expect(again.body.deletedCount).toBe(0);
    });
  });
});
