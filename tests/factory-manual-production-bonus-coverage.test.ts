/**
 * Manual Production Bonus payouts (manualProductionBonusPaymentService)
 * against PostgreSQL in a rolled-back transaction: command validation, one
 * balanced voucher per worker, idempotent request keys, refusal of duplicate
 * or conflicting payouts, and reversal.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  parseManualBonusCommand,
  postManualProductionBonuses,
  reverseManualProductionBonus,
} from "../server/services/factory/manualProductionBonusPaymentService";
import { isClosedPeriodError } from "../server/lib/closedPeriodError";
import { withRolledBackPool } from "./helpers/routedPoolClient";
import { closeBooksOn, createBonusWorld, type BonusWorld } from "./helpers/productionBonusFixture";

const WEEK = "2026-03-02";
const ROSTER = "2026-03-03";

function withBonus(work: (b: BonusWorld) => Promise<void>) {
  return withRolledBackPool(async (client) => work(await createBonusWorld(client)));
}

const raw = (b: BonusWorld | null, selections: unknown[], overrides: Record<string, unknown> = {}) => ({
  confirm: true,
  currency: "USD",
  weekStart: WEEK,
  rosterDate: ROSTER,
  paymentDate: "2026-03-09",
  cashAccountId: b?.cashId ?? 1,
  requestKey: randomUUID(),
  selections,
  ...overrides,
});

/** Workers saved on the closed roster day, so they are on the Production Targets roster. */
async function rostered(b: BonusWorld, ...names: string[]) {
  const ids: number[] = [];
  for (const name of names) {
    const id = await b.worker(name);
    await b.day(ROSTER, id, 5, 5);
    ids.push(id);
  }
  return ids;
}

const manualVouchers = (b: BonusWorld) =>
  b.q(`SELECT voucher_type FROM vouchers WHERE company_id = $1 AND description LIKE '%anual%' ORDER BY id`, [
    b.companyId,
  ]);

describe("manual bonus command validation", () => {
  it("accepts a confirmed USD request and normalises it", () => {
    const key = randomUUID().toUpperCase();
    const parsed = parseManualBonusCommand(
      raw(
        null,
        [
          { workerId: 9, amount: "5.5" },
          { workerId: 3, amount: 2 },
        ],
        { requestKey: key }
      )
    );
    expect(parsed.requestKey).toBe(key.toLowerCase());
    expect(parsed.selections).toEqual([
      { workerId: 3, amount: "2.00" },
      { workerId: 9, amount: "5.50" },
    ]);
  });

  it.each([
    [null, /Payment details/],
    [{ ...raw(null, [{ workerId: 1, amount: "1" }]), confirm: false }, /Confirm/],
    [{ ...raw(null, [{ workerId: 1, amount: "1" }]), currency: "EUR" }, /Only USD/],
    [{ ...raw(null, [{ workerId: 1, amount: "1" }]), weekStart: "2026-03-03" }, /starting on Monday/],
    [{ ...raw(null, [{ workerId: 1, amount: "1" }]), rosterDate: "2026-03-09" }, /roster date/],
    [{ ...raw(null, [{ workerId: 1, amount: "1" }]), paymentDate: "2026-03-01" }, /cannot precede/],
    [{ ...raw(null, [{ workerId: 1, amount: "1" }]), cashAccountId: -1 }, /Cash or Bank/],
    [{ ...raw(null, [{ workerId: 1, amount: "1" }]), requestKey: "nope" }, /request identity/],
    [raw(null, []), /between 1 and 100/],
    [raw(null, [{ workerId: 1, amount: "0" }]), /positive USD amount/],
    [raw(null, [null]), /positive USD amount/],
    [raw(null, [{ workerId: 1, amount: "1000001" }]), /positive USD amount/],
    [
      raw(null, [
        { workerId: 1, amount: "1" },
        { workerId: 1, amount: "2" },
      ]),
      /selected twice/,
    ],
  ])("refuses %#", (input, message) => {
    expect(() => parseManualBonusCommand(input)).toThrow(message);
  });
});

describe("manual bonus payment", () => {
  it("posts one balanced voucher per worker and replays the same request key", async () => {
    await withBonus(async (b) => {
      const [a, c] = await rostered(b, "Ann", "Cy");
      const command = parseManualBonusCommand(
        raw(b, [
          { workerId: c, amount: "12.25" },
          { workerId: a, amount: "7" },
        ])
      );
      const result = await postManualProductionBonuses(b.companyId, command, b.actor);
      expect(result).toMatchObject({ posted: 2, replayed: 0 });
      expect(result.results.map((r) => [r.workerId, r.amount])).toEqual([
        [a, "7.00"],
        [c, "12.25"],
      ]);
      const totals = await b.q(
        `SELECT SUM(debit_amount)::text AS dr, SUM(credit_amount)::text AS cr FROM voucher_entries WHERE voucher_id = ANY($1)`,
        [result.results.map((r) => r.voucherId)]
      );
      expect(totals[0]).toEqual({ dr: "19.25", cr: "19.25" });
      const daybook = await b.q(
        `SELECT COUNT(*)::int AS n FROM factory_daybook_entries WHERE company_id = $1 AND tx_type = 'PRODUCTION_TARGET_MANUAL_BONUS_PAYMENT'`,
        [b.companyId]
      );
      expect(daybook[0].n).toBe(2);

      const replay = await postManualProductionBonuses(b.companyId, command, b.actor);
      expect(replay).toMatchObject({ posted: 0, replayed: 2 });
      expect(await manualVouchers(b)).toHaveLength(2);
      const changed = { ...command, selections: [{ workerId: a, amount: "8.00" }, command.selections[1]] };
      await expect(postManualProductionBonuses(b.companyId, changed, b.actor)).rejects.toThrow(/different details/);
      const shorter = { ...command, selections: [command.selections[0]] };
      await expect(postManualProductionBonuses(b.companyId, shorter, b.actor)).rejects.toThrow(/different details/);

      const second = parseManualBonusCommand(raw(b, [{ workerId: a, amount: "1" }]));
      await expect(postManualProductionBonuses(b.companyId, second, b.actor)).rejects.toThrow(
        /already has a manual bonus payment/
      );
    });
  });

  it("refuses unsigned actors, off-roster or foreign workers and calculated payouts for the week", async () => {
    await withBonus(async (b) => {
      const [onRoster] = await rostered(b, "On Roster");
      const offRoster = await b.worker("Off Roster");
      const cmd = (workerId: number) => parseManualBonusCommand(raw(b, [{ workerId, amount: "5" }]));
      await expect(
        postManualProductionBonuses(b.companyId, cmd(onRoster), { userId: "", username: "" })
      ).rejects.toMatchObject({
        statusCode: 401,
      });
      await expect(postManualProductionBonuses(b.companyId, cmd(offRoster), b.actor)).rejects.toThrow(
        /not on the Production Targets roster/
      );

      const reviewId = await b.review(ROSTER, onRoster, { amount: "3.00" });
      await b.dailyPayment(reviewId, ROSTER, onRoster, "3.00");
      await expect(postManualProductionBonuses(b.companyId, cmd(onRoster), b.actor)).rejects.toThrow(
        /posted calculated bonus/
      );
      const expense = await b.ledger("NOTCASH", "Expense");
      const wrongAccount = { ...cmd(onRoster), cashAccountId: expense };
      await expect(postManualProductionBonuses(b.companyId, wrongAccount, b.actor)).rejects.toMatchObject({
        statusCode: 400,
      });
      const foreignCurrency = await b.ledger("EURCASH", "Cash", "EUR");
      await expect(
        postManualProductionBonuses(b.companyId, { ...cmd(onRoster), cashAccountId: foreignCurrency }, b.actor)
      ).rejects.toThrow(/non-USD/);
      expect(await manualVouchers(b)).toHaveLength(0);
    });
  });

  it("refuses a payout dated in a closed accounting period", async () => {
    await withBonus(async (b) => {
      const [worker] = await rostered(b, "Closed");
      await closeBooksOn(b, "2026-12-31");
      const command = parseManualBonusCommand(raw(b, [{ workerId: worker, amount: "5" }]));
      await expect(postManualProductionBonuses(b.companyId, command, b.actor)).rejects.toSatisfy(isClosedPeriodError);
    });
  });
});

describe("manual bonus reversal", () => {
  it("reverses once with a mirror receipt and replays afterwards", async () => {
    await withBonus(async (b) => {
      const [worker] = await rostered(b, "Reversed");
      const paid = await postManualProductionBonuses(
        b.companyId,
        parseManualBonusCommand(raw(b, [{ workerId: worker, amount: "9" }])),
        b.actor
      );
      const paymentId = paid.results[0].paymentId;
      await expect(
        reverseManualProductionBonus(b.companyId, paymentId, "2026-03-08", "early", b.actor)
      ).rejects.toThrow(/before its posting date/);
      const reversed = await reverseManualProductionBonus(
        b.companyId,
        paymentId,
        "2026-03-10",
        " Wrong worker ",
        b.actor
      );
      expect(reversed).toMatchObject({ paymentId, replayed: false });
      const [row] = await b.q(
        `SELECT status, reversal_reason FROM factory_target_bonus_manual_payments WHERE id = $1`,
        [paymentId]
      );
      expect(row).toEqual({ status: "REVERSED", reversal_reason: "Wrong worker" });
      expect((await manualVouchers(b)).map((v) => v.voucher_type)).toEqual(["Payment", "Receipt"]);
      const again = await reverseManualProductionBonus(b.companyId, paymentId, "2026-03-10", "again", b.actor);
      expect(again).toEqual({ paymentId, replayed: true, voucherId: reversed.voucherId });
    });
  });

  it("validates its input and refuses unknown payments", async () => {
    await withBonus(async (b) => {
      await expect(reverseManualProductionBonus(b.companyId, 0, "2026-03-10", "r", b.actor)).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(reverseManualProductionBonus(b.companyId, 1, "bad", "r", b.actor)).rejects.toThrow(
        /date and reason/
      );
      await expect(reverseManualProductionBonus(b.companyId, 1, "2026-03-10", "  ", b.actor)).rejects.toThrow(
        /date and reason/
      );
      await expect(
        reverseManualProductionBonus(b.companyId, 999999999, "2026-03-10", "r", b.actor)
      ).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });
});
