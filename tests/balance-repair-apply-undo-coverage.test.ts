/**
 * /api/admin/repair-balances apply and undo through the real app inside one
 * rolled-back transaction: what apply repairs (and only in the active
 * company), a second apply that finds nothing, undo of an applied run rebuilt
 * from its stored record, a second undo of the same run (refused), and apply
 * in a closed period (a clean 409 that leaves nothing half applied). The undo
 * refusals live in balance-repair-undo-run-coverage.test.ts (the privileged
 * mutation rate limit allows 30 requests per file).
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import {
  balanceRepairState,
  balanceRepairTransferRows,
  seedBalanceRepair,
  type BalanceRepairSeed,
} from "./helpers/balanceRepairFixture";

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
      // The FROM-side voucher was already soft-deleted: apply leaves it as it
      // was and keeps it out of the snapshot, so undo cannot revive it.
      const [fromSide] = await w.q(
        `SELECT deleted_at IS NOT NULL AS deleted, voucher_number AS number FROM vouchers
          WHERE id = $1`,
        [seed.fromOrphanVoucherId]
      );
      expect(fromSide).toEqual({ deleted: true, number: `${w.tag}-TF2` });
      expect(res.body.snapshot.orphanedVouchersDeleted.map((v: { id: number }) => v.id)).toEqual([
        seed.toOrphanVoucherId,
      ]);

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

  it("leaves another company's vouchers alone when the active company's rows point at them", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w);
      // A payment of the active company that points at another company's
      // soft-deleted, empty voucher: apply must not un-delete it or post into it.
      const [foreign] = await w.q<{ id: number }>(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, description, deleted_at)
         VALUES ($1, $2, 'Receipt', '2026-05-10', '15.00', 'foreign', now()) RETURNING id`,
        [seed.otherCompanyId, `${w.tag}-FX`]
      );
      await w.q(
        `INSERT INTO property_payments (company_id, module, contract_id, unit_id, amount, payment_date, for_year, for_month,
           voucher_id, cash_account_id)
         VALUES ($1, 'PROPERTIES', $2, $3, '15.00', '2026-05-10', 2026, 4, $4, $5)`,
        [w.companyId, seed.contractId, seed.warehouseUnitId, foreign.id, seed.cashId]
      );
      // A transfer whose TO side names an empty voucher of the FROM company:
      // apply must not retire a voucher that is not the TO company's.
      const [wrongSide] = await w.q<{ id: number }>(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, description)
         VALUES ($1, $2, 'Receipt', '2026-05-10', '70.00', 'wrong side') RETURNING id`,
        [w.companyId, `${w.tag}-WS`]
      );
      const [fromGood] = await w.q<{ id: number }>(
        `SELECT id FROM vouchers WHERE company_id = $1 AND voucher_number = $2`,
        [w.companyId, `${w.tag}-TF3`]
      );
      const [toCash] = await w.q<{ id: number }>(
        `SELECT id FROM ledger_accounts WHERE company_id = $1 ORDER BY id LIMIT 1`,
        [seed.otherCompanyId]
      );
      const [wrongTransfer] = await w.q<{ id: number }>(
        `INSERT INTO inter_company_transfers (transfer_type, from_company_id, to_company_id, transfer_date, amount,
           from_ledger_account_id, to_ledger_account_id, from_voucher_id, to_voucher_id, description)
         VALUES ('Cash', $1, $2, '2026-05-10', 70, $3, $4, $5, $6, 'wrong side') RETURNING id`,
        [w.companyId, seed.otherCompanyId, seed.cashId, toCash.id, fromGood.id, wrongSide.id]
      );

      const res = await w.agent.post(APPLY).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.snapshot.vouchersUndeleted).toEqual([{ id: seed.deletedShopVoucherId }]);
      expect(res.body.orphansFixed).toBe(2);
      const ids = res.body.snapshot.orphanedVouchersDeleted.map((v: { id: number }) => v.id);
      expect(ids).not.toContain(wrongSide.id);

      const vouchers = await w.q(
        `SELECT id, deleted_at IS NOT NULL AS deleted, voucher_number AS number,
                (SELECT COUNT(*)::int FROM voucher_entries e WHERE e.voucher_id = v.id) AS lines
           FROM vouchers v WHERE id = ANY($1::int[]) ORDER BY id`,
        [[foreign.id, wrongSide.id]]
      );
      expect(vouchers).toEqual([
        { id: foreign.id, deleted: true, number: `${w.tag}-FX`, lines: 0 },
        { id: wrongSide.id, deleted: false, number: `${w.tag}-WS`, lines: 0 },
      ]);
      expect(await w.q(`SELECT id FROM inter_company_transfers WHERE id = $1`, [wrongTransfer.id])).toEqual([
        { id: wrongTransfer.id },
      ]);
    }));

  it("undo rebuilds the applied run from its stored record, and a second undo is refused", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w);
      const before = await balanceRepairState(w, seed);
      const transfersBefore = await balanceRepairTransferRows(w, seed);
      const applied = await w.agent.post(APPLY).send({});
      expect(applied.status).toBe(200);
      const { snapshot, repairRunId } = applied.body;
      expect(Number.isInteger(repairRunId) && repairRunId > 0).toBe(true);
      const [run] = await w.q(`SELECT company_id, table_name, action FROM audit_log WHERE id = $1`, [repairRunId]);
      expect(run).toEqual({ company_id: w.companyId, table_name: "balance_repair_runs", action: "repair" });

      const undo = await w.agent.post(UNDO).send({ repairRunId, snapshot });
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
      // The transfers come back exactly as they were, created_at included.
      expect(await balanceRepairTransferRows(w, seed)).toEqual(transfersBefore);
      // The FROM-side voucher was soft-deleted before apply and stays deleted.
      expect(after.vouchers).toEqual(before.vouchers);
      expect(after.accounts.length).toBeGreaterThan(before.accounts.length);

      const restoreAudit = () =>
        w.q(`SELECT record_id FROM audit_log WHERE table_name = 'vouchers' AND action = 'restore' AND record_id = $1`, [
          String(seed.toOrphanVoucherId),
        ]);
      expect(await restoreAudit()).toHaveLength(1);
      expect(
        await w.q(
          `SELECT company_id FROM audit_log WHERE table_name = 'balance_repair_runs' AND action = 'reverse' AND record_id = $1`,
          [repairRunId]
        )
      ).toEqual([{ company_id: w.companyId }]);

      const repeat = await w.agent.post(UNDO).send({ repairRunId, snapshot });
      expect(repeat.status).toBe(409);
      expect(repeat.body.code).toBe("REPAIR_RUN_ALREADY_UNDONE");
      expect(await balanceRepairState(w, seed)).toEqual(after);
      expect(await balanceRepairTransferRows(w, seed)).toEqual(transfersBefore);
      expect(await restoreAudit()).toHaveLength(1);
    }));

  it("apply into a closed accounting period is refused with 409 and writes nothing", () =>
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
      const before = await balanceRepairState(w, seed);
      const res = await w.agent.post(APPLY).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
      expect(res.body.message).toMatch(/closed through 2025-12-31/);
      expect(res.body.message).not.toMatch(/Failed query/);
      // The ledger drift fixed before the refused voucher line is rolled back
      // with it, and the ledger accounts apply would have created are gone.
      expect(await balanceRepairState(w, seed)).toEqual(before);
    }));
});
