/**
 * Factory production accounting audit (read only): the same-day GL-to-cost
 * comparison and when it is withheld, the container cost evidence checks, the
 * order/invoice posting checks with their severities, warnings and summary.
 * The queries, valuation, cutover, ledger and scope helpers are stubbed.
 */
import Decimal from "decimal.js";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  scope: vi.fn(),
  businessDate: vi.fn(),
  cutover: vi.fn(),
  valuation: vi.fn(),
  inTransit: vi.fn(),
  ledger: vi.fn(),
  partner: vi.fn(),
}));
vi.mock("../server/services/security/transactionCompanyScope", () => ({
  assertTransactionCompanyScope: (...a: unknown[]) => h.scope(...a),
}));
vi.mock("../server/services/accounting/companyBusinessDate", () => ({
  companyBusinessDate: (...a: unknown[]) => h.businessDate(...a),
}));
vi.mock("../server/services/accounting/perpetualInventory/cutover", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/accounting/perpetualInventory/cutover")>()),
  getInventoryCutover: (...a: unknown[]) => h.cutover(...a),
}));
vi.mock("../server/services/accounting/perpetualInventory/factoryValuation", () => ({
  factoryStockValuation: (...a: unknown[]) => h.valuation(...a),
}));
vi.mock("../server/services/accounting/perpetualInventory/factoryStockJournal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/accounting/perpetualInventory/factoryStockJournal")>()),
  factoryGoodsInTransitHeld: (...a: unknown[]) => h.inTransit(...a),
}));
vi.mock("../server/services/accounting/perpetualInventory/linkedJournal", () => ({
  ledgerBalancesByCode: (...a: unknown[]) => h.ledger(...a),
  isSupplierPartnerCompany: (...a: unknown[]) => h.partner(...a),
}));

import { factoryProductionAccountingAuditTx } from "../server/services/accounting/perpetualInventory/factoryProductionAccountingAudit";
import { PERPETUAL_INVENTORY_POSTING_READY } from "../server/services/accounting/perpetualInventory/cutover";
import { factoryStockJournalNumber } from "../server/services/accounting/perpetualInventory/factoryStockJournal";

type Row = Record<string, unknown>;
const dialect = new PgDialect();
let containers: Row[];
let invoices: Row[];
let journal: Row[];
let log: Array<{ text: string; params: unknown[] }>;
const tx = {
  execute: async (query: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    log.push({ text, params });
    if (text.includes("FROM factory_containers c")) return { rows: containers };
    if (text.includes("FROM customer_orders co")) return { rows: invoices };
    return { rows: journal };
  },
} as never;

const container = (over: Row = {}): Row => ({
  id: 1,
  number: "FC-1",
  status: "RECEIVED",
  currency: "usd",
  rate_confirmed: false,
  fx_rate: null,
  declared_kg: "1000",
  master_received_kg: "990",
  receipt_count: 2,
  receipt_kg: "990.004",
  receipt_value_usd: "1980.005",
  missing_receipt_values: 0,
  first_receipt_date: "2026-10-01",
  last_receipt_date: "2026-10-02",
  raw_received_kg: "990",
  raw_used_kg: "400",
  raw_value_usd: "1180",
  raw_missing_rate: 0,
  ...over,
});
const invoice = (over: Row = {}): Row => ({
  id: 10,
  status: "FINALIZED",
  invoice_number: "INV-10",
  container_number: "FC-1",
  invoice_date: "2026-10-20",
  grand_total: "1000",
  customer_id: 5,
  charges: "100",
  verified_charges: "100",
  unverified_charges: 0,
  premature_charge_vouchers: 0,
  journal_id: 77,
  journal_date: "2026-10-20",
  posted_receivable_native: "900",
  posted_receivable_base: "900",
  posted_cogs: "600",
  posted_finished_credit: "600",
  cost: "600",
  unvalued_bales: 0,
  bales: 12,
  ...over,
});
const valuation = (unvalued: unknown[] = []) => ({
  raw: new Decimal("1180"),
  wip: new Decimal("50.005"),
  finished: new Decimal("600"),
  unvalued,
  reservedForOrders: { bales: 1, cost: "10.00" },
  soldNotInvoiced: { bales: 0, cost: "0.00" },
});

const audit = (asOfDate?: string) => factoryProductionAccountingAuditTx(tx, { companyId: 3, asOfDate });
const issuesOf = async (row: Row) => {
  invoices = [invoice(row)];
  return (await audit()).invoices[0];
};

beforeEach(() => {
  containers = [container()];
  invoices = [invoice()];
  journal = [{ id: 501, voucher_number: "GL", date: "2026-10-30" }];
  log = [];
  h.scope.mockReset().mockResolvedValue(undefined);
  h.businessDate.mockReset().mockResolvedValue("2026-10-30");
  h.cutover.mockReset().mockResolvedValue({ effectiveFrom: "2026-10-01", openingVoucherId: 9 });
  h.valuation.mockReset().mockResolvedValue(valuation());
  h.inTransit.mockReset().mockResolvedValue(new Decimal("25"));
  h.ledger.mockReset().mockResolvedValue(
    new Map([
      ["FACTORY_RAW_MATERIAL_STOCK", new Decimal("1180")],
      ["FACTORY_WIP", new Decimal("40")],
      ["FACTORY_FINISHED_GOODS", new Decimal("600")],
    ])
  );
  h.partner.mockReset().mockResolvedValue(false);
});

describe("factoryProductionAccountingAuditTx", () => {
  it("refuses an invalid company", async () => {
    for (const companyId of [0, -3, 2.5]) {
      await expect(factoryProductionAccountingAuditTx(tx, { companyId })).rejects.toThrow(
        "FACTORY_ACCOUNTING_INVALID_COMPANY"
      );
    }
    expect(h.scope).not.toHaveBeenCalled();
  });

  it("compares today's ledger with current Factory cost and reports a clean book", async () => {
    const out = await audit();
    expect(h.ledger).toHaveBeenCalledWith(
      tx,
      3,
      ["FACTORY_RAW_MATERIAL_STOCK", "FACTORY_WIP", "FACTORY_FINISHED_GOODS", "FACTORY_GOODS_IN_TRANSIT"],
      "2026-10-30"
    );
    expect(out).toMatchObject({
      companyId: 3,
      asOfDate: "2026-10-30",
      reportCurrency: "USD",
      postingReady: PERPETUAL_INVENTORY_POSTING_READY,
      cutover: { effectiveFrom: "2026-10-01", openingVoucherId: 9 },
      supplierPartner: false,
    });
    expect(out.valuation).toEqual({
      basis: "CURRENT_COSTING",
      asOfDate: "2026-10-30",
      rawUsd: "1180.00",
      wipUsd: "50.01",
      finishedUsd: "600.00",
      totalUsd: "1830.01",
      goodsInTransitUsd: "25.00",
      reservedForOpenOrders: { bales: 1, cost: "10.00" },
      soldNotInvoiced: { bales: 0, cost: "0.00" },
      unvalued: [],
      ledger: {
        FACTORY_RAW_MATERIAL_STOCK: { amount: "1180.00", difference: "0.00" },
        FACTORY_WIP: { amount: "40.00", difference: "-10.01" },
        FACTORY_FINISHED_GOODS: { amount: "600.00", difference: "0.00" },
        FACTORY_GOODS_IN_TRANSIT: { amount: "Not available", difference: null },
      },
      journal: { number: factoryStockJournalNumber(3, "2026-10-30"), id: 501, date: "2026-10-30" },
    });
    const journalQuery = log.find((q) => q.text.includes("FROM vouchers WHERE"));
    expect(journalQuery?.params).toEqual([3, factoryStockJournalNumber(3, "2026-10-30")]);

    expect(out.containers).toEqual([
      {
        id: 1,
        number: "FC-1",
        status: "RECEIVED",
        currency: "USD",
        rateConfirmed: true,
        receiptCount: 2,
        receiptKg: "990.00",
        receiptsUsd: "1980.01",
        rawReceivedKg: "990.00",
        rawUsedKg: "400.00",
        rawRemainingUsd: "1180.00",
        originalReceivedKg: "990",
        declaredKg: "1000",
        firstReceiptDate: "2026-10-01",
        lastReceiptDate: "2026-10-02",
        issues: [],
        severity: "clear",
      },
    ]);
    expect(out.invoices).toEqual([
      {
        orderId: 10,
        invoiceNumber: "INV-10",
        containerNumber: "FC-1",
        status: "FINALIZED",
        invoiceDate: "2026-10-20",
        grandTotal: "1000.00",
        customerId: 5,
        postedVoucherId: 77,
        postedVoucherDate: "2026-10-20",
        expectedReceivableNative: "900.00",
        postedReceivableNative: "900.00",
        postedReceivableUsd: "900.00",
        costOfBalesUsd: "600.00",
        postedCogsUsd: "600.00",
        postedFinishedGoodsCreditUsd: "600.00",
        bales: 12,
        issues: [],
        severity: "clear",
      },
    ]);
    expect(out.summary).toEqual({
      containers: 1,
      invoices: 1,
      unfinalized: 0,
      missingFinalizedInvoices: 0,
      prematureCustomerPostings: 0,
      unverifiedContainerCosts: 0,
      unvaluedStock: 0,
      critical: 0,
      review: 0,
      truncated: false,
    });
    expect(Object.keys(out.policy)).toHaveLength(9);
  });

  it("withholds the GL comparison for a past date, no cutover or a Supplier Partner company", async () => {
    journal = [];
    const past = await audit("2026-10-15");
    expect(h.ledger).not.toHaveBeenCalled();
    expect(past.valuation.basis).toBe("CURRENT_COSTING_NOT_HISTORICAL");
    expect(past.valuation.ledger.FACTORY_WIP).toEqual({ amount: "Not available", difference: null });
    expect(past.valuation.journal).toMatchObject({ id: null, date: null });
    expect(past.warnings[0]).toContain("NOT reconstructed as of the selected date");

    h.cutover.mockResolvedValueOnce(null);
    const noCutover = await audit();
    expect(noCutover.cutover).toBeNull();
    expect(noCutover.warnings).toContain(
      "Perpetual inventory cutover is not applied. Factory daily stock journal not required."
    );
    h.partner.mockResolvedValueOnce(true);
    const partner = await audit();
    expect(partner.supplierPartner).toBe(true);
    expect(partner.warnings).toContain(
      "Supplier Partner inventory is accounted for separately; Factory journal comparison is not applicable."
    );
    expect(h.ledger).not.toHaveBeenCalled();
    if (!PERPETUAL_INVENTORY_POSTING_READY) {
      expect(partner.warnings).toContain(
        "Perpetual inventory posting gate is disabled; no opening or daily journals were activated."
      );
    }
  });

  it("flags container cost evidence problems", async () => {
    containers = [
      container({ id: 1, currency: "zmw", rate_confirmed: false }),
      container({ id: 2, currency: "EUR", rate_confirmed: false, receipt_count: 0, raw_received_kg: "0" }),
      container({ id: 3, currency: "EUR", rate_confirmed: true }),
      container({ id: 4, raw_missing_rate: 1, missing_receipt_values: 2 }),
      container({ id: 5, receipt_count: 0, receipt_value_usd: null }),
      container({ id: 6, raw_received_kg: "0", raw_value_usd: null }),
      container({ id: 7, currency: "EUR", rate_confirmed: false, receipt_count: 0 }),
    ];
    const out = await audit();
    const byId = Object.fromEntries(out.containers.map((c) => [c.id, c]));
    expect(byId[1]).toMatchObject({
      currency: "ZMW",
      rateConfirmed: false,
      issues: ["Foreign container rate not confirmed"],
      severity: "critical",
    });
    expect(byId[2]).toMatchObject({ issues: [], severity: "clear", rateConfirmed: false });
    expect(byId[3]).toMatchObject({ issues: [], rateConfirmed: true });
    expect(byId[4]).toMatchObject({
      issues: ["Received raw stock lacks a confirmed USD cost", "A receipt has no recorded USD value"],
      severity: "critical",
      receiptsUsd: null,
      rawRemainingUsd: null,
    });
    expect(byId[5]).toMatchObject({
      issues: ["Raw stock exists but no live receipt events appear in this period"],
      severity: "review",
      receiptsUsd: null,
    });
    expect(byId[6]).toMatchObject({
      issues: ["Receipt evidence exists but the current raw-stock source is absent"],
      rawRemainingUsd: null,
    });
    expect(byId[7].issues).toEqual([
      "Foreign container rate not confirmed",
      "Raw stock exists but no live receipt events appear in this period",
    ]);
    expect(out.summary).toMatchObject({ unverifiedContainerCosts: 3, critical: 3, review: 2 });
    expect(out.warnings).toContain(
      "Some older containers have raw stock without a complete incremental receipt log. Manual review, no backfill."
    );

    // On a past date the receipt/raw-stock presence checks are not applied.
    const past = await audit("2026-10-15");
    const pastById = Object.fromEntries(past.containers.map((c) => [c.id, c]));
    expect(pastById[5].issues).toEqual([]);
    expect(pastById[6].issues).toEqual([]);
    expect(pastById[1].issues).toEqual(["Foreign container rate not confirmed"]);
  });

  it("flags premature postings on unfinalized orders", async () => {
    invoices = [
      invoice({ id: 1, status: "VERIFIED", premature_charge_vouchers: 1 }),
      invoice({ id: 2, status: "LOADING", journal_id: null, premature_charge_vouchers: 0 }),
    ];
    const out = await audit();
    expect(out.invoices[0]).toMatchObject({
      issues: [
        "Unfinalized order has an active customer invoice voucher",
        "Unfinalized order has posted customer charge voucher(s)",
      ],
      severity: "critical",
      expectedReceivableNative: null,
    });
    expect(out.invoices[1]).toMatchObject({ issues: [], severity: "clear", postedVoucherId: null });
    expect(out.summary).toMatchObject({ unfinalized: 2, prematureCustomerPostings: 1 });
    expect(out.warnings).toContain(
      "Unfinalized/verified/loading orders remain operational and do not create customer receivables."
    );
  });

  it("flags finalized invoices without postings, charge links, matching dates, cost or FX evidence", async () => {
    expect(
      await issuesOf({ journal_id: null, journal_date: null, posted_cogs: null, posted_finished_credit: null })
    ).toMatchObject({
      issues: ["Finalized invoice is missing a live accounting voucher"],
      severity: "critical",
      postedCogsUsd: null,
      postedFinishedGoodsCreditUsd: null,
    });
    // An empty zero-cost order needs no voucher.
    expect((await issuesOf({ journal_id: null, grand_total: "0", cost: "0" })).issues).toEqual([]);
    expect((await issuesOf({ journal_id: null, grand_total: "0", cost: "5" })).issues).toEqual([
      "Finalized invoice is missing a live accounting voucher",
    ]);

    expect((await issuesOf({ unverified_charges: 1 })).issues).toEqual([
      "Finalized charge voucher link is missing or inactive",
    ]);
    expect((await issuesOf({ journal_date: "2026-10-21" })).issues).toEqual([
      "Invoice journal date differs from finalization business date",
    ]);
    expect(await issuesOf({ unvalued_bales: 2 })).toMatchObject({
      issues: ["Finalized bales include unvalued material cost"],
      severity: "review",
    });
    for (const over of [{ posted_cogs: "600.02" }, { posted_finished_credit: "599.98" }]) {
      expect(await issuesOf(over)).toMatchObject({
        issues: ["COGS or Finished Goods credit differs from recorded bale cost"],
        severity: "critical",
      });
    }
    expect((await issuesOf({ posted_cogs: "600.01" })).issues).toEqual([]);
    expect(await issuesOf({ posted_receivable_native: null, posted_receivable_base: null })).toMatchObject({
      issues: ["Invoice customer receivable has no original currency evidence"],
      postedReceivableNative: null,
      postedReceivableUsd: null,
    });
    expect((await issuesOf({ posted_receivable_native: "899.98" })).issues).toEqual([
      "Invoice receivable differs from order less vouchered charges (verify native FX)",
    ]);
    // With an unverified charge the receivable comparison is not meaningful.
    expect((await issuesOf({ posted_receivable_native: "899.98", unverified_charges: 1 })).issues).toEqual([
      "Finalized charge voucher link is missing or inactive",
    ]);
  });

  it("skips cost checks for invoices before the cutover or without one", async () => {
    const early = { invoice_date: "2026-09-30", journal_date: "2026-09-30", unvalued_bales: 3, posted_cogs: "1" };
    expect((await issuesOf(early)).issues).toEqual([]);
    h.cutover.mockResolvedValueOnce(null);
    expect((await issuesOf({ unvalued_bales: 3, posted_cogs: "1" })).issues).toEqual([]);
  });

  it("only reports current state on a past date and flags truncation", async () => {
    invoices = [invoice({ status: "VERIFIED", journal_id: null })];
    const past = await audit("2026-10-15");
    expect(past.invoices[0].issues).toEqual([
      "Historical order status, postings and bale cost are not reconstructed; inspect current state only",
    ]);
    expect(past.invoices[0].severity).toBe("review");

    invoices = Array.from({ length: 201 }, (_, i) => invoice({ id: i + 1 }));
    expect((await audit()).summary.truncated).toBe(true);
    invoices = [];
    containers = Array.from({ length: 201 }, (_, i) => container({ id: i + 1 }));
    expect((await audit()).summary.truncated).toBe(true);
    containers = Array.from({ length: 200 }, (_, i) => container({ id: i + 1 }));
    expect((await audit()).summary.truncated).toBe(false);
    expect(log.filter((q) => q.text.includes("FROM factory_containers c")).at(-1)?.params).toEqual([
      "2026-10-30",
      3,
      201,
    ]);
  });

  it("counts unvalued stock sources", async () => {
    h.valuation.mockResolvedValueOnce(valuation([{ source: "bale", id: 1, reason: "no cost" }]));
    const out = await audit();
    expect(out.summary.unvaluedStock).toBe(1);
    expect(out.valuation.unvalued).toEqual([{ source: "bale", id: 1, reason: "no cost" }]);
  });
});
