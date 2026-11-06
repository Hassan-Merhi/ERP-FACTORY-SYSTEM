/**
 * Open-item matching for customers, suppliers and factory suppliers. Each case
 * seeds a disposable company inside a drizzle transaction that is rolled back,
 * then drives the service the routes call: listing a party's charges and
 * settlements, applying a match and voiding it.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, type DbTransaction } from "../server/db";
import { resultRows } from "../server/lib/queryResult";

const held = vi.hoisted(() => ({ voucherIds: new Set<number>(), calls: [] as unknown[][] }));

vi.mock("../server/routes/factory/customers-core/heldUnfinalizedCustomerCharges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/routes/factory/customers-core/heldUnfinalizedCustomerCharges")>()),
  loadHeldChargeSnapshot: async (...args: unknown[]) => {
    held.calls.push(args);
    return { byCustomer: new Map(), voucherIds: held.voucherIds };
  },
}));

import {
  OpenItemError,
  applyPartyOpenItemMatchTx,
  loadPartyOpenItemsTx,
  validateOpenItemTarget,
  voidPartyOpenItemMatchTx,
} from "../server/services/accounting/partyOpenItemService";

const ROLLBACK = new Error("rollback");
const actor = { userId: "7", username: "matcher" };
let seq = 0;

async function inRolledBackTx(run: (tx: DbTransaction) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await run(tx);
      throw ROLLBACK;
    })
    .catch((error) => {
      if (error !== ROLLBACK) throw error;
    });
}

async function insert(tx: DbTransaction, query: ReturnType<typeof sql>): Promise<number> {
  return Number(resultRows<{ id: number } & Record<string, unknown>>(await tx.execute(query))[0].id);
}

type Line = {
  type?: string;
  date: string;
  debit?: number;
  credit?: number;
  currency?: string;
  optional?: boolean;
  deleted?: boolean;
  target?: "customer" | "supplier" | "factory_supplier";
  /** Seeds a pre-trigger legacy row: zero or two-sided amounts, or a foreign line without native amounts. */
  legacy?: boolean;
};

type World = {
  companyId: number;
  customerId: number;
  supplierId: number;
  factorySupplierId: number;
  /** Books one voucher with a single party line; returns { voucherId, entryId }. */
  line(input: Line): Promise<{ voucherId: number; entryId: number }>;
  match(
    chargeEntryId: number,
    settlementEntryId: number,
    amount: number,
    extra?: Record<string, unknown>
  ): Promise<number>;
};

async function world(tx: DbTransaction, customer: { terms?: number | null; opening?: number } = {}): Promise<World> {
  const code = `OI${process.pid}${++seq}`;
  const companyId = await insert(tx, sql`INSERT INTO companies(code,name) VALUES(${code},${code}) RETURNING id`);
  const customerId = await insert(
    tx,
    sql`INSERT INTO customers(company_id,code,legal_name,payment_terms_days,opening_balance,opening_balance_side)
        VALUES(${companyId},${`${code}-C`},'Client',${customer.terms ?? null},${customer.opening ?? 0},'Dr') RETURNING id`
  );
  const supplierId = await insert(
    tx,
    sql`INSERT INTO suppliers(company_id,code,legal_name,email) VALUES(${companyId},${`${code}-S`},'Vendor','v@x.test') RETURNING id`
  );
  const factorySupplierId = await insert(
    tx,
    sql`INSERT INTO factory_suppliers(company_id,name) VALUES(${companyId},${`${code}-F`}) RETURNING id`
  );
  const targets = { customer: customerId, supplier: supplierId, factory_supplier: factorySupplierId };
  return {
    companyId,
    customerId,
    supplierId,
    factorySupplierId,
    async line(input) {
      const currency = input.currency ?? "USD";
      const voucherId = await insert(
        tx,
        sql`INSERT INTO vouchers(company_id,voucher_number,voucher_type,voucher_date,total_amount,currency,optional,deleted_at)
            VALUES(${companyId},${`V-${++seq}`},${input.type ?? "Journal"},${input.date}::date,0,${currency},
              ${input.optional ?? false},${input.deleted ? sql`NOW()` : null}) RETURNING id`
      );
      const debit = input.debit ?? 0;
      const credit = input.credit ?? 0;
      const target = input.target ?? "customer";
      const column = { customer: "customer_id", supplier: "supplier_id", factory_supplier: "factory_supplier_id" }[
        target
      ];
      const foreign = currency !== "USD" && !input.legacy;
      if (input.legacy) await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      const entryId = await insert(
        tx,
        sql`INSERT INTO voucher_entries(voucher_id,company_id,${sql.raw(column)},debit_amount,credit_amount,
              base_debit_amount,base_credit_amount,transaction_currency,transaction_debit_amount,transaction_credit_amount,
              historical_exchange_rate,rate_convention)
            VALUES(${voucherId},${companyId},${targets[target]},${debit},${credit},${debit},${credit},
              ${foreign ? currency : null},${foreign ? debit : null},${foreign ? credit : null},
              ${foreign ? 1 : null},${foreign ? "BASE_PER_TRANSACTION" : null}) RETURNING id`
      );
      if (input.legacy) await tx.execute(sql`SET LOCAL session_replication_role = origin`);
      return { voucherId, entryId };
    },
    async match(chargeEntryId, settlementEntryId, amount, extra = {}) {
      return insert(
        tx,
        sql`INSERT INTO accounting_open_item_matches(company_id,domain,party_id,charge_entry_id,settlement_entry_id,
              amount,currency,applied_on,idempotency_key,created_by,voided_at,voided_by,void_reason)
            VALUES(${companyId},${(extra.domain as string) ?? "customer"},${(extra.partyId as number) ?? customerId},
              ${chargeEntryId},${settlementEntryId},${amount},${(extra.currency as string) ?? "USD"},
              ${(extra.appliedOn as string) ?? "2026-03-15"}::date,${`seed-${++seq}`},'1',
              ${(extra.voidedAt as string) ?? null}::timestamptz,${extra.voidedAt ? "1" : null},${extra.voidedAt ? "seed" : null})
            RETURNING id`
      );
    },
  };
}

async function expectOpenItemError(promise: Promise<unknown>, code: string, status?: number): Promise<OpenItemError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(OpenItemError);
  expect(error).toMatchObject(status ? { code, status } : { code });
  return error as OpenItemError;
}

const customerTarget = (w: World, asOfDate: string | null = null) => ({
  companyId: w.companyId,
  domain: "customer" as const,
  partyId: w.customerId,
  asOfDate,
});

beforeEach(() => {
  held.voucherIds = new Set();
  held.calls = [];
});

describe("validateOpenItemTarget", () => {
  const ok = { companyId: 1, domain: "customer" as const, partyId: 2 };

  it("accepts a valid target and real calendar dates", () => {
    expect(validateOpenItemTarget(ok)).toBe(ok);
    expect(validateOpenItemTarget({ ...ok, asOfDate: "2024-02-29" }).asOfDate).toBe("2024-02-29");
    expect(validateOpenItemTarget({ ...ok, asOfDate: null }).asOfDate).toBeNull();
  });

  it("rejects bad ids, domains and dates as 400s", () => {
    for (const [target, code] of [
      [{ ...ok, companyId: 0 }, "OPEN_ITEM_ID_INVALID"],
      [{ ...ok, partyId: 1.5 }, "OPEN_ITEM_ID_INVALID"],
      [{ ...ok, partyId: Number.MAX_SAFE_INTEGER + 1 }, "OPEN_ITEM_ID_INVALID"],
      [{ ...ok, domain: "rental" }, "OPEN_ITEM_DOMAIN_INVALID"],
      [{ ...ok, asOfDate: "2026-02-30" }, "OPEN_ITEM_DATE_INVALID"],
      [{ ...ok, asOfDate: "2026-2-3" }, "OPEN_ITEM_DATE_INVALID"],
    ] as const) {
      let caught: unknown;
      try {
        validateOpenItemTarget(target as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code, status: 400, name: "OpenItemError" });
    }
    expect(() => validateOpenItemTarget({ ...ok, companyId: -1 })).toThrow("companyId must be a positive integer");
    expect(() => validateOpenItemTarget({ ...ok, partyId: 0 })).toThrow("partyId must be a positive integer");
  });
});

describe("loadPartyOpenItemsTx", () => {
  it("lists customer charges and settlements with matches, due dates and totals", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx, { terms: 30, opening: 75 });
      const invoice = await w.line({ type: "Sales", date: "2026-03-01", debit: 100 });
      const payment = await w.line({ type: "Receipt", date: "2026-03-10", credit: 60 });
      const settled = await w.line({ type: "Invoice", date: "2026-03-02", debit: 20 });
      const journal = await w.line({ type: "Journal", date: "2026-03-03", debit: 5 });
      const unapplied = await w.line({ type: "Receipt", date: "2026-03-04", credit: 15 });
      await w.line({ date: "2026-03-05", legacy: true }); // zero line
      await w.line({ date: "2026-03-05", debit: 9, optional: true });
      await w.line({ date: "2026-03-05", debit: 9, deleted: true });
      await w.line({ date: "2026-03-05", debit: 9, target: "supplier" });
      const match1 = await w.match(invoice.entryId, payment.entryId, 40);
      const match2 = await w.match(settled.entryId, payment.entryId, 20);
      await w.match(journal.entryId, unapplied.entryId, 1, { voidedAt: "2026-03-20" });

      const summary = await loadPartyOpenItemsTx(tx, customerTarget(w, "2026-04-10"));
      expect(summary).toMatchObject({
        companyId: w.companyId,
        domain: "customer",
        partyId: w.customerId,
        asOfDate: "2026-04-10",
        openingBalance: { amount: "75.000000", side: "Dr", includedInMatching: false },
      });
      expect(summary.items.map((item) => [item.voucherType, item.side, item.status])).toEqual([
        ["Sales", "charge", "partial"],
        ["Invoice", "charge", "settled"],
        ["Journal", "charge", "open"],
        ["Receipt", "settlement", "open"],
        ["Receipt", "settlement", "settled"],
      ]);
      const byEntry = new Map(summary.items.map((item) => [item.entryId, item]));
      expect(byEntry.get(invoice.entryId)).toEqual({
        entryId: invoice.entryId,
        voucherId: invoice.voucherId,
        voucherNumber: expect.stringMatching(/^V-/),
        voucherType: "Sales",
        businessDate: "2026-03-01",
        dueDate: "2026-03-31",
        overdueDays: 10,
        side: "charge",
        currency: "USD",
        originalAmount: "100.000000",
        matchedAmount: "40.000000",
        outstandingAmount: "60.000000",
        status: "partial",
        allocations: [{ matchId: match1, otherEntryId: payment.entryId, amount: "40.000000" }],
        currencyVerified: true,
      });
      // Fully settled invoices keep a due date but are never overdue; a
      // non-invoice charge never gets one.
      expect(byEntry.get(settled.entryId)).toMatchObject({ dueDate: "2026-04-01", overdueDays: null });
      expect(byEntry.get(journal.entryId)).toMatchObject({ dueDate: null, overdueDays: null, allocations: [] });
      expect(byEntry.get(payment.entryId)).toMatchObject({
        matchedAmount: "60.000000",
        outstandingAmount: "0.000000",
        dueDate: null,
      });
      // Allocations come back in database order.
      expect(byEntry.get(payment.entryId)?.allocations).toHaveLength(2);
      expect(byEntry.get(payment.entryId)?.allocations).toEqual(
        expect.arrayContaining([
          { matchId: match1, otherEntryId: invoice.entryId, amount: "40.000000" },
          { matchId: match2, otherEntryId: settled.entryId, amount: "20.000000" },
        ])
      );
      expect(summary.currencies).toEqual({
        USD: { charges: "125.000000", settlements: "75.000000", unapplied: "15.000000", outstanding: "65.000000" },
      });
      expect(held.calls).toEqual([[w.companyId, [w.customerId], "2026-04-10"]]);
    });
  });

  it("applies the as-of date to entries and to when matches were applied or voided", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const invoice = await w.line({ type: "Sales", date: "2026-03-01", debit: 100 });
      const payment = await w.line({ date: "2026-03-02", credit: 100 });
      await w.line({ date: "2026-05-01", debit: 7 });
      await w.match(invoice.entryId, payment.entryId, 30, {
        appliedOn: "2026-03-05",
        voidedAt: "2026-04-01T12:00:00Z",
      });
      await w.match(invoice.entryId, payment.entryId, 10, { appliedOn: "2026-03-25" });

      const march = await loadPartyOpenItemsTx(tx, customerTarget(w, "2026-03-20"));
      expect(march.items).toHaveLength(2);
      expect(march.items[0]).toMatchObject({ matchedAmount: "30.000000", outstandingAmount: "70.000000" });

      const april = await loadPartyOpenItemsTx(tx, customerTarget(w, "2026-04-10"));
      expect(april.items[0]).toMatchObject({ matchedAmount: "10.000000", outstandingAmount: "90.000000" });

      const current = await loadPartyOpenItemsTx(tx, customerTarget(w));
      expect(current.asOfDate).toBeNull();
      expect(current.items).toHaveLength(3);
      expect(current.items[0].matchedAmount).toBe("10.000000");
    });
  });

  it("skips held factory charges and FX realization journals", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const heldCharge = await w.line({ type: "Sales", date: "2026-03-01", debit: 40 });
      const invoice = await w.line({ type: "Sales", date: "2026-03-01", debit: 50 });
      const payment = await w.line({ date: "2026-03-02", credit: 50 });
      const fxJournal = await w.line({ date: "2026-03-03", credit: 2 });
      const fxReversal = await w.line({ date: "2026-03-04", debit: 2 });
      await tx.execute(
        sql`UPDATE vouchers SET reversal_of_voucher_id=${fxJournal.voucherId} WHERE id=${fxReversal.voucherId}`
      );
      const matchId = await w.match(invoice.entryId, payment.entryId, 50);
      await tx.execute(sql`INSERT INTO accounting_fx_realizations(company_id,match_id,voucher_id,native_currency,native_amount,
          historical_charge_base,historical_settlement_base,realized_gain_base,recognized_date,actor)
        VALUES(${w.companyId},${matchId},${fxJournal.voucherId},'EUR',50,50,52,2,'2026-03-03','1')`);
      held.voucherIds = new Set([heldCharge.voucherId]);

      const summary = await loadPartyOpenItemsTx(tx, customerTarget(w));
      expect(summary.items.map((item) => item.entryId)).toEqual([invoice.entryId, payment.entryId]);
    });
  });

  it("does not compute due dates from invalid payment terms", async () => {
    for (const terms of [null, -1, 3651]) {
      await inRolledBackTx(async (tx) => {
        const w = await world(tx, { terms });
        await w.line({ type: "Sale", date: "2026-03-01", debit: 10 });
        const [item] = (await loadPartyOpenItemsTx(tx, customerTarget(w, "2026-12-01"))).items;
        expect(item.dueDate).toBeNull();
        expect(item.overdueDays).toBeNull();
      });
    }
    await inRolledBackTx(async (tx) => {
      const w = await world(tx, { terms: 0 });
      await w.line({ type: " sales ", date: "2026-03-01", debit: 10 });
      const [item] = (await loadPartyOpenItemsTx(tx, customerTarget(w, "2026-03-01"))).items;
      expect(item).toMatchObject({ dueDate: "2026-03-01", overdueDays: null });
      const [later] = (await loadPartyOpenItemsTx(tx, customerTarget(w, "2026-03-04"))).items;
      expect(later.overdueDays).toBe(3);
    });
  });

  it("flags over-allocated entries as inconsistent", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const invoice = await w.line({ date: "2026-03-01", debit: 10 });
      const payment = await w.line({ date: "2026-03-01", credit: 30 });
      await w.match(invoice.entryId, payment.entryId, 12);
      const [charge, settlement] = (await loadPartyOpenItemsTx(tx, customerTarget(w))).items;
      expect(charge).toMatchObject({
        status: "inconsistent",
        outstandingAmount: "0.000000",
        matchedAmount: "12.000000",
      });
      expect(settlement).toMatchObject({ status: "partial", outstandingAmount: "18.000000" });
    });
  });

  it("keeps native currencies apart", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await w.line({ date: "2026-03-01", debit: 80, currency: "EUR" });
      await w.line({ date: "2026-03-01", debit: 5 });
      const summary = await loadPartyOpenItemsTx(tx, customerTarget(w));
      expect(summary.items.map((item) => [item.currency, item.currencyVerified])).toEqual([
        ["EUR", true],
        ["USD", true],
      ]);
      expect(Object.keys(summary.currencies).sort()).toEqual(["EUR", "USD"]);
      expect(summary.currencies.EUR.outstanding).toBe("80.000000");
    });
  });

  it("shows legacy foreign lines in base USD but marks them unverified", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const legacy = await w.line({ type: "Sales", date: "2026-03-01", debit: 40, currency: "EUR", legacy: true });
      const payment = await w.line({ date: "2026-03-02", credit: 40 });
      const [item] = (await loadPartyOpenItemsTx(tx, customerTarget(w))).items;
      expect(item).toMatchObject({
        entryId: legacy.entryId,
        currency: "USD",
        currencyVerified: false,
        originalAmount: "40.000000",
      });
      await expectOpenItemError(
        applyPartyOpenItemMatchTx(tx, {
          companyId: w.companyId,
          domain: "customer",
          partyId: w.customerId,
          chargeEntryId: legacy.entryId,
          settlementEntryId: payment.entryId,
          amount: "10",
          idempotencyKey: `legacy-${++seq}`,
          actor,
        }),
        "OPEN_ITEM_CURRENCY_UNVERIFIED"
      );
    });
  });

  it("treats credits as supplier charges and debits as supplier settlements", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await w.line({ type: "Purchase", date: "2026-03-01", credit: 70, target: "supplier" });
      await w.line({ type: "Payment", date: "2026-03-02", debit: 30, target: "supplier" });
      await w.line({ date: "2026-03-02", debit: 99, target: "customer" });
      const summary = await loadPartyOpenItemsTx(tx, {
        companyId: w.companyId,
        domain: "supplier",
        partyId: w.supplierId,
      });
      expect(summary.items.map((item) => [item.voucherType, item.side, item.originalAmount, item.dueDate])).toEqual([
        ["Purchase", "charge", "70.000000", null],
        ["Payment", "settlement", "30.000000", null],
      ]);
      expect(summary.openingBalance).toEqual({ amount: "0.000000", side: null, includedInMatching: false });
      expect(held.calls).toEqual([]);

      await w.line({ date: "2026-03-01", credit: 12, target: "factory_supplier" });
      const factory = await loadPartyOpenItemsTx(tx, {
        companyId: w.companyId,
        domain: "factory_supplier",
        partyId: w.factorySupplierId,
      });
      expect(factory.items.map((item) => [item.side, item.originalAmount])).toEqual([["charge", "12.000000"]]);
    });
  });

  it("refuses parties outside the company or deleted", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const other = await world(tx);
      for (const [domain, partyId] of [
        ["customer", other.customerId],
        ["supplier", other.supplierId],
        ["factory_supplier", other.factorySupplierId],
      ] as const) {
        await expectOpenItemError(
          loadPartyOpenItemsTx(tx, { companyId: w.companyId, domain, partyId }),
          "OPEN_ITEM_PARTY_NOT_FOUND",
          404
        );
      }
      await tx.execute(sql`UPDATE customers SET deleted_at=NOW() WHERE id=${w.customerId}`);
      await expectOpenItemError(loadPartyOpenItemsTx(tx, customerTarget(w)), "OPEN_ITEM_PARTY_NOT_FOUND", 404);
    });
  });
});

describe("applyPartyOpenItemMatchTx", () => {
  const base = (w: World, chargeEntryId: number, settlementEntryId: number, extra: Record<string, unknown> = {}) => ({
    companyId: w.companyId,
    domain: "customer" as const,
    partyId: w.customerId,
    chargeEntryId,
    settlementEntryId,
    amount: "25",
    idempotencyKey: `key-${++seq}`,
    actor,
    ...extra,
  });

  it("records a match once, audits it and replays the same key", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const invoice = await w.line({ type: "Sales", date: "2026-03-01", debit: 100 });
      const payment = await w.line({ date: "2026-03-02", credit: 60 });
      const input = base(w, invoice.entryId, payment.entryId, { reason: "March receipt" });

      const first = await applyPartyOpenItemMatchTx(tx, input);
      expect(first).toEqual({ id: expect.any(Number), replayed: false });
      const [row] = resultRows<Record<string, unknown>>(
        await tx.execute(sql`SELECT domain,party_id,amount::text,currency,created_by,reason,idempotency_key,
            applied_on=CURRENT_DATE AS today FROM accounting_open_item_matches WHERE id=${first.id}`)
      );
      expect(row).toEqual({
        domain: "customer",
        party_id: w.customerId,
        amount: "25.000000",
        currency: "USD",
        created_by: "7",
        reason: "March receipt",
        idempotency_key: input.idempotencyKey,
        today: true,
      });
      const audits = resultRows<Record<string, unknown>>(
        await tx.execute(sql`SELECT action,table_name,record_id,user_id FROM audit_log
            WHERE company_id=${w.companyId} AND table_name='accounting_open_item_matches'`)
      );
      expect(audits).toEqual([
        expect.objectContaining({ action: "create", table_name: "accounting_open_item_matches", record_id: first.id }),
      ]);

      await expect(applyPartyOpenItemMatchTx(tx, { ...input, amount: "25.000000" })).resolves.toEqual({
        id: first.id,
        replayed: true,
      });
      await expectOpenItemError(
        applyPartyOpenItemMatchTx(tx, { ...input, amount: "26" }),
        "OPEN_ITEM_IDEMPOTENCY_CONFLICT"
      );
      const second = await w.line({ date: "2026-03-03", credit: 5 });
      await expectOpenItemError(
        applyPartyOpenItemMatchTx(tx, { ...input, settlementEntryId: second.entryId }),
        "OPEN_ITEM_IDEMPOTENCY_CONFLICT"
      );
      const third = await w.line({ type: "Sales", date: "2026-03-03", debit: 5 });
      await expectOpenItemError(
        applyPartyOpenItemMatchTx(tx, { ...input, chargeEntryId: third.entryId }),
        "OPEN_ITEM_IDEMPOTENCY_CONFLICT"
      );

      await voidPartyOpenItemMatchTx(tx, { companyId: w.companyId, matchId: first.id, actor, reason: "wrong" });
      await expectOpenItemError(applyPartyOpenItemMatchTx(tx, input), "OPEN_ITEM_IDEMPOTENCY_CONFLICT", 409);

      // Without a reason the column stays null.
      const plain = await applyPartyOpenItemMatchTx(tx, base(w, invoice.entryId, payment.entryId, { amount: "1" }));
      const [plainRow] = resultRows<{ reason: string | null }>(
        await tx.execute(sql`SELECT reason FROM accounting_open_item_matches WHERE id=${plain.id}`)
      );
      expect(plainRow.reason).toBeNull();
    });
  });

  it("validates the request before touching the books", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await expectOpenItemError(applyPartyOpenItemMatchTx(tx, base(w, 0, 2)), "OPEN_ITEM_ID_INVALID", 400);
      await expectOpenItemError(applyPartyOpenItemMatchTx(tx, base(w, 2, -3)), "OPEN_ITEM_ID_INVALID", 400);
      await expectOpenItemError(applyPartyOpenItemMatchTx(tx, base(w, 2, 2)), "OPEN_ITEM_SAME_ENTRY", 400);
      for (const amount of ["0", "-5", "1.0000001"]) {
        await expectOpenItemError(
          applyPartyOpenItemMatchTx(tx, base(w, 1, 2, { amount })),
          "OPEN_ITEM_AMOUNT_INVALID",
          400
        );
      }
      await expectOpenItemError(
        applyPartyOpenItemMatchTx(tx, base(w, 1, 2, { amount: "NaN" })),
        "OPEN_ITEM_AMOUNT_INVALID"
      );
      for (const idempotencyKey of ["", "has space", "x".repeat(192)]) {
        await expectOpenItemError(
          applyPartyOpenItemMatchTx(tx, base(w, 1, 2, { idempotencyKey })),
          "OPEN_ITEM_KEY_INVALID",
          400
        );
      }
      await expectOpenItemError(
        applyPartyOpenItemMatchTx(tx, base(w, 1, 2, { domain: "lease" })),
        "OPEN_ITEM_DOMAIN_INVALID",
        400
      );
    });
  });

  it("only matches live charges against live settlements of the same party", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const invoice = await w.line({ type: "Sales", date: "2026-03-01", debit: 100 });
      const payment = await w.line({ date: "2026-03-02", credit: 60 });
      const future = await w.line({ date: "2099-01-01", credit: 60 });
      const vendorBill = await w.line({ date: "2026-03-02", credit: 60, target: "supplier" });

      // Swapped sides, future-dated settlement and another party's line.
      for (const [charge, settlement] of [
        [payment.entryId, invoice.entryId],
        [invoice.entryId, future.entryId],
        [invoice.entryId, vendorBill.entryId],
      ]) {
        await expectOpenItemError(applyPartyOpenItemMatchTx(tx, base(w, charge, settlement)), "OPEN_ITEM_NOT_ELIGIBLE");
      }
      await expectOpenItemError(
        applyPartyOpenItemMatchTx(tx, base(w, invoice.entryId, payment.entryId, { amount: "60.000001" })),
        "OPEN_ITEM_OVERALLOCATION"
      );
      await applyPartyOpenItemMatchTx(tx, base(w, invoice.entryId, payment.entryId, { amount: "50" }));
      await expectOpenItemError(
        applyPartyOpenItemMatchTx(tx, base(w, invoice.entryId, payment.entryId, { amount: "10.5" })),
        "OPEN_ITEM_OVERALLOCATION"
      );
      // Exactly the remaining settlement balance is allowed.
      await expect(
        applyPartyOpenItemMatchTx(tx, base(w, invoice.entryId, payment.entryId, { amount: "10" }))
      ).resolves.toMatchObject({ replayed: false });
    });
  });

  it("refuses to match across currencies or with unverified legacy amounts", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const euroInvoice = await w.line({ type: "Sales", date: "2026-03-01", debit: 100, currency: "EUR" });
      const dollarPayment = await w.line({ date: "2026-03-02", credit: 60 });
      const euroPayment = await w.line({ date: "2026-03-02", credit: 60, currency: "EUR" });
      await expectOpenItemError(
        applyPartyOpenItemMatchTx(tx, base(w, euroInvoice.entryId, dollarPayment.entryId)),
        "OPEN_ITEM_CURRENCY_MISMATCH"
      );
      await expect(
        applyPartyOpenItemMatchTx(tx, base(w, euroInvoice.entryId, euroPayment.entryId))
      ).resolves.toMatchObject({ replayed: false });
      const [row] = resultRows<{ currency: string }>(
        await tx.execute(
          sql`SELECT currency FROM accounting_open_item_matches WHERE charge_entry_id=${euroInvoice.entryId}`
        )
      );
      expect(row.currency).toBe("EUR");
    });
  });

  it("supports supplier matches with credits as charges", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const bill = await w.line({ date: "2026-03-01", credit: 40, target: "supplier" });
      const paid = await w.line({ date: "2026-03-02", debit: 40, target: "supplier" });
      await expect(
        applyPartyOpenItemMatchTx(tx, {
          ...base(w, bill.entryId, paid.entryId, { amount: "40" }),
          domain: "supplier",
          partyId: w.supplierId,
        })
      ).resolves.toMatchObject({ replayed: false });
    });
  });
});

describe("voidPartyOpenItemMatchTx", () => {
  it("voids a live match once and audits it", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const invoice = await w.line({ date: "2026-03-01", debit: 10 });
      const payment = await w.line({ date: "2026-03-01", credit: 10 });
      const matchId = await w.match(invoice.entryId, payment.entryId, 10, { appliedOn: "2026-10-01" });

      await expectOpenItemError(
        voidPartyOpenItemMatchTx(tx, { companyId: w.companyId, matchId, actor, reason: "  " }),
        "OPEN_ITEM_REASON_REQUIRED",
        400
      );
      await expectOpenItemError(
        voidPartyOpenItemMatchTx(tx, { companyId: w.companyId, matchId: 0, actor, reason: "x" }),
        "OPEN_ITEM_ID_INVALID",
        400
      );
      await expectOpenItemError(
        voidPartyOpenItemMatchTx(tx, { companyId: w.companyId, matchId: matchId + 100000, actor, reason: "x" }),
        "OPEN_ITEM_MATCH_NOT_FOUND",
        404
      );

      await expect(
        voidPartyOpenItemMatchTx(tx, { companyId: w.companyId, matchId, actor, reason: "duplicate" })
      ).resolves.toEqual({ id: matchId, voided: true });
      const [row] = resultRows<Record<string, unknown>>(
        await tx.execute(
          sql`SELECT voided_by,void_reason,voided_at IS NOT NULL AS voided FROM accounting_open_item_matches WHERE id=${matchId}`
        )
      );
      expect(row).toEqual({ voided_by: "7", void_reason: "duplicate", voided: true });
      const audits = resultRows<Record<string, unknown>>(
        await tx.execute(
          sql`SELECT action,record_id FROM audit_log WHERE company_id=${w.companyId} AND table_name='accounting_open_item_matches'`
        )
      );
      expect(audits).toEqual([{ action: "update", record_id: matchId }]);

      await expectOpenItemError(
        voidPartyOpenItemMatchTx(tx, { companyId: w.companyId, matchId, actor, reason: "again" }),
        "OPEN_ITEM_MATCH_VOIDED"
      );
    });
  });

  it("cannot void another company's match", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const other = await world(tx);
      const invoice = await other.line({ date: "2026-03-01", debit: 10 });
      const payment = await other.line({ date: "2026-03-01", credit: 10 });
      const matchId = await other.match(invoice.entryId, payment.entryId, 10);
      await expectOpenItemError(
        voidPartyOpenItemMatchTx(tx, { companyId: w.companyId, matchId, actor, reason: "x" }),
        "OPEN_ITEM_MATCH_NOT_FOUND"
      );
    });
  });

  it("requires a realized FX journal to be reversed first", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const invoice = await w.line({ date: "2026-03-01", debit: 10 });
      const payment = await w.line({ date: "2026-03-01", credit: 10 });
      const matchId = await w.match(invoice.entryId, payment.entryId, 10, { appliedOn: "2026-10-01" });
      const fx = await w.line({ date: "2026-10-01", credit: 1 });
      await tx.execute(sql`INSERT INTO accounting_fx_realizations(company_id,match_id,voucher_id,native_currency,native_amount,
          historical_charge_base,historical_settlement_base,realized_gain_base,recognized_date,actor)
        VALUES(${w.companyId},${matchId},${fx.voucherId},'EUR',10,10,11,1,'2026-10-01','1')`);

      const error = await expectOpenItemError(
        voidPartyOpenItemMatchTx(tx, { companyId: w.companyId, matchId, actor, reason: "x" }),
        "OPEN_ITEM_REALIZED_FX_POSTED"
      );
      expect(error.message).toBe(`Reverse the realized FX journal #${fx.voucherId} before cancelling this match`);

      const reversal = await w.line({ date: "2026-10-02", debit: 1 });
      await tx.execute(sql`UPDATE vouchers SET reversal_of_voucher_id=${fx.voucherId} WHERE id=${reversal.voucherId}`);
      await expect(
        voidPartyOpenItemMatchTx(tx, { companyId: w.companyId, matchId, actor, reason: "x" })
      ).resolves.toEqual({ id: matchId, voided: true });
    });
  });

  it("ignores realized FX journals that were deleted", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const invoice = await w.line({ date: "2026-03-01", debit: 10 });
      const payment = await w.line({ date: "2026-03-01", credit: 10 });
      const matchId = await w.match(invoice.entryId, payment.entryId, 10, { appliedOn: "2026-10-01" });
      const fx = await w.line({ date: "2026-10-01", credit: 1, deleted: true });
      await tx.execute(sql`INSERT INTO accounting_fx_realizations(company_id,match_id,voucher_id,native_currency,native_amount,
          historical_charge_base,historical_settlement_base,realized_gain_base,recognized_date,actor)
        VALUES(${w.companyId},${matchId},${fx.voucherId},'EUR',10,10,11,1,'2026-10-01','1')`);
      await expect(
        voidPartyOpenItemMatchTx(tx, { companyId: w.companyId, matchId, actor, reason: "x" })
      ).resolves.toMatchObject({ voided: true });
    });
  });
});
