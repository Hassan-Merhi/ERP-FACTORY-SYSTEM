/**
 * Post-offload reconciliation checks
 * (server/services/factory/postOffloadReconciliationReconcileActiveVoucher.ts):
 * the parse/metadata helpers, every original-daybook mismatch, and every
 * refusal and normalization outcome of reconcileActiveVoucher. The query
 * client is a scripted stand-in for the transaction client the caller passes.
 */
import { describe, expect, it } from "vitest";

import {
  closeEnough,
  errorMessage,
  loadDaybook,
  metadata,
  parseDecimal,
  reconcileActiveVoucher,
  uniqueIssues,
  verifyOriginalDaybook,
  type ChargeRow,
  type ReconciliationQueryClient,
} from "../server/services/factory/postOffloadReconciliationReconcileActiveVoucher";

interface Script {
  voucher?: Record<string, unknown> | null;
  entries?: Record<string, unknown>[];
  updateCount?: number;
  daybook?: Record<string, unknown> | null;
}

function client(script: Script) {
  const updates: unknown[][] = [];
  const fake = {
    query: async (text: string, params: unknown[] = []) => {
      if (/FROM vouchers/.test(text)) return { rows: script.voucher ? [script.voucher] : [], rowCount: 0 };
      if (/FROM voucher_entries/.test(text)) return { rows: script.entries ?? [], rowCount: 0 };
      if (/FROM factory_daybook_entries/.test(text))
        return { rows: script.daybook ? [script.daybook] : [], rowCount: 0 };
      if (/UPDATE voucher_entries/.test(text)) {
        updates.push(params);
        return { rows: [], rowCount: script.updateCount ?? 1 };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  return { fake: fake as unknown as ReconciliationQueryClient, updates };
}

const charge = (overrides: Partial<ChargeRow> = {}): ChargeRow => ({
  id: 7,
  amount: "100",
  currency_code: "eur",
  fx_rate_to_usd: "1.1",
  ledger_account_id: 50,
  supplier_id: null,
  voucher_id: 900,
  daybook_entry_id: 1,
  reversal_daybook_entry_id: null,
  deleted_at: null,
  ...overrides,
});

const voucher = (overrides: Record<string, unknown> = {}) => ({
  id: 900,
  company_id: 1,
  total_amount: "100",
  currency: "EUR",
  exchange_rate: "1.1",
  source_module: "FACTORY",
  deleted_at: null,
  ...overrides,
});

const debit = {
  id: 1,
  ledger_account_id: 60,
  factory_supplier_id: null,
  debit_amount: "110",
  credit_amount: "0",
  transaction_debit_amount: "100",
  transaction_credit_amount: "0",
};
const credit = {
  id: 2,
  ledger_account_id: 50,
  factory_supplier_id: null,
  debit_amount: "0",
  credit_amount: "110",
  transaction_debit_amount: null,
  transaction_credit_amount: null,
};

async function run(c: ChargeRow, script: Script) {
  const issues: string[] = [];
  const { fake, updates } = client(script);
  const result = await reconcileActiveVoucher({ client: fake, charge: c, accountingIssues: issues });
  return { result, issues, updates };
}

describe("helpers", () => {
  it("parses decimals with fallbacks, compares with tolerance and reads metadata", () => {
    expect(parseDecimal("1.5").toFixed()).toBe("1.5");
    expect(parseDecimal(null, "2").toFixed()).toBe("2");
    expect(parseDecimal("abc").toFixed()).toBe("0");
    expect(parseDecimal("Infinity").toFixed()).toBe("0");
    expect(closeEnough(parseDecimal("1.0000001"), parseDecimal("1"))).toBe(true);
    expect(closeEnough(parseDecimal("1.1"), parseDecimal("1"), "0.01")).toBe(false);
    expect(metadata({ a: 1 })).toEqual({ a: 1 });
    expect(metadata('{"b":2}')).toEqual({ b: 2 });
    expect(metadata("[1]")).toEqual({});
    expect(metadata("{bad")).toEqual({});
    expect(metadata([1])).toEqual({});
    expect(metadata(null)).toEqual({});
    expect(uniqueIssues(["a", "b", "a"])).toEqual(["a", "b"]);
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
  });

  it("loads a daybook row only for a real id", async () => {
    expect(await loadDaybook(client({}).fake, null)).toBeNull();
    expect(await loadDaybook(client({}).fake, 5)).toBeNull();
    expect(await loadDaybook(client({ daybook: { id: 5 } }).fake, 5)).toEqual({ id: 5 });
  });
});

describe("verifyOriginalDaybook", () => {
  const good = {
    id: 1,
    company_id: 3,
    tx_type: "OTHER_CHARGE",
    reference_id: 44,
    amount_currency: "100",
    fx_rate_to_usd: "1.1",
    amount_usd: "110",
    meta_json: { sourceType: "POST_OFFLOAD_ADDITIONAL", chargeId: 7 },
  };
  const verify = (row: typeof good | null) => {
    const issues: string[] = [];
    verifyOriginalDaybook({ row, companyId: 3, containerId: 44, charge: charge(), issues });
    return issues;
  };

  it("accepts a matching row and reports a missing one", () => {
    expect(verify(good)).toEqual([]);
    expect(verify(null)).toEqual(["charge 7: original daybook entry is missing"]);
  });

  it("reports each mismatch", () => {
    expect(
      verify({
        ...good,
        tx_type: "OTHER",
        meta_json: '{"sourceType":"X","chargeId":7}' as never,
        amount_currency: "90",
        fx_rate_to_usd: "1.2",
        amount_usd: "1",
      })
    ).toEqual([
      "charge 7: original daybook scope or type does not match the charge",
      "charge 7: original daybook metadata does not identify the charge",
      "charge 7: original daybook transaction amount does not reconcile",
      "charge 7: original daybook FX rate does not reconcile",
      "charge 7: original daybook USD amount does not reconcile",
    ]);
    expect(verify({ ...good, company_id: 9 })).toHaveLength(1);
    expect(verify({ ...good, reference_id: 1 })).toHaveLength(1);
    expect(verify({ ...good, meta_json: { sourceType: "POST_OFFLOAD_ADDITIONAL", chargeId: 8 } })).toHaveLength(1);
  });
});

describe("reconcileActiveVoucher", () => {
  it("handles a charge without a voucher, with or without an accounting target", async () => {
    const targeted = await run(charge({ voucher_id: null }), {});
    expect(targeted.result).toEqual({ voucherChecked: false, entriesNormalized: 0 });
    expect(targeted.issues).toEqual(["charge 7: active accounting target has no linked voucher"]);
    const untargeted = await run(charge({ voucher_id: null, ledger_account_id: null }), {});
    expect(untargeted.issues).toEqual([]);
  });

  it("reports a missing voucher, an orphan active voucher, and a deleted voucher on an active charge", async () => {
    expect((await run(charge(), { voucher: null })).issues).toEqual(["charge 7: linked voucher 900 is missing"]);
    const orphan = await run(charge({ ledger_account_id: null }), { voucher: voucher() });
    expect(orphan).toMatchObject({
      result: { voucherChecked: true },
      issues: ["charge 7: voucher remains active without an accounting target"],
    });
    const retired = await run(charge({ ledger_account_id: null }), { voucher: voucher({ deleted_at: new Date() }) });
    expect(retired.issues).toEqual([]);
    const deleted = await run(charge(), { voucher: voucher({ deleted_at: new Date() }) });
    expect(deleted.issues).toEqual(["charge 7: linked voucher is deleted while the charge is active"]);
  });

  it("refuses an invalid amount or FX rate before touching entries", async () => {
    expect((await run(charge({ amount: "0" }), { voucher: voucher() })).issues).toEqual([
      "charge 7: amount or FX rate is invalid",
    ]);
    expect((await run(charge({ fx_rate_to_usd: null }), { voucher: voucher() })).issues).toEqual([
      "charge 7: amount or FX rate is invalid",
    ]);
  });

  it("reports header mismatches and a voucher without exactly two entries", async () => {
    const res = await run(charge(), {
      voucher: voucher({ source_module: "ERP", currency: null, total_amount: "99", exchange_rate: "1.3" }),
      entries: [debit],
    });
    expect(res.issues).toEqual([
      "charge 7: linked voucher is not owned by the factory module",
      "charge 7: voucher currency does not match the charge",
      "charge 7: voucher total does not match the charge",
      "charge 7: voucher FX rate does not match the charge",
      "charge 7: voucher must contain exactly two entries",
    ]);
  });

  it("normalizes a clean debit/credit pair in the charge currency", async () => {
    const res = await run(charge(), { voucher: voucher(), entries: [debit, credit] });
    expect(res.result).toEqual({ voucherChecked: true, entriesNormalized: 2 });
    expect(res.issues).toEqual([]);
    expect(res.updates.map((params) => params[2])).toEqual(["EUR", "EUR"]);
  });

  it("checks the credit side against a ledger account or a supplier, and flags bad sides", async () => {
    const wrongLedger = await run(charge(), {
      voucher: voucher(),
      entries: [
        { ...debit, ledger_account_id: null },
        { ...credit, ledger_account_id: 51 },
      ],
    });
    expect(wrongLedger.issues).toEqual([
      "charge 7: payable debit entry has no ledger account",
      "charge 7: credit ledger account does not match the charge",
    ]);

    const supplierCharge = charge({ ledger_account_id: null, supplier_id: 12, currency_code: null });
    const usdVoucher = voucher({ currency: "USD" });
    const wrongSupplier = await run(supplierCharge, {
      voucher: usdVoucher,
      entries: [debit, { ...credit, factory_supplier_id: 13 }],
    });
    expect(wrongSupplier.issues).toEqual(["charge 7: credit supplier does not match the charge"]);
    const rightSupplier = await run(supplierCharge, {
      voucher: usdVoucher,
      entries: [debit, { ...credit, factory_supplier_id: 12 }],
    });
    expect(rightSupplier.issues).toEqual([]);

    const bothSides = await run(charge(), {
      voucher: voucher(),
      entries: [debit, { ...credit, transaction_debit_amount: "5", transaction_credit_amount: "5" }],
    });
    expect(bothSides.issues).toEqual([
      "charge 7: voucher entry 2 has an invalid debit/credit side",
      "charge 7: voucher does not have one debit and one credit entry",
      "charge 7: normalized voucher base amounts do not balance",
    ]);
    expect(bothSides.result.entriesNormalized).toBe(1);
  });

  it("reports entries that were not updated exactly once", async () => {
    const res = await run(charge(), { voucher: voucher(), entries: [debit, credit], updateCount: 0 });
    expect(res.result.entriesNormalized).toBe(0);
    expect(res.issues).toEqual([
      "charge 7: voucher entry 1 was not normalized exactly once",
      "charge 7: voucher entry 2 was not normalized exactly once",
    ]);
  });
});
