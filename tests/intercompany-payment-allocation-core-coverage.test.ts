/**
 * Signed PO credit allocation core: oldest-first automatic credit at import,
 * excess release on a PO cost decrease and full release on payment reversal.
 * Real mirrored payments (paired Receipt/Payment vouchers that satisfy the
 * payment-pair trigger) are seeded inside one rolled-back transaction.
 */
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import { db } from "../server/db";
import { withRolledBackPool } from "./helpers/routedPoolClient";
import { createIntercompanyTradeWorld, type IntercompanyTradeWorld } from "./helpers/intercompanyTradeFixture";
import {
  autoAllocateNewTradeCreditTx,
  pairCreditsTx,
  paymentAvailableTx,
  releaseEditOverallocationTx,
  releasePaymentAllocationsTx,
  tradeAppliedTx,
} from "../server/services/intercompany/paymentAllocationCore";

let paySeq = 0;

async function cashLedgers(world: IntercompanyTradeWorld) {
  return {
    source: await world.ledger(world.sourceCompanyId, "CASH", "Cash"),
    destination: await world.ledger(world.destinationCompanyId, "CASH", "Cash"),
  };
}

/** One confirmed mirrored payment of `amount` USD on `date`. */
async function payment(
  world: IntercompanyTradeWorld,
  cash: { source: number; destination: number },
  amount: string,
  date: string
) {
  const n = ++paySeq;
  const receipt = await world.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Receipt', $3, $4) RETURNING id`,
    [world.sourceCompanyId, `${world.tag}-RC${n}`, date, amount]
  );
  await world.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
     VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [receipt, cash.source, amount, world.accounts.sourceReceivableAccountId]
  );
  const paid = await world.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Payment', $3, $4) RETURNING id`,
    [world.destinationCompanyId, `${world.tag}-PY${n}`, date, amount]
  );
  await world.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 0, $3)`,
    [paid, cash.destination, amount]
  );
  await world.q(
    `INSERT INTO voucher_entries (voucher_id, supplier_id, debit_amount, credit_amount) VALUES ($1, $2, $3, 0)`,
    [paid, world.partnerSupplierId, amount]
  );
  return world.one(
    `INSERT INTO intercompany_container_payments (relationship_id, source_company_id, destination_company_id,
       request_key, request_fingerprint, transfer_reference, confirmation_evidence, payment_date, transaction_currency,
       transaction_amount, historical_rate, base_amount, source_cash_type, source_cash_id, destination_cash_type,
       destination_cash_id, source_receivable_account_id, destination_supplier_id, source_receipt_voucher_id,
       destination_payment_voucher_id, created_by)
     VALUES ($1, $2, $3, $4, repeat('a', 64), $4, 'bank statements', $5, 'USD', $6, 1, $6, 'cash', $7, 'cash', $8,
       $9, $10, $11, $12, $13) RETURNING id`,
    [
      world.relationshipId,
      world.sourceCompanyId,
      world.destinationCompanyId,
      `${world.tag}-PAY${n}`,
      date,
      amount,
      cash.source,
      cash.destination,
      world.accounts.sourceReceivableAccountId,
      world.partnerSupplierId,
      receipt,
      paid,
      world.userId,
    ]
  );
}

async function allocate(client: PoolClient, paymentId: number, tradeId: number, amount: string, kind: string) {
  await client.query(
    `INSERT INTO intercompany_payment_allocations (payment_id, trade_id, amount, allocation_kind, request_key, reason)
     VALUES ($1, $2, $3, $4, $5, 'fixture')`,
    [paymentId, tradeId, amount, kind, `fx-${paymentId}-${tradeId}-${kind}-${++paySeq}`]
  );
}

const allocations = async (world: IntercompanyTradeWorld, tradeId: number) =>
  world.q<{ payment_id: string; amount: string; allocation_kind: string }>(
    `SELECT payment_id, amount, allocation_kind FROM intercompany_payment_allocations WHERE trade_id = $1 ORDER BY id`,
    [tradeId]
  );

describe("intercompany payment allocation core", () => {
  it("refuses unknown payments, wrong pairs and missing trades without writing", async () => {
    await withRolledBackPool(async (client) => {
      const world = await createIntercompanyTradeWorld(client);
      const trade = await world.trade("A");
      await db.transaction(async (tx) => {
        await expect(paymentAvailableTx(tx, 999999999)).rejects.toThrow("Verified intercompany payment not found");
        await expect(
          autoAllocateNewTradeCreditTx(tx, {
            tradeId: trade.tradeId,
            relationshipId: world.relationshipId + 100000,
            confirmedLandedCost: "100.00",
          })
        ).rejects.toThrow("same company pair");
        await expect(
          autoAllocateNewTradeCreditTx(tx, {
            tradeId: 999999999,
            relationshipId: world.relationshipId,
            confirmedLandedCost: "100.00",
          })
        ).rejects.toThrow("verified new active trade");
      });
      expect(await allocations(world, trade.tradeId)).toHaveLength(0);
    });
  });

  it("applies existing pair credit oldest first and reports the remaining due", async () => {
    await withRolledBackPool(async (client) => {
      const world = await createIntercompanyTradeWorld(client);
      const cash = await cashLedgers(world);
      const first = await world.trade("A");
      const second = await world.trade("B");
      const newer = await payment(world, cash, "30.00", "2026-06-20");
      const older = await payment(world, cash, "50.00", "2026-06-10");
      const spent = await payment(world, cash, "20.00", "2026-06-05");
      await allocate(client, spent, first.tradeId, "20.00", "manual");
      await db.transaction(async (tx) => {
        expect((await paymentAvailableTx(tx, spent)).toFixed(2)).toBe("0.00");
        const credits = await pairCreditsTx(tx, world.relationshipId);
        expect(credits.map((c) => c.id)).toEqual([older, newer]);
        const result = await autoAllocateNewTradeCreditTx(tx, {
          tradeId: second.tradeId,
          relationshipId: world.relationshipId,
          confirmedLandedCost: "100.00",
        });
        expect(result).toEqual({ applied: "80.00", remainingDue: "20.00" });
        expect((await tradeAppliedTx(tx, second.tradeId)).toFixed(2)).toBe("80.00");
        // No credit left: a second import of the pair applies nothing.
        expect(await pairCreditsTx(tx, world.relationshipId)).toEqual([]);
      });
      const rows = await allocations(world, second.tradeId);
      expect(rows.map((r) => [Number(r.payment_id), r.amount, r.allocation_kind])).toEqual([
        [older, "50.00", "new_import_credit"],
        [newer, "30.00", "new_import_credit"],
      ]);
    });
  });

  it("refuses when an existing allocation already exceeds the confirmed cost", async () => {
    await withRolledBackPool(async (client) => {
      const world = await createIntercompanyTradeWorld(client);
      const cash = await cashLedgers(world);
      const trade = await world.trade("A");
      const paid = await payment(world, cash, "90.00", "2026-06-10");
      await allocate(client, paid, trade.tradeId, "90.00", "manual");
      await db.transaction(async (tx) => {
        await expect(
          autoAllocateNewTradeCreditTx(tx, {
            tradeId: trade.tradeId,
            relationshipId: world.relationshipId,
            confirmedLandedCost: "60.00",
          })
        ).rejects.toThrow("exceeds its confirmed cost");
      });
      expect(await allocations(world, trade.tradeId)).toHaveLength(1);
    });
  });

  it("flags a trade whose allocations net negative as unreconciled", async () => {
    await withRolledBackPool(async (client) => {
      const world = await createIntercompanyTradeWorld(client);
      const cash = await cashLedgers(world);
      const trade = await world.trade("A");
      const paid = await payment(world, cash, "40.00", "2026-06-10");
      await allocate(client, paid, trade.tradeId, "10.00", "manual");
      await allocate(client, paid, trade.tradeId, "-25.00", "reversal_release");
      await db.transaction(async (tx) => {
        await expect(tradeAppliedTx(tx, trade.tradeId)).rejects.toThrow("unreconciled");
        await expect(releasePaymentAllocationsTx(tx, { paymentId: paid, actorUserId: world.userId })).rejects.toThrow(
          "Negative allocation"
        );
      });
    });
  });

  it("releases only the excess on a cost decrease, import credit first", async () => {
    await withRolledBackPool(async (client) => {
      const world = await createIntercompanyTradeWorld(client);
      const cash = await cashLedgers(world);
      const trade = await world.trade("A");
      const manualPay = await payment(world, cash, "60.00", "2026-06-10");
      const creditPay = await payment(world, cash, "40.00", "2026-06-11");
      await allocate(client, manualPay, trade.tradeId, "60.00", "manual");
      await allocate(client, creditPay, trade.tradeId, "40.00", "new_import_credit");
      await db.transaction(async (tx) => {
        const none = await releaseEditOverallocationTx(tx, {
          tradeId: trade.tradeId,
          newLandedCost: "100.00",
          actorUserId: world.userId,
          revisionId: 1,
        });
        expect(none).toEqual({ released: "0.00", details: [] });
        const result = await releaseEditOverallocationTx(tx, {
          tradeId: trade.tradeId,
          newLandedCost: "45.00",
          actorUserId: world.userId,
          revisionId: 2,
        });
        expect(result).toEqual({
          released: "55.00",
          details: [
            { paymentId: creditPay, amount: "40.00" },
            { paymentId: manualPay, amount: "15.00" },
          ],
        });
        expect((await tradeAppliedTx(tx, trade.tradeId)).toFixed(2)).toBe("45.00");
      });
      const kinds = (await allocations(world, trade.tradeId)).map((r) => [r.allocation_kind, r.amount]);
      expect(kinds.slice(2)).toEqual([
        ["edit_release", "-40.00"],
        ["edit_release", "-15.00"],
      ]);
    });
  });

  it("skips already released payments and audit-only kinds while releasing", async () => {
    await withRolledBackPool(async (client) => {
      const world = await createIntercompanyTradeWorld(client);
      const cash = await cashLedgers(world);
      const trade = await world.trade("A");
      const released = await payment(world, cash, "30.00", "2026-06-10");
      const kept = await payment(world, cash, "50.00", "2026-06-11");
      await allocate(client, released, trade.tradeId, "30.00", "new_import_credit");
      await allocate(client, released, trade.tradeId, "-30.00", "reversal_release");
      await allocate(client, kept, trade.tradeId, "50.00", "manual");
      await db.transaction(async (tx) => {
        const result = await releaseEditOverallocationTx(tx, {
          tradeId: trade.tradeId,
          newLandedCost: "20.00",
          actorUserId: world.userId,
          revisionId: 7,
        });
        expect(result).toEqual({ released: "30.00", details: [{ paymentId: kept, amount: "30.00" }] });
      });
    });
  });

  it("reverses every net trade allocation of a payment and skips fully released trades", async () => {
    await withRolledBackPool(async (client) => {
      const world = await createIntercompanyTradeWorld(client);
      const cash = await cashLedgers(world);
      const first = await world.trade("A");
      const second = await world.trade("B");
      const paid = await payment(world, cash, "70.00", "2026-06-10");
      await allocate(client, paid, first.tradeId, "45.00", "manual");
      await allocate(client, paid, second.tradeId, "25.00", "manual");
      await allocate(client, paid, second.tradeId, "-25.00", "edit_release");
      await db.transaction(async (tx) => {
        const result = await releasePaymentAllocationsTx(tx, { paymentId: paid, actorUserId: world.userId });
        expect(result).toEqual([{ tradeId: first.tradeId, amount: "45.00" }]);
        expect((await paymentAvailableTx(tx, paid)).toFixed(2)).toBe("70.00");
      });
      const [last] = (await allocations(world, first.tradeId)).slice(-1);
      expect([last.allocation_kind, last.amount]).toEqual(["reversal_release", "-45.00"]);
    });
  });
});
