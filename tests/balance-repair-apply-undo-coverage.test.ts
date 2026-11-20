/**
 * /api/admin/repair-balances apply and undo through the real app inside one
 * rolled-back transaction: what apply repairs (and only in the active
 * company), a second apply that finds nothing, undo of an applied snapshot,
 * undo repeated or of a snapshot that was never applied, apply in a closed
 * period, and the undo route's missing company check (pinned).
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { balanceRepairState, seedBalanceRepair, type BalanceRepairSeed } from "./helpers/balanceRepairFixture";

const APPLY = "/api/admin/repair-balances/apply";
const UNDO = "/api/admin/repair-balances/undo";

async function linesOf(w: FactoryWorld, voucherId: number) {
  return w.q<{ account: string; debit: string; credit: string }>(
    `SELECT la.name AS account, e.debit_amount::text AS debit, e.credit_amount::text AS credit
       FROM voucher_entries e JOIN ledger_accounts la ON la.id = e.ledger_account_id
      WHERE e.voucher_id = $1 ORDER BY e.id`,
    [voucherId]
  );
}

async function contractFlags(w: FactoryWorld, seed: BalanceRepairSeed) {
  return w.q(
    `SELECT id, guarantee_posted_to_statement AS flag, guarantee_posted_amount::text AS amount
       FROM property_contracts WHERE id = ANY($1::int[]) ORDER BY id`,
    [[seed.staleFlagContractId, seed.missingFlagContractId, seed.mismatchContractId, seed.otherContractId]]
  );
}

describe("balance repair apply and undo", () => {
  it("repairs every discrepancy in the active company, then finds nothing on a second run", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w);
      const otherBefore = await w.q(`SELECT paid_amount FROM property_monthly_ledger WHERE id = $1`, [
        seed.otherLedgerId,
      ]);
      const res = await w.agent.post(APPLY).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ ledgerFixed: 1, voucherEntriesFixed: 5, orphansFixed: 2, depositsFixed: 3 });
      expect(res.body.snapshot.ledgerSnapshots).toEqual([{ id: seed.driftLedgerId, oldPaid: 100, newPaid: 60 }]);
      expect(res.body.snapshot.vouchersUndeleted).toEqual([{ id: seed.deletedShopVoucherId }]);
      expect(res.body.snapshot.voucherEntriesAdded).toHaveLength(8);

      const [ledger] = await w.q(`SELECT paid_amount::text AS paid FROM property_monthly_ledger WHERE id = $1`, [
        seed.driftLedgerId,
      ]);
      expect(ledger.paid).toBe("60.00");
      expect(await w.q(`SELECT paid_amount FROM property_monthly_ledger WHERE id = $1`, [seed.otherLedgerId])).toEqual(
        otherBefore
      );

      // Warehouse rent: debit cash, credit the module's income account.
      expect(await linesOf(w, seed.emptyVoucherId)).toEqual([
        { account: `Cash ${w.tag}`, debit: "60.00", credit: "0.00" },
        { account: "Rental Income", debit: "0.00", credit: "60.00" },
      ]);
      expect((await linesOf(w, seed.erpVoucherId))[1].account).toBe("Rent Income - ERP");
      expect((await linesOf(w, seed.factoryVoucherId))[1].account).toBe("Rent Income - Factory");
      // Shop rent: un-deleted, debit the expense, credit cash.
      expect(await linesOf(w, seed.deletedShopVoucherId)).toEqual([
        { account: "Rent Expense - Shops", debit: "40.00", credit: "0.00" },
        { account: `Cash ${w.tag}`, debit: "0.00", credit: "40.00" },
      ]);
      const [shop] = await w.q(`SELECT deleted_at IS NULL AS live FROM vouchers WHERE id = $1`, [
        seed.deletedShopVoucherId,
      ]);
      expect(shop.live).toBe(true);
      // No cash account on the payment: the voucher stays empty.
      expect(await linesOf(w, seed.noCashVoucherId)).toEqual([]);

      const transfers = await w.q(`SELECT id FROM inter_company_transfers WHERE id = ANY($1::int[])`, [
        [seed.toOrphanTransferId, seed.fromOrphanTransferId],
      ]);
      expect(transfers).toEqual([]);
      const retired = await w.q<{ id: number; deleted: boolean; number: string }>(
        `SELECT id, deleted_at IS NOT NULL AS deleted, voucher_number AS number FROM vouchers
          WHERE id = $1`,
        [seed.toOrphanVoucherId]
      );
      expect(retired[0].deleted).toBe(true);
      expect(retired[0].number).not.toBe(`${w.tag}-TT1`);

      expect(await contractFlags(w, seed)).toEqual([
        { id: seed.staleFlagContractId, flag: false, amount: "0.00" },
        { id: seed.missingFlagContractId, flag: true, amount: "400.00" },
        { id: seed.mismatchContractId, flag: true, amount: "500.00" },
        { id: seed.otherContractId, flag: true, amount: "200.00" },
      ]);

      const again = await w.agent.post(APPLY).send({});
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ ledgerFixed: 0, orphansFixed: 0, depositsFixed: 0 });
      // The payment without a cash account is still reported as unfixable-but-seen.
      expect(again.body.voucherEntriesFixed).toBe(1);
      expect(again.body.snapshot.voucherEntriesAdded).toEqual([]);
    }));

  it("undo restores the applied snapshot, and a repeated undo changes nothing more", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w);
      const before = await balanceRepairState(w, seed);
      const applied = await w.agent.post(APPLY).send({});
      expect(applied.status).toBe(200);
      const { snapshot } = applied.body;

      const undo = await w.agent.post(UNDO).send({ snapshot });
      expect(undo.status, JSON.stringify(undo.body)).toBe(200);
      expect(undo.body).toEqual({ ledgerRestored: 1, entriesRemoved: 8, orphansRestored: 2, depositsRestored: 3 });

      const after = await balanceRepairState(w, seed);
      // Ledger rows, flags, transfers and voucher lines come back; the income
      // and expense accounts apply created stay behind.
      expect(after.ledger).toEqual(before.ledger);
      // A contract whose posted amount was NULL comes back as 0.00.
      expect(after.contracts).toEqual(
        before.contracts.map((c) =>
          c.id === seed.missingFlagContractId ? { ...c, guarantee_posted_amount: "0.00" } : c
        )
      );
      expect(after.transfers).toEqual(before.transfers);
      // BUG (pinned): the FROM-side voucher was already soft-deleted before
      // apply. Apply retires it again and records it in the snapshot, so undo
      // brings it back to life - a voucher deleted on purpose reappears.
      const revived = (v: Record<string, unknown>) =>
        v.id === seed.fromOrphanVoucherId ? { ...v, deleted: false } : v;
      expect(after.vouchers).toEqual(before.vouchers.map(revived));
      expect(after.accounts.length).toBeGreaterThan(before.accounts.length);

      const audit = await w.q(
        `SELECT record_id FROM audit_log WHERE table_name = 'vouchers' AND action = 'restore' AND record_id = $1`,
        [String(seed.toOrphanVoucherId)]
      );
      expect(audit).toHaveLength(1);

      const repeat = await w.agent.post(UNDO).send({ snapshot });
      expect(repeat.status).toBe(200);
      const afterRepeat = await balanceRepairState(w, seed);
      expect(afterRepeat.ledger).toEqual(before.ledger);
      expect(afterRepeat.transfers).toEqual(before.transfers);
      expect(afterRepeat.vouchers).toEqual(before.vouchers.map(revived));
      const auditAgain = await w.q(
        `SELECT record_id FROM audit_log WHERE table_name = 'vouchers' AND action = 'restore' AND record_id = $1`,
        [String(seed.toOrphanVoucherId)]
      );
      expect(auditAgain).toHaveLength(1);
    }));

  it("undo of a snapshot that was never applied restores no voucher", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w);
      const before = await balanceRepairState(w, seed);
      const res = await w.agent.post(UNDO).send({
        snapshot: {
          voucherEntriesAdded: [2147483000],
          orphanedVouchersDeleted: [
            { id: seed.fromOrphanVoucherId, voucherNumber: `${w.tag}-TF2` },
            { id: 0, voucherNumber: "X" },
            { id: "abc", voucherNumber: "Y" },
            { id: seed.toOrphanVoucherId, voucherNumber: 42 },
          ],
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // Counts echo the snapshot, not what changed.
      expect(res.body).toEqual({ ledgerRestored: 0, entriesRemoved: 1, orphansRestored: 0, depositsRestored: 0 });
      // The soft-deleted FROM voucher was not retired by apply, so its number
      // does not match the retired form and it stays deleted.
      expect(await balanceRepairState(w, seed)).toEqual(before);
    }));

  it("undo writes to rows of another company named in the snapshot (no company check)", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w);
      const res = await w.agent.post(UNDO).send({
        snapshot: {
          ledgerSnapshots: [{ id: seed.otherLedgerId, oldPaid: 1.5, newPaid: 90 }],
          depositSnapshots: [
            {
              contractId: seed.otherContractId,
              oldFlag: false,
              newFlag: true,
              oldPostedAmount: 0,
              newPostedAmount: 200,
            },
          ],
        },
      });
      expect(res.status).toBe(200);
      // BUG (pinned): undo.ts updates property_monthly_ledger and
      // property_contracts by id alone, so an Admin of one company rewrites
      // another company's rows.
      const [ledger] = await w.q(`SELECT paid_amount::text AS paid FROM property_monthly_ledger WHERE id = $1`, [
        seed.otherLedgerId,
      ]);
      expect(ledger.paid).toBe("1.50");
      const [contract] = await w.q(
        `SELECT guarantee_posted_to_statement AS flag FROM property_contracts WHERE id = $1`,
        [seed.otherContractId]
      );
      expect(contract.flag).toBe(false);
    }));

  it("apply into a closed accounting period fails with the period guard", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w, "2025-06-10");
      const retained = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, active) VALUES ($1, $2, 'RE', 'Equity', true) RETURNING id`,
        [w.companyId, `${w.tag}RE`]
      );
      await w.q(
        `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
           closing_voucher_id, net_income, total_income, total_expense, retained_earnings_account_id)
         VALUES ($1, '2025-01-01', '2025-12-31', $2, $3, 0, 0, 0, $4)`,
        [w.companyId, w.userId, seed.healthyVoucherId, retained]
      );
      await w.q(`SAVEPOINT before_apply`);
      const res = await w.agent.post(APPLY).send({});
      expect(res.status).toBe(500);
      expect(String(res.body.message)).toMatch(/clos|period|lock/i);
      await w.q(`ROLLBACK TO SAVEPOINT before_apply`);
    }));
});
