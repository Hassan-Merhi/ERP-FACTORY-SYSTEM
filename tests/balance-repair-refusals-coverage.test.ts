/**
 * /api/admin/repair-balances refusals through the real app inside one
 * rolled-back transaction: no session, non-Admin roles, an Admin without the
 * named repair permission, a session with no company, an empty undo, and a
 * scan (the tool's dry run) that only reports and never writes. Every refusal
 * leaves the seeded discrepancies exactly as they were.
 */
import request from "supertest";
import { describe, expect, it } from "vitest";

import { rolledBackApp, withFactoryWorld } from "./helpers/rolledBackFactoryApp";
import { balanceRepairState, seedBalanceRepair } from "./helpers/balanceRepairFixture";

const SCAN = "/api/admin/repair-balances/scan";
const APPLY = "/api/admin/repair-balances/apply";
const UNDO = "/api/admin/repair-balances/undo";
const REALLOCATE = "/api/properties/repair/reallocate-payments";

describe("balance repair refusals", () => {
  it("refuses anonymous callers on every endpoint", async () => {
    const app = await rolledBackApp();
    for (const [method, url] of [
      ["get", SCAN],
      ["post", APPLY],
      ["post", UNDO],
      ["post", `${REALLOCATE}/1`],
    ] as const) {
      const res = await request(app)[method](url).send({});
      expect(res.status, url).toBe(401);
    }
  });

  it("refuses Manager and Owner callers and writes nothing", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w);
      const before = await balanceRepairState(w, seed);
      for (const role of ["Manager", "Owner", "View Only"]) {
        const agent = await w.agentFor(role);
        expect((await agent.get(SCAN)).status, role).toBe(403);
        const apply = await agent.post(APPLY).send({});
        expect(apply.status, role).toBe(403);
        const undo = await agent.post(UNDO).send({ snapshot: { ledgerSnapshots: [] } });
        expect(undo.status, role).toBe(403);
        expect((await agent.post(`${REALLOCATE}/${seed.contractId}`).send({})).status, role).toBe(403);
      }
      expect(await balanceRepairState(w, seed)).toEqual(before);
    }));

  it("refuses an Admin who lacks the named repair permission", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w);
      const before = await balanceRepairState(w, seed);
      await w.q(
        `DELETE FROM user_security_permissions WHERE user_id = $1 AND company_id = $2 AND permission = 'administration.repair'`,
        [w.userId, w.companyId]
      );
      const apply = await w.agent.post(APPLY).send({});
      expect(apply.status).toBe(403);
      expect(apply.body.code).toBe("PRIVILEGED_MAINTENANCE_PERMISSION_REQUIRED");
      const undo = await w.agent.post(UNDO).send({
        snapshot: { ledgerSnapshots: [{ id: seed.driftLedgerId, oldPaid: 1, newPaid: 2 }] },
      });
      expect(undo.status).toBe(403);
      expect(undo.body.code).toBe("PRIVILEGED_MAINTENANCE_PERMISSION_REQUIRED");
      // The scan is a read: the Admin role alone admits it.
      expect((await w.agent.get(SCAN)).status).toBe(200);
      expect(await balanceRepairState(w, seed)).toEqual(before);
    }));

  it("refuses an Admin whose role in the selected company was removed", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w);
      const before = await balanceRepairState(w, seed);
      // The session still names the company, but the user no longer belongs to
      // it: the access boundary refuses before any handler runs.
      await w.q(`DELETE FROM user_company_roles WHERE user_id = $1 AND company_id = $2`, [w.userId, w.companyId]);
      for (const res of [await w.agent.get(SCAN), await w.agent.post(APPLY).send({})]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("ACTIVE_COMPANY_ROLE_REQUIRED");
      }
      expect(await balanceRepairState(w, seed)).toEqual(before);
    }));

  it("rejects an undo without a snapshot", () =>
    withFactoryWorld(async (w) => {
      const res = await w.agent.post(UNDO).send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("No snapshot provided");
    }));

  it("scan reports every discrepancy of the active company only and writes nothing", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w);
      const before = await balanceRepairState(w, seed);
      const res = await w.agent.get(SCAN);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const body = res.body;

      expect(body.ledgerDrifts).toEqual([
        expect.objectContaining({
          id: seed.driftLedgerId,
          tenantName: "Tenant W",
          storedPaid: 100,
          computedPaid: 60,
          diff: 40,
          unitLabel: `Block/${w.tag}W`,
        }),
      ]);
      expect(body.ledgerDrifts.some((d: { id: number }) => d.id === seed.otherLedgerId)).toBe(false);

      const missing = new Map(body.voucherEntryMissing.map((m: { voucherId: number }) => [m.voucherId, m]));
      expect([...missing.keys()].sort((a, b) => Number(a) - Number(b))).toEqual(
        [
          seed.emptyVoucherId,
          seed.deletedShopVoucherId,
          seed.erpVoucherId,
          seed.factoryVoucherId,
          seed.noCashVoucherId,
        ].sort((a, b) => a - b)
      );
      expect(missing.get(seed.emptyVoucherId)).toMatchObject({ issue: "EMPTY_VOUCHER", unitType: "WAREHOUSE" });
      expect(missing.get(seed.deletedShopVoucherId)).toMatchObject({
        issue: "SOFT_DELETED_VOUCHER",
        unitType: "SHOP",
        tenantName: "Tenant S",
      });
      expect(missing.get(seed.noCashVoucherId)).toMatchObject({
        cashAccountId: null,
        cashAccountName: "(unknown account)",
      });

      const orphans = body.orphanedTransfers.map((o: Record<string, unknown>) => [
        o.transferId,
        o.orphanedSide,
        o.issue,
        o.orphanedVoucherId,
      ]);
      expect(orphans).toEqual(
        expect.arrayContaining([
          [seed.toOrphanTransferId, "TO", "EMPTY_ENTRIES", seed.toOrphanVoucherId],
          [seed.fromOrphanTransferId, "FROM", "SOFT_DELETED", seed.fromOrphanVoucherId],
        ])
      );
      expect(orphans).toHaveLength(2);

      const deposits = body.depositFlagMismatches.map((d: Record<string, unknown>) => [d.contractId, d.issue]);
      expect(deposits).toEqual(
        expect.arrayContaining([
          [seed.staleFlagContractId, "STALE_FLAG"],
          [seed.missingFlagContractId, "MISSING_FLAG"],
          [seed.mismatchContractId, "AMOUNT_MISMATCH"],
        ])
      );
      expect(deposits).toHaveLength(3);
      expect(deposits.some(([id]: [number]) => id === seed.otherContractId)).toBe(false);
      expect(body.totalDiscrepancies).toBe(1 + 5 + 2 + 3);

      expect(await balanceRepairState(w, seed)).toEqual(before);
    }));

  it("scan of a clean company reports nothing", () =>
    withFactoryWorld(async (w) => {
      const res = await w.agent.get(SCAN);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ledgerDrifts: [],
        voucherEntryMissing: [],
        orphanedTransfers: [],
        depositFlagMismatches: [],
        totalDiscrepancies: 0,
      });
    }));
});
