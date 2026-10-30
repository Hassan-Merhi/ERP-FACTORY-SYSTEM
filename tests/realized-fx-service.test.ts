/**
 * Realized FX on matched open items: the preview's blockers and the
 * customer/supplier gain direction, the list query, and recognition with its
 * replay, re-check, account and posting steps. The transaction, company
 * scope, business date, system accounts, posting engine and audit log are
 * stubbed; queries are recognised by their SQL text.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  scope: vi.fn(),
  businessDate: vi.fn(),
  systemAccounts: vi.fn(),
  post: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("../server/services/security/transactionCompanyScope", () => ({
  assertTransactionCompanyScope: (...a: unknown[]) => h.scope(...a),
}));
vi.mock("../server/services/accounting/companyBusinessDate", () => ({
  companyBusinessDate: (...a: unknown[]) => h.businessDate(...a),
}));
vi.mock("../server/services/accounting/systemAccounts", () => ({
  ensureSystemAccounts: (...a: unknown[]) => h.systemAccounts(...a),
}));
vi.mock("../server/services/accounting/erpVoucherPosting", () => ({
  postErpVoucherTx: (...a: unknown[]) => h.post(...a),
}));
vi.mock("../server/services/audit", () => ({ writeAuditEvent: (...a: unknown[]) => h.audit(...a) }));

import {
  listRealizedFxTx,
  previewRealizedFxTx,
  recognizeRealizedFxTx,
} from "../server/services/accounting/realizedFxService";
import { MonetaryFxError } from "../server/services/accounting/monetaryFxRates";

const dialect = new PgDialect();
type Row = Record<string, unknown>;

/** A transaction that answers each query from `respond`, keyed by SQL text. */
function fakeTx(respond: (text: string, params: unknown[]) => Row[]) {
  const log: Array<{ text: string; params: unknown[] }> = [];
  const tx = {
    execute: async (query: SQL) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      log.push({ text, params });
      return { rows: respond(text, params) };
    },
  };
  return { tx: tx as never, log };
}

/** A EUR customer invoice of 100 at 1.10 settled at 1.20: +10 USD gain. */
const match = (over: Row = {}): Row => ({
  id: 7,
  company_id: 3,
  domain: "customer",
  party_id: 42,
  amount: "100",
  currency: "eur",
  applied_on: "2026-10-01",
  voided_at: null,
  charge_voucher: "INV-1",
  settlement_voucher: "RCPT-1",
  charge_module: "factory",
  charge_deleted: null,
  settlement_deleted: null,
  charge_optional: false,
  settlement_optional: false,
  charge_currency: "EUR",
  settlement_currency: "eur",
  charge_debit: "100",
  charge_credit: "0",
  settle_debit: "0",
  settle_credit: "100",
  charge_base_debit: "110",
  charge_base_credit: "0",
  settle_base_debit: "0",
  settle_base_credit: "120",
  charge_customer_id: 42,
  charge_supplier_id: null,
  charge_factory_supplier_id: null,
  settle_customer_id: 42,
  settle_supplier_id: null,
  settle_factory_supplier_id: null,
  recognition_voucher_id: null,
  realized_record_id: null,
  recognition_deleted: null,
  reversed_by: null,
  ...over,
});

const supplierMatch = (over: Row = {}): Row =>
  match({
    domain: "supplier",
    charge_customer_id: null,
    settle_customer_id: null,
    charge_supplier_id: 42,
    settle_supplier_id: 42,
    charge_debit: "0",
    charge_credit: "100",
    settle_debit: "100",
    settle_credit: "0",
    charge_base_debit: "0",
    charge_base_credit: "110",
    settle_base_debit: "120",
    settle_base_credit: "0",
    ...over,
  });

const matchTx = (row: Row | null) =>
  fakeTx((text) => (text.includes("FROM accounting_open_item_matches m") ? (row ? [row] : []) : []));

async function preview(row: Row) {
  return previewRealizedFxTx(matchTx(row).tx, 3, 7);
}

async function fxError(work: Promise<unknown>) {
  const error = await work.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MonetaryFxError);
  const e = error as MonetaryFxError & { code: string; status?: number; statusCode?: number };
  return [e.code, e.message];
}

beforeEach(() => {
  h.scope.mockReset().mockResolvedValue(undefined);
  h.businessDate.mockReset().mockResolvedValue("2026-10-30");
  h.systemAccounts.mockReset().mockResolvedValue([{ state: "ok", accountId: 900 }]);
  h.post.mockReset().mockResolvedValue({ voucher: { id: 555 }, replayed: false });
  h.audit.mockReset().mockResolvedValue(undefined);
});

describe("previewRealizedFxTx", () => {
  it("rejects invalid ids before touching the database and unknown matches as 404", async () => {
    for (const [companyId, matchId] of [
      [0, 7],
      [3, 0],
      [3, 1.5],
      [Number.MAX_SAFE_INTEGER + 1, 7],
    ]) {
      const { tx, log } = matchTx(match());
      expect(await fxError(previewRealizedFxTx(tx, companyId, matchId))).toEqual([
        "FX_MATCH_INVALID",
        "Invalid match or company",
      ]);
      expect(log).toEqual([]);
    }
    expect(await fxError(previewRealizedFxTx(matchTx(null).tx, 3, 7))).toEqual([
      "FX_MATCH_NOT_FOUND",
      "No matching record exists in this company",
    ]);
    expect(h.scope).toHaveBeenCalledWith(expect.anything(), 3);
  });

  it("computes a customer gain as settlement value minus invoice value", async () => {
    expect(await preview(match())).toEqual({
      matchId: 7,
      domain: "customer",
      partyId: 42,
      nativeCurrency: "EUR",
      nativeMatchedAmount: "100.000000",
      chargeVoucher: "INV-1",
      settlementVoucher: "RCPT-1",
      chargeHistoricalUsd: "110.000000",
      settlementHistoricalUsd: "120.000000",
      realizedGainUsd: "10.000000",
      classification: "REALIZED_FX_NOT_UNREALIZED_REVALUATION",
      recognitionVoucherId: null,
      status: "ready",
      postable: true,
      issue: null,
    });
  });

  it("prorates a partial allocation and reverses the sign for suppliers", async () => {
    // 40 of a 100 invoice and of a 200 payment: 44.00 vs 48.00 USD.
    const partial = await preview(match({ amount: "40", settle_credit: "200", settle_base_credit: "240" }));
    expect(partial).toMatchObject({
      chargeHistoricalUsd: "44.000000",
      settlementHistoricalUsd: "48.000000",
      realizedGainUsd: "4.000000",
    });
    expect(await preview(supplierMatch())).toMatchObject({ realizedGainUsd: "-10.000000", postable: true });
    expect(await preview(supplierMatch({ charge_base_credit: "120.004", settle_base_debit: "110" }))).toMatchObject({
      realizedGainUsd: "10.000000",
    });
  });

  it("reports no difference for USD and for gains that round to zero cents", async () => {
    expect(await preview(match({ currency: "usd" }))).toMatchObject({
      status: "no_difference",
      postable: false,
      issue: null,
      realizedGainUsd: "0.000000",
    });
    expect(await preview(match({ settle_base_credit: "110.004" }))).toMatchObject({
      status: "no_difference",
      postable: false,
      realizedGainUsd: "0.000000",
      settlementHistoricalUsd: "110.004000",
    });
  });

  it("blocks deleted, optional or voided sources", async () => {
    const issue = "A source voucher or match is deleted, unposted, or cancelled";
    for (const over of [
      { voided_at: "2026-10-02" },
      { charge_deleted: "2026-10-02" },
      { settlement_deleted: "2026-10-02" },
      { charge_optional: true },
      { settlement_optional: true },
    ]) {
      expect(await preview(match(over))).toMatchObject({ status: "blocked", postable: false, issue });
    }
    // Even a USD match is blocked when its source is cancelled.
    expect(await preview(match({ currency: "USD", voided_at: "x" }))).toMatchObject({ status: "blocked" });
  });

  it("blocks a match whose lines no longer belong to the matched party", async () => {
    const issue = "Original customer/supplier ownership changed or requires linked-ledger review";
    for (const row of [
      match({ charge_customer_id: 43 }),
      match({ settle_customer_id: 43 }),
      match({ charge_customer_id: null, settle_customer_id: 0, party_id: 0 }),
      match({ settle_customer_id: null, party_id: 0, charge_customer_id: 0 }),
      supplierMatch({ settle_supplier_id: null }),
      match({ domain: "factory_supplier", charge_factory_supplier_id: 42, settle_factory_supplier_id: 41 }),
    ]) {
      expect(await preview(row)).toMatchObject({ status: "blocked", issue });
    }
  });

  it("blocks lines without verified currency and historical USD", async () => {
    const issue = "Original currency and historical USD columns must be verified on both lines";
    for (const over of [
      { charge_currency: null },
      { settlement_currency: null },
      { charge_currency: "GBP" },
      { settlement_currency: "GBP" },
      ...[
        "charge_debit",
        "charge_credit",
        "settle_debit",
        "settle_credit",
        "charge_base_debit",
        "charge_base_credit",
        "settle_base_debit",
        "settle_base_credit",
      ].map((column) => ({ [column]: null })),
    ]) {
      expect(await preview(match(over))).toMatchObject({ status: "blocked", issue });
    }
  });

  it("blocks allocations the invoice or payment cannot cover", async () => {
    const issue = "Invoice/payment amounts are incompatible with the saved allocation";
    for (const over of [
      { amount: "0" },
      { charge_debit: "0" },
      { settle_credit: "-1" },
      { amount: "100.01" },
      { amount: "150", settle_credit: "200" },
      { amount: "60", charge_debit: "100", settle_credit: "50" },
      { charge_base_debit: "0" },
      { settle_base_credit: "0" },
    ]) {
      expect(await preview(match(over))).toMatchObject({ status: "blocked", issue });
    }
  });

  it("reports recognized and reversed recognitions without re-posting", async () => {
    expect(await preview(match({ realized_record_id: 1, recognition_voucher_id: 88 }))).toMatchObject({
      status: "recognized",
      postable: false,
      issue: null,
      recognitionVoucherId: 88,
    });
    const reversedIssue = "Recognition voucher has been reversed; no automatic re-post";
    for (const over of [{ reversed_by: 99 }, { recognition_deleted: "2026-10-05" }]) {
      expect(await preview(match({ realized_record_id: 1, recognition_voucher_id: 88, ...over }))).toMatchObject({
        status: "reversed",
        postable: false,
        issue: reversedIssue,
      });
    }
    // A voucher id without a realization record is not a recognition.
    expect(await preview(match({ recognition_voucher_id: 88, reversed_by: 99 }))).toMatchObject({
      status: "ready",
      recognitionVoucherId: 88,
    });
  });

  it("never auto-posts Factory supplier exposures", async () => {
    expect(
      await preview(
        supplierMatch({
          domain: "factory_supplier",
          charge_supplier_id: null,
          settle_supplier_id: null,
          charge_factory_supplier_id: 42,
          settle_factory_supplier_id: 42,
        })
      )
    ).toMatchObject({
      status: "ready",
      postable: false,
      realizedGainUsd: "-10.000000",
      issue: "Factory supplier currency exposures use the inside/outside settlement policy; manual review required",
    });
  });
});

describe("listRealizedFxTx", () => {
  it("previews the most recent matches up to the as-of date, filtered by domain and party", async () => {
    const { tx, log } = fakeTx((text, params) => {
      if (text.includes("SELECT id FROM accounting_open_item_matches")) return [{ id: 7 }, { id: 8 }];
      return [match({ id: params[1] })];
    });
    const out = await listRealizedFxTx(tx, { companyId: 3, domain: "supplier", partyId: 42, asOfDate: "2026-10-30" });
    expect(out).toMatchObject({
      companyId: 3,
      asOfDate: "2026-10-30",
      accountingMode: "RECORDED_NATIVE_AND_HISTORIC_BASE_ONLY",
      limitedToMostRecent: 300,
      recognitionStatusAsOf: false,
    });
    expect(out.items.map((item) => item.matchId)).toEqual([7, 8]);
    expect(log[0].text).toContain("AND domain=");
    expect(log[0].text).toContain("AND party_id=");
    expect(log[0].text).toContain("LIMIT 300");
    expect(log[0].params).toEqual([3, "2026-10-30", "supplier", 42]);

    const unfiltered = fakeTx(() => []);
    expect((await listRealizedFxTx(unfiltered.tx, { companyId: 3, asOfDate: "2026-10-30" })).items).toEqual([]);
    expect(unfiltered.log[0].text).not.toContain("AND domain=");
    expect(unfiltered.log[0].text).not.toContain("AND party_id=");
    expect(unfiltered.log[0].params).toEqual([3, "2026-10-30"]);
  });
});

describe("recognizeRealizedFxTx", () => {
  const actor = { userId: "u1", username: "accountant" };
  const recognize = (tx: never, reason = "  Year-end FX review ") =>
    recognizeRealizedFxTx(tx, { companyId: 3, matchId: 7, actor, reason });

  it("posts a gain against the party and the realized FX account, then records it", async () => {
    const { tx, log } = matchTx(match());
    expect(await recognize(tx)).toMatchObject({
      voucherId: 555,
      replayed: false,
      preview: { realizedGainUsd: "10.000000" },
    });

    expect(log[0].text).toContain("pg_advisory_xact_lock");
    expect(log[0].params).toEqual(["realized-fx:3:7"]);
    expect(log.some((q) => q.text.includes("FOR UPDATE"))).toBe(true);
    const dateCheck = log.find((q) => q.text.includes("erp_assert_accounting_date_open"));
    expect(dateCheck?.params).toEqual([3, "2026-10-30"]);
    expect(h.systemAccounts).toHaveBeenCalledWith(tx, 3, ["FX-REALIZED"]);

    const narrative = "Realized FX for matched EUR invoice INV-1, settlement RCPT-1; match #7";
    expect(h.post).toHaveBeenCalledWith(tx, {
      companyId: 3,
      voucherType: "Journal",
      voucherDate: "2026-10-30",
      description: narrative,
      sourceModule: "FACTORY",
      currency: "USD",
      source: { type: "fx-realized-open-item", id: "7" },
      actor: { ...actor, reason: "Year-end FX review" },
      lines: [
        { customerId: 42, debit: "10.00", narration: narrative },
        { ledgerAccountId: 900, credit: "10.00", narration: narrative },
      ],
    });
    const insert = log.find((q) => q.text.includes("INSERT INTO accounting_fx_realizations"));
    expect(insert?.params).toEqual([
      3,
      7,
      555,
      "EUR",
      "100.000000",
      "110.000000",
      "120.000000",
      "10.000000",
      "2026-10-30",
      "u1",
    ]);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 3,
        action: "create",
        tableName: "accounting_fx_realizations",
        recordId: 555,
        recordIdentifier: "match:7",
        changes: expect.objectContaining({ gainBase: { new: "10.000000" }, reason: { new: "Year-end FX review" } }),
      }),
      tx
    );
  });

  it("posts a supplier loss the other way round and defaults unknown modules to ERP", async () => {
    const { tx } = matchTx(supplierMatch({ charge_module: "pos" }));
    await recognize(tx);
    const voucher = h.post.mock.calls[0][1];
    expect(voucher.sourceModule).toBe("ERP");
    expect(voucher.lines).toEqual([
      expect.objectContaining({ supplierId: 42, credit: "10.00" }),
      expect.objectContaining({ ledgerAccountId: 900, debit: "10.00" }),
    ]);
    for (const module of [null, "properties"]) {
      h.post.mockClear();
      await recognize(matchTx(match({ charge_module: module })).tx);
      expect(h.post.mock.calls[0][1].sourceModule).toBe(module ? "PROPERTIES" : "ERP");
    }
  });

  it("requires a reason and replays an existing recognition", async () => {
    for (const reason of ["", "   "]) {
      expect(await fxError(recognize(matchTx(match()).tx, reason))).toEqual([
        "FX_REASON_REQUIRED",
        "State why this realized FX adjustment is being recognized",
      ]);
    }
    expect(
      await fxError(recognizeRealizedFxTx(matchTx(match()).tx, { companyId: 3, matchId: 7, actor } as never))
    ).toEqual(["FX_REASON_REQUIRED", expect.any(String)]);
    const done = await recognize(matchTx(match({ realized_record_id: 1, recognition_voucher_id: 88 })).tx);
    expect(done).toMatchObject({ voucherId: 88, replayed: true, preview: { status: "recognized" } });
    expect(h.post).not.toHaveBeenCalled();
  });

  it("refuses matches that are not postable, or changed while locking", async () => {
    expect(await fxError(recognize(matchTx(match({ voided_at: "x" })).tx))).toEqual([
      "FX_NOT_POSTABLE",
      "A source voucher or match is deleted, unposted, or cancelled",
    ]);
    expect(await fxError(recognize(matchTx(match({ currency: "USD" })).tx))).toEqual([
      "FX_NOT_POSTABLE",
      "No unrecognized realized FX adjustment is available",
    ]);
    let loads = 0;
    const changing = fakeTx((text) => {
      if (!text.includes("FROM accounting_open_item_matches m")) return [];
      loads += 1;
      return [loads === 1 ? match() : match({ voided_at: "2026-10-30" })];
    });
    expect(await fxError(recognize(changing.tx))).toEqual([
      "FX_NOT_POSTABLE",
      "This match has changed and can no longer be recognized",
    ]);
    expect(h.post).not.toHaveBeenCalled();
  });

  it("needs a usable realized FX system account", async () => {
    for (const accounts of [[], [{ state: "conflict" }], [{ state: "created" }]]) {
      h.systemAccounts.mockResolvedValueOnce(accounts);
      const [code] = await fxError(recognize(matchTx(match()).tx));
      expect(code).toBe("FX_GAIN_LOSS_ACCOUNT_UNAVAILABLE");
    }
    h.systemAccounts.mockResolvedValueOnce([{ state: "created" }]);
    expect(await fxError(recognize(matchTx(match()).tx))).toEqual([
      "FX_GAIN_LOSS_ACCOUNT_UNAVAILABLE",
      "Cannot determine the FX gain/loss account",
    ]);
    h.systemAccounts.mockResolvedValueOnce([{ state: "conflict", accountId: 1 }]);
    expect(await fxError(recognize(matchTx(match()).tx))).toEqual([
      "FX_GAIN_LOSS_ACCOUNT_UNAVAILABLE",
      "A valid Realized FX Gain/Loss system account is required",
    ]);
    h.systemAccounts.mockResolvedValueOnce([{ state: "created", accountId: 901 }]);
    await recognize(matchTx(match()).tx);
    expect(h.post.mock.calls[0][1].lines[1].ledgerAccountId).toBe(901);
  });
});
