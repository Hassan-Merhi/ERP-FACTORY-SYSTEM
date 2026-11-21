/**
 * /api/admin/repair-balances/undo refusals through the real app inside one
 * rolled-back transaction. Undo rebuilds from the stored record of the apply
 * run, so a tampered snapshot (amount, account, ledger value, dropped line), a
 * missing snapshot, and a missing, unknown or another company's run are each
 * refused with 409 and change nothing, while the genuine undo still works.
 * Stored runs naming another company's rows are in
 * balance-repair-undo-scope-coverage.test.ts (the privileged mutation rate
 * limit caps the requests one file can make).
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld } from "./helpers/rolledBackFactoryApp";
import { balanceRepairState, balanceRepairTransferRows, seedBalanceRepair } from "./helpers/balanceRepairFixture";

const APPLY = "/api/admin/repair-balances/apply";
const UNDO = "/api/admin/repair-balances/undo";

describe("balance repair undo of a stored run", () => {
  it("refuses an undo whose snapshot was tampered with and changes nothing, then undoes the genuine one", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w);
      const before = await balanceRepairState(w, seed);
      const transfersBefore = await balanceRepairTransferRows(w, seed);
      const applied = await w.agent.post(APPLY).send({});
      expect(applied.status).toBe(200);
      const { snapshot, repairRunId } = applied.body;
      const appliedState = await balanceRepairState(w, seed);

      const [otherAccount] = await w.q<{ id: number }>(
        `SELECT id FROM ledger_accounts WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
        [seed.otherCompanyId]
      );
      const withTransfer = (change: Record<string, unknown>) => ({
        ...snapshot,
        transfersDeleted: snapshot.transfersDeleted.map((t: Record<string, unknown>, i: number) =>
          i === 0 ? { ...t, ...change } : t
        ),
      });
      const tampered: Array<[string, unknown]> = [
        ["changed transfer amount", withTransfer({ amount: "7000" })],
        ["changed transfer account", withTransfer({ toLedgerAccountId: otherAccount.id })],
        ["changed ledger amount", { ...snapshot, ledgerSnapshots: [{ ...snapshot.ledgerSnapshots[0], oldPaid: 999 }] }],
        ["dropped voucher line", { ...snapshot, voucherEntriesAdded: snapshot.voucherEntriesAdded.slice(1) }],
      ];
      for (const [label, forged] of tampered) {
        const res = await w.agent.post(UNDO).send({ repairRunId, snapshot: forged });
        expect(res.status, label).toBe(409);
        expect(res.body.code, label).toBe("REPAIR_SNAPSHOT_MISMATCH");
        expect(await balanceRepairState(w, seed), label).toEqual(appliedState);
      }
      const missing = await w.agent.post(UNDO).send({ repairRunId });
      expect(missing.status).toBe(409);
      expect(missing.body.code).toBe("REPAIR_SNAPSHOT_MISSING");
      expect(await balanceRepairState(w, seed)).toEqual(appliedState);

      const genuine = await w.agent.post(UNDO).send({ repairRunId, snapshot });
      expect(genuine.status, JSON.stringify(genuine.body)).toBe(200);
      expect((await balanceRepairState(w, seed)).ledger).toEqual(before.ledger);
      expect(await balanceRepairTransferRows(w, seed)).toEqual(transfersBefore);
    }));

  it("refuses an undo with no run id, an unknown run or another company's run, and changes nothing", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w);
      const applied = await w.agent.post(APPLY).send({});
      expect(applied.status).toBe(200);
      const { snapshot, repairRunId } = applied.body;
      const appliedState = await balanceRepairState(w, seed);

      // The same stored record, but recorded for the other company.
      const [run] = await w.q<{ changes: unknown }>(`SELECT changes FROM audit_log WHERE id = $1`, [repairRunId]);
      const foreignRunId = await w.one(
        `INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_identifier, changes)
         VALUES ('test', 'test', $1, 'repair', 'balance_repair_runs', 'foreign-run', $2::jsonb) RETURNING id`,
        [seed.otherCompanyId, JSON.stringify(run.changes)]
      );
      const [voucherAudit] = await w.q<{ id: number }>(
        `SELECT id FROM audit_log WHERE table_name = 'vouchers' AND company_id = $1 ORDER BY id DESC LIMIT 1`,
        [w.companyId]
      );

      // A repair applied before undo records were kept has no run id.
      for (const [label, id] of [
        ["no run id", undefined],
        ["invalid run id", "abc"],
        ["unknown run id", 2147483000],
        ["another kind of audit row", voucherAudit.id],
        ["another company's run", foreignRunId],
      ] as const) {
        const res = await w.agent.post(UNDO).send({ repairRunId: id, snapshot });
        expect(res.status, label).toBe(409);
        expect(res.body.code, label).toBe("REPAIR_RUN_NOT_FOUND");
        expect(await balanceRepairState(w, seed), label).toEqual(appliedState);
      }
    }));
});
