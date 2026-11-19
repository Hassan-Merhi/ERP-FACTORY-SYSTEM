/**
 * Paired intercompany payment guards: input validation, the cash/bank account
 * company checks, pair access (wrong company, missing finance membership,
 * disabled pair), pair activation checks and chosen-PO allocation checks.
 */
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import { withRolledBackPool } from "./helpers/routedPoolClient";
import { createIntercompanyTradeWorld, type IntercompanyTradeWorld } from "./helpers/intercompanyTradeFixture";
import {
  accessiblePaymentPair,
  accountTarget,
  activePaymentPairTx,
  checkAccount,
  checkChosenPos,
  validatePayment,
  type CashRef,
  type MirroredPaymentInput,
} from "../server/services/intercompany/accessiblePaymentPair";

const base: MirroredPaymentInput = {
  relationshipId: 1,
  requestKey: "payment-key-0001",
  paymentDate: "2026-06-15",
  currency: "USD",
  transactionAmount: "100.00",
  historicalRate: "1",
  sourceReceiptAccount: { type: "bank", id: 1 },
  destinationPaymentAccount: { type: "cash", id: 2 },
  transferReference: "TRF-12345",
  confirmationEvidence: "Bank statement line 42",
  reason: "Container settlement",
  confirmedSourceReceipt: true,
  confirmedDestinationPayment: true,
  allocations: [{ tradeId: 1, expectedVersion: 1, amount: "60.00" }],
};

const code = (patch: Partial<MirroredPaymentInput>) => {
  try {
    validatePayment({ ...base, ...patch });
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
  return "ok";
};

describe("validatePayment", () => {
  it("accepts a confirmed, evidenced, cent-exact payment", () => {
    const result = validatePayment(base);
    expect(result.base.toFixed(2)).toBe("100.00");
    expect(result.currency).toBe("USD");
    expect(
      validatePayment({ ...base, currency: "ZMW", historicalRate: "25", transactionAmount: "2500" }).base.toFixed(2)
    ).toBe("100.00");
  });

  it("refuses missing confirmations, weak evidence and malformed requests", () => {
    expect(code({ paymentDate: "15/06/2026" })).toBe("IC_EDIT_DATE");
    expect(code({ requestKey: "x" })).toBe("IC_EDIT_KEY");
    for (const patch of [
      { relationshipId: 0 },
      { confirmedSourceReceipt: false },
      { confirmedDestinationPayment: false },
      { transferReference: "abc" },
      { transferReference: "x".repeat(181) },
      { confirmationEvidence: "short" },
      { confirmationEvidence: "x".repeat(2001) },
      { reason: " " },
      { reason: "ab" },
      { reason: "x".repeat(1001) },
      { allocations: "none" as never },
      { allocations: Array.from({ length: 201 }, (_, i) => ({ tradeId: i + 1, expectedVersion: 1, amount: "0.01" })) },
    ]) {
      expect(code(patch)).toBe("IC_PAYMENT_EVIDENCE");
    }
  });

  it("refuses unsupported or non-canonical currencies and invalid money", () => {
    expect(code({ currency: "ABC" as never })).toBe("IC_PAYMENT_CURRENCY");
    expect(code({ currency: "EUR" as never })).toBe("IC_PAYMENT_MONEY");
    expect(code({ currency: "usd" as never })).toBe("IC_PAYMENT_CURRENCY");
    expect(code({ transactionAmount: "1.234" })).toBe("IC_PAYMENT_MONEY");
    expect(code({ historicalRate: "2" })).toBe("IC_PAYMENT_MONEY");
  });

  it("refuses duplicate, unversioned or oversized PO allocations", () => {
    const line = { tradeId: 1, expectedVersion: 1, amount: "10.00" };
    expect(code({ allocations: [line, line] })).toBe("IC_PAYMENT_DUPLICATE_PO");
    for (const bad of [
      { ...line, tradeId: 0 },
      { ...line, expectedVersion: 0 },
      { ...line, amount: 10 as never },
      { ...line, amount: "1.001" },
      { ...line, amount: "0.00" },
    ]) {
      expect(code({ allocations: [bad] })).toBe("IC_PAYMENT_ALLOCATION");
    }
    expect(code({ allocations: [{ ...line, amount: "100.01" }] })).toMatch(/exceeds/);
  });

  it("maps bank and cash references to voucher targets", () => {
    expect(accountTarget({ type: "bank", id: 4 })).toEqual({ bankAccountId: 4 });
    expect(accountTarget({ type: "cash", id: 5 })).toEqual({ ledgerAccountId: 5 });
  });
});

async function world<T>(work: (w: IntercompanyTradeWorld) => Promise<T>) {
  return withRolledBackPool(async (client) => work(await createIntercompanyTradeWorld(client)));
}

const inTx = <T>(work: Parameters<typeof db.transaction<T>>[0]) => db.transaction(work);

describe("checkAccount", () => {
  it("accepts active accounts of the right company and refuses everything else", () =>
    world(async (w) => {
      const bank = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, active)
         VALUES ($1, $2, 'Main', 'Bank', '001', TRUE) RETURNING id`,
        [w.sourceCompanyId, `${w.tag}BK`]
      );
      const cash = await w.ledger(w.destinationCompanyId, "CASH", "Cash");
      const notCash = w.accounts.destinationGitAccountId;
      const verdict = (companyId: number, ref: CashRef) =>
        inTx((tx) => checkAccount(tx, companyId, ref)).then(
          () => "ok",
          (error) => error.code
        );
      expect(await verdict(w.sourceCompanyId, { type: "bank", id: bank })).toBe("ok");
      expect(await verdict(w.destinationCompanyId, { type: "cash", id: cash })).toBe("ok");
      expect(await verdict(w.destinationCompanyId, { type: "bank", id: bank })).toBe("IC_PAYMENT_ACCOUNT");
      expect(await verdict(w.sourceCompanyId, { type: "cash", id: cash })).toBe("IC_PAYMENT_ACCOUNT");
      expect(await verdict(w.destinationCompanyId, { type: "cash", id: notCash })).toBe("IC_PAYMENT_ACCOUNT");
      expect(await verdict(w.sourceCompanyId, { type: "wire" as never, id: bank })).toBe("IC_PAYMENT_ACCOUNT");
      expect(await verdict(w.sourceCompanyId, { type: "bank", id: 0 })).toBe("IC_PAYMENT_ACCOUNT");
      expect(await verdict(w.sourceCompanyId, null as never)).toBe("IC_PAYMENT_ACCOUNT");
    }));
});

describe("accessiblePaymentPair", () => {
  it("returns the pair to an Owner of both companies from either side", () =>
    world(async (w) => {
      expect((await accessiblePaymentPair(w.relationshipId, w.identity())).id).toBe(w.relationshipId);
      expect((await accessiblePaymentPair(w.relationshipId, w.identity(w.destinationCompanyId, "Owner"))).id).toBe(
        w.relationshipId
      );
    }));

  it("refuses invalid IDs, unknown pairs and companies outside the pair", () =>
    world(async (w) => {
      await expect(accessiblePaymentPair(0, w.identity())).rejects.toMatchObject({
        code: "IC_PAYMENT_PAIR",
        status: 422,
      });
      await expect(accessiblePaymentPair(2147483000, w.identity())).rejects.toMatchObject({
        code: "IC_PAYMENT_PAIR",
        status: 403,
      });
      const other = await w.company("Q", "erp");
      const outsider = await w.otherUser([[other, "Owner"]]);
      await expect(accessiblePaymentPair(w.relationshipId, w.identity(other, "Owner", outsider))).rejects.toMatchObject(
        {
          code: "IC_PAYMENT_PAIR",
        }
      );
    }));

  it("needs finance membership in both companies", () =>
    world(async (w) => {
      const sourceOnly = await w.otherUser([[w.sourceCompanyId, "Owner"]]);
      await expect(
        accessiblePaymentPair(w.relationshipId, w.identity(w.sourceCompanyId, "Owner", sourceOnly))
      ).rejects.toMatchObject({ code: "IC_PAYMENT_PAIR_MEMBERSHIP", status: 403 });
      const adminBoth = await w.otherUser([
        [w.sourceCompanyId, "Admin"],
        [w.destinationCompanyId, "Admin"],
      ]);
      await expect(
        accessiblePaymentPair(w.relationshipId, w.identity(w.destinationCompanyId, "Admin", adminBoth))
      ).rejects.toMatchObject({ code: "IC_PAYMENT_PAIR_MEMBERSHIP" });
    }));

  it("refuses a disabled pair unless the caller only needs history", () =>
    world(async (w) => {
      await w.q(`UPDATE intercompany_relationship_policies SET trade_enabled = FALSE WHERE id = $1`, [
        w.relationshipId,
      ]);
      await expect(accessiblePaymentPair(w.relationshipId, w.identity())).rejects.toMatchObject({
        code: "IC_PAYMENT_PAIR",
      });
      expect((await accessiblePaymentPair(w.relationshipId, w.identity(), false)).tradeEnabled).toBe(false);
    }));
});

describe("activePaymentPairTx", () => {
  it("locks a fully mapped USD Properties -> ERP pair", () =>
    world(async (w) => {
      expect((await inTx((tx) => activePaymentPairTx(tx, w.relationshipId))).id).toBe(w.relationshipId);
    }));

  it("refuses a disabled pair, a non-USD company and a renamed partner supplier", () =>
    world(async (w) => {
      const verdict = () =>
        inTx((tx) => activePaymentPairTx(tx, w.relationshipId)).then(
          () => "ok",
          (error) => error.message
        );
      await w.q(`UPDATE companies SET base_currency = 'ZMW' WHERE id = $1`, [w.destinationCompanyId]);
      expect(await verdict()).toMatch(/USD-base/);
      await w.q(`UPDATE companies SET base_currency = 'USD', active = FALSE WHERE id = $1`, [w.destinationCompanyId]);
      expect(await verdict()).toMatch(/USD-base/);
      await w.q(`UPDATE companies SET active = TRUE WHERE id = $1`, [w.destinationCompanyId]);
      await w.q(`UPDATE suppliers SET legal_name = 'Someone Else' WHERE id = $1`, [w.partnerSupplierId]);
      expect(await verdict()).toMatch(/original Properties company/);
      await w.q(`UPDATE intercompany_relationship_policies SET trade_enabled = FALSE WHERE id = $1`, [
        w.relationshipId,
      ]);
      expect(await verdict()).toMatch(/disabled/);
      expect(
        await inTx((tx) => activePaymentPairTx(tx, 2147483000)).then(
          () => "ok",
          (error) => error.message
        )
      ).toMatch(/disabled/);
    }));
});

describe("checkChosenPos", () => {
  it("accepts allocations within each PO's unpaid landed cost and refuses the rest", () =>
    world(async (w) => {
      const a = await w.trade("A");
      const b = await w.trade("B");
      const pair = await inTx((tx) => activePaymentPairTx(tx, w.relationshipId));
      const verdict = (choices: { tradeId: number; expectedVersion: number; amount: string }[], total: string) =>
        inTx((tx) => checkChosenPos(tx, pair, choices, total)).then(
          () => "ok",
          (error) => error.code ?? error.message
        );
      expect(await verdict([{ tradeId: a.tradeId, expectedVersion: 1, amount: "60.00" }], "60.00")).toBe("ok");
      expect(await verdict([{ tradeId: a.tradeId, expectedVersion: 1, amount: "100.01" }], "200.00")).toMatch(
        /exceeds/
      );
      expect(await verdict([{ tradeId: a.tradeId, expectedVersion: 2, amount: "10.00" }], "10.00")).toBe(
        "IC_PAYMENT_PO_STALE"
      );
      expect(await verdict([{ tradeId: 2147483000, expectedVersion: 1, amount: "10.00" }], "10.00")).toBe(
        "IC_PAYMENT_WRONG_PAIR"
      );
      await w.q(`DELETE FROM intercompany_import_batch_containers WHERE trade_id = $1`, [b.tradeId]);
      expect(await verdict([{ tradeId: b.tradeId, expectedVersion: 1, amount: "10.00" }], "10.00")).toBe(
        "IC_EDIT_UNSAFE"
      );
    }));
});
