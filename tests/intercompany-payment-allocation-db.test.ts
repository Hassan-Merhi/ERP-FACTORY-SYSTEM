/**
 * How intercompany payment credit is applied to and released from company-pair
 * POs (server/services/intercompany/paymentAllocationCore.ts), against the real
 * database.
 *
 * The trades and payments are written with triggers off (session replication
 * role "replica"), because building the vouchers, containers and POs behind
 * them is not what is under test. Triggers go back on before the service runs,
 * so the append-only allocation guard checks every row the service writes.
 * Each case runs in a transaction that is always rolled back.
 *
 * What is pinned:
 *   - a new import consumes the pair's confirmed credit oldest first, only up
 *     to what is still due, and never another pair's or a reversed payment;
 *   - a PO cost decrease releases automatic credit before manual allocations,
 *     newest first, and does nothing when nothing is overpaid;
 *   - reversing a payment releases exactly what it had applied, per trade.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, type DbTransaction } from "../server/db";
import { resultRows } from "../server/lib/queryResult";
import {
  autoAllocateNewTradeCreditTx,
  pairCreditsTx,
  paymentAvailableTx,
  releaseEditOverallocationTx,
  releasePaymentAllocationsTx,
  tradeAppliedTx,
} from "../server/services/intercompany/paymentAllocationCore";

class RolledBack extends Error {}

async function inRolledBackTransaction(work: (tx: DbTransaction) => Promise<void>) {
  try {
    await db.transaction(async (tx) => {
      await work(tx as DbTransaction);
      throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
    return;
  }
  throw new Error("the fixture transaction was not rolled back");
}

const all = async (tx: DbTransaction, query: ReturnType<typeof sql>) => resultRows(await tx.execute(query));

// Identifiers far above anything a test database holds; triggers (and so
// foreign keys) are off while these rows are written.
const BASE = 880_000_000 + (process.pid % 1000) * 1000;
const PAIR = { relationship: BASE + 1, source: BASE + 2, destination: BASE + 3 };
const OTHER_PAIR = { relationship: BASE + 11, source: BASE + 2, destination: BASE + 13 };
const ACTOR = `ic-alloc-${BASE}`;

type Pair = typeof PAIR;

async function withoutTriggers(tx: DbTransaction, work: () => Promise<void>) {
  await tx.execute(sql`SET LOCAL session_replication_role = replica`);
  await work();
  await tx.execute(sql`SET LOCAL session_replication_role = origin`);
}

let nextId = BASE + 100;

async function trade(tx: DbTransaction, pair: Pair, state: "active" | "pending" | "canceled" = "active") {
  const id = (nextId += 1);
  await tx.execute(sql`
    INSERT INTO intercompany_trades
      (id, relationship_id, physical_container_id, source_company_id, destination_company_id,
       original_supplier_po_id, destination_po_id, state)
    VALUES (${id}, ${pair.relationship}, ${id}, ${pair.source}, ${pair.destination}, ${id}, ${id + 1}, ${state})
  `);
  return id;
}

async function payment(
  tx: DbTransaction,
  pair: Pair,
  amount: string,
  paymentDate: string,
  status: "confirmed" | "reversed" = "confirmed"
) {
  const id = (nextId += 1);
  const reversed =
    status === "reversed"
      ? sql`${ACTOR}, NOW(), ${paymentDate}::date, 'Bank recalled it', ${"rev-" + id}, ${"b".repeat(64)}, ${id + 2}, ${id + 3}`
      : sql`NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL`;
  await tx.execute(sql`
    INSERT INTO intercompany_container_payments
      (id, relationship_id, source_company_id, destination_company_id, request_key, request_fingerprint,
       transfer_reference, confirmation_evidence, payment_date, transaction_currency, transaction_amount,
       historical_rate, base_amount, source_cash_type, source_cash_id, destination_cash_type, destination_cash_id,
       source_receivable_account_id, destination_supplier_id, source_receipt_voucher_id,
       destination_payment_voucher_id, status, created_by,
       reversed_by, reversed_at, reversal_date, reversal_reason, reversal_key, reversal_fingerprint,
       source_reversal_voucher_id, destination_reversal_voucher_id)
    VALUES (${id}, ${pair.relationship}, ${pair.source}, ${pair.destination}, ${"pay-" + id}, ${"a".repeat(64)},
            ${"TRF-" + id}, 'Bank confirmation slip', ${paymentDate}::date, 'USD', ${amount}, 1, ${amount},
            'bank', 1, 'bank', 2, 3, 4, ${id}, ${id + 1}, ${status}, ${ACTOR}, ${reversed})
  `);
  return id;
}

async function allocate(tx: DbTransaction, paymentId: number, tradeId: number, amount: string, kind: string) {
  // The id comes from the sequence, so seeded rows sort before the ones the service writes.
  const key = `seed-${(nextId += 1)}`;
  await tx.execute(sql`
    INSERT INTO intercompany_payment_allocations (payment_id, trade_id, amount, allocation_kind, request_key, reason)
    VALUES (${paymentId}, ${tradeId}, ${amount}, ${kind}, ${key}, 'seeded')
  `);
}

async function allocationRows(tx: DbTransaction, tradeId: number) {
  return all(
    tx,
    sql`SELECT payment_id::int AS "paymentId", amount::text AS amount, allocation_kind AS kind, request_key AS key
          FROM intercompany_payment_allocations WHERE trade_id = ${tradeId} ORDER BY id`
  );
}

async function seedActor(tx: DbTransaction) {
  await tx.execute(sql`INSERT INTO users (id, username, password) VALUES (${ACTOR}, ${ACTOR}, 'x')`);
}

describe("autoAllocateNewTradeCreditTx", () => {
  it("applies the pair's confirmed credit oldest first, only up to the amount due", async () => {
    await inRolledBackTransaction(async (tx) => {
      let tradeId = 0;
      let older = 0;
      let newer = 0;
      let newest = 0;
      await withoutTriggers(tx, async () => {
        await seedActor(tx);
        tradeId = await trade(tx, PAIR);
        newer = await payment(tx, PAIR, "300.00", "2026-10-05");
        older = await payment(tx, PAIR, "100.00", "2026-10-01");
        newest = await payment(tx, PAIR, "500.00", "2026-10-09");
        await payment(tx, PAIR, "999.00", "2026-09-01", "reversed");
        await payment(tx, OTHER_PAIR, "999.00", "2026-09-01");
      });

      const result = await autoAllocateNewTradeCreditTx(tx, {
        tradeId,
        relationshipId: PAIR.relationship,
        confirmedLandedCost: "350.00",
      });
      expect(result).toEqual({ applied: "350.00", remainingDue: "0.00" });
      expect(await allocationRows(tx, tradeId)).toEqual([
        { paymentId: older, amount: "100.00", kind: "new_import_credit", key: `ic-import-credit:${tradeId}:${older}` },
        { paymentId: newer, amount: "250.00", kind: "new_import_credit", key: `ic-import-credit:${tradeId}:${newer}` },
      ]);
      expect((await paymentAvailableTx(tx, newer)).toFixed(2)).toBe("50.00");
      expect((await paymentAvailableTx(tx, newest)).toFixed(2)).toBe("500.00");
      expect((await tradeAppliedTx(tx, tradeId)).toFixed(2)).toBe("350.00");
    });
  });

  it("leaves the rest due when the pair's credit runs out, counting what is already applied", async () => {
    await inRolledBackTransaction(async (tx) => {
      let tradeId = 0;
      let first = 0;
      let second = 0;
      await withoutTriggers(tx, async () => {
        tradeId = await trade(tx, PAIR);
        first = await payment(tx, PAIR, "100.00", "2026-10-01");
        second = await payment(tx, PAIR, "40.00", "2026-10-02");
        await allocate(tx, first, tradeId, "60.00", "manual");
      });

      const result = await autoAllocateNewTradeCreditTx(tx, {
        tradeId,
        relationshipId: PAIR.relationship,
        confirmedLandedCost: "200.00",
      });
      // 200 due, 60 already applied: 140 to find; 40 left on the first payment and 40 on the second.
      expect(result).toEqual({ applied: "80.00", remainingDue: "60.00" });
      expect(await pairCreditsTx(tx, PAIR.relationship)).toEqual([]);
      expect((await allocationRows(tx, tradeId)).map((row) => [row.paymentId, row.amount])).toEqual([
        [first, "60.00"],
        [first, "40.00"],
        [second, "40.00"],
      ]);
    });
  });

  it("refuses a trade that is not active, belongs to another pair, or is already over-allocated", async () => {
    await inRolledBackTransaction(async (tx) => {
      let pending = 0;
      let active = 0;
      await withoutTriggers(tx, async () => {
        pending = await trade(tx, PAIR, "pending");
        active = await trade(tx, PAIR);
        const credit = await payment(tx, PAIR, "100.00", "2026-10-01");
        await allocate(tx, credit, active, "90.00", "manual");
      });

      for (const input of [
        { tradeId: pending, relationshipId: PAIR.relationship, confirmedLandedCost: "10.00" },
        { tradeId: active, relationshipId: OTHER_PAIR.relationship, confirmedLandedCost: "10.00" },
        { tradeId: -1, relationshipId: PAIR.relationship, confirmedLandedCost: "10.00" },
      ]) {
        await expect(autoAllocateNewTradeCreditTx(tx, input)).rejects.toThrow(/verified new active trade/);
      }
      await expect(
        autoAllocateNewTradeCreditTx(tx, {
          tradeId: active,
          relationshipId: PAIR.relationship,
          confirmedLandedCost: "50.00",
        })
      ).rejects.toThrow(/exceeds its confirmed cost/);
    });
  });
});

describe("releaseEditOverallocationTx", () => {
  it("does nothing when the PO still costs at least what was applied", async () => {
    await inRolledBackTransaction(async (tx) => {
      let tradeId = 0;
      await withoutTriggers(tx, async () => {
        tradeId = await trade(tx, PAIR);
        const credit = await payment(tx, PAIR, "100.00", "2026-10-01");
        await allocate(tx, credit, tradeId, "80.00", "manual");
      });
      expect(
        await releaseEditOverallocationTx(tx, { tradeId, newLandedCost: "80.00", actorUserId: ACTOR, revisionId: 1 })
      ).toEqual({ released: "0.00", details: [] });
      expect(await allocationRows(tx, tradeId)).toHaveLength(1);
    });
  });

  it("returns automatic credit before manual allocations when a PO's cost falls", async () => {
    await inRolledBackTransaction(async (tx) => {
      let tradeId = 0;
      let manualPayment = 0;
      let autoPayment = 0;
      await withoutTriggers(tx, async () => {
        await seedActor(tx);
        tradeId = await trade(tx, PAIR);
        manualPayment = await payment(tx, PAIR, "100.00", "2026-10-01");
        autoPayment = await payment(tx, PAIR, "100.00", "2026-10-02");
        await allocate(tx, manualPayment, tradeId, "70.00", "manual");
        await allocate(tx, autoPayment, tradeId, "50.00", "new_import_credit");
      });

      const result = await releaseEditOverallocationTx(tx, {
        tradeId,
        newLandedCost: "60.00",
        actorUserId: ACTOR,
        revisionId: 42,
      });
      expect(result).toEqual({
        released: "60.00",
        details: [
          { paymentId: autoPayment, amount: "50.00" },
          { paymentId: manualPayment, amount: "10.00" },
        ],
      });
      const releases = (await allocationRows(tx, tradeId)).filter((row) => row.kind === "edit_release");
      expect(releases.map((row) => [row.paymentId, row.amount])).toEqual([
        [autoPayment, "-50.00"],
        [manualPayment, "-10.00"],
      ]);
      expect(releases.every((row) => String(row.key).startsWith("ic-edit-release:42:"))).toBe(true);
      expect((await tradeAppliedTx(tx, tradeId)).toFixed(2)).toBe("60.00");
      expect((await paymentAvailableTx(tx, autoPayment)).toFixed(2)).toBe("100.00");
    });
  });
});

describe("releasePaymentAllocationsTx", () => {
  it("releases exactly what a payment applied to each trade, skipping trades already back to zero", async () => {
    await inRolledBackTransaction(async (tx) => {
      let paymentId = 0;
      let first = 0;
      let second = 0;
      let settled = 0;
      await withoutTriggers(tx, async () => {
        await seedActor(tx);
        first = await trade(tx, PAIR);
        second = await trade(tx, PAIR);
        settled = await trade(tx, PAIR);
        paymentId = await payment(tx, PAIR, "500.00", "2026-10-01");
        await allocate(tx, paymentId, first, "120.00", "manual");
        await allocate(tx, paymentId, first, "30.00", "new_import_credit");
        await allocate(tx, paymentId, second, "75.50", "manual");
        await allocate(tx, paymentId, settled, "20.00", "manual");
        await allocate(tx, paymentId, settled, "-20.00", "edit_release");
      });

      const released = await releasePaymentAllocationsTx(tx, { paymentId, actorUserId: ACTOR });
      expect(released).toEqual([
        { tradeId: first, amount: "150.00" },
        { tradeId: second, amount: "75.50" },
      ]);
      expect((await paymentAvailableTx(tx, paymentId)).toFixed(2)).toBe("500.00");
      const rows = await allocationRows(tx, first);
      expect(rows.at(-1)).toEqual({
        paymentId,
        amount: "-150.00",
        kind: "reversal_release",
        key: `ic-payment-reversal:${paymentId}:${first}`,
      });
    });
  });

  it("reports an unknown payment and a trade whose allocations went negative", async () => {
    await inRolledBackTransaction(async (tx) => {
      let tradeId = 0;
      await withoutTriggers(tx, async () => {
        tradeId = await trade(tx, PAIR);
        const credit = await payment(tx, PAIR, "100.00", "2026-10-01");
        await allocate(tx, credit, tradeId, "-5.00", "edit_release");
      });
      await expect(paymentAvailableTx(tx, -1)).rejects.toThrow(/not found/);
      await expect(tradeAppliedTx(tx, tradeId)).rejects.toThrow(/unreconciled/);
    });
  });
});
