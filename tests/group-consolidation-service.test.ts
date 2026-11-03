/**
 * The provisional group consolidation workpaper: input validation, row
 * classification, statement totals, and which intercompany pairs become
 * read-only elimination entries and why the others are refused. The
 * per-company balance, link and FX readiness reads are stubbed; the group pair
 * matcher and the account classification are the real ones.
 */
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BalanceRow } from "../server/services/accounting/balances/ledgerBalanceEngine";

const h = vi.hoisted(() => ({
  companies: [] as Array<Record<string, unknown>>,
  balances: new Map<number, unknown[]>(),
  period: new Map<number, unknown[]>(),
  links: new Map<number, unknown[]>(),
  ready: new Map<number, boolean>(),
  scopes: [] as number[],
}));

vi.mock("../server/storage", () => ({ storage: { getAllCompanies: async () => h.companies } }));
vi.mock("../server/services/accounting/historicalCurrencyReadiness", () => ({
  getHistoricalCurrencyReadiness: async (companyId: number) => ({
    ready: h.ready.get(companyId) ?? true,
    unresolvedEntryCount: 1,
    unresolvedLedgerOpeningCount: 2,
    unresolvedBankOpeningCount: 0,
    unresolvedCustomerOpeningCount: 0,
    unresolvedSupplierOpeningCount: 0,
    unresolvedEmployeeOpeningCount: 0,
    unresolvedFixedAssetCount: 4,
  }),
}));
vi.mock("../server/services/accounting/balances/ledgerBalanceEngine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/accounting/balances/ledgerBalanceEngine")>()),
  loadBalanceRows: async (_db: unknown, input: { companyId: number; excludeFiscalClose?: boolean }) =>
    (input.excludeFiscalClose ? h.period : h.balances).get(input.companyId) ?? [],
}));
vi.mock("../server/helpers/groupIntercompany", () => ({
  loadCompanyIntercompanyAccounts: async (company: { id: number }) => h.links.get(company.id) ?? [],
}));
vi.mock("../server/helpers/groupNetPosition", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/helpers/groupNetPosition")>()),
  runWithGroupCompanyScope: async (companyId: number, _allowed: unknown, run: () => Promise<unknown>) => {
    h.scopes.push(companyId);
    return run();
  },
}));

import { consolidatedAccountingReport } from "../server/services/accounting/groupConsolidationService";

const company = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  name: `Co ${id}`,
  code: `C${id}`,
  companyType: "trading",
  baseCurrency: "USD",
  parentCompanyId: null,
  ...over,
});

function row(over: Partial<BalanceRow> & { closing?: number; debit?: number; credit?: number }): BalanceRow {
  const { closing = 0, debit = 0, credit = 0, ...rest } = over;
  return {
    kind: "ledger",
    id: 1,
    code: null,
    name: "Account",
    accountType: "Asset",
    deleted: false,
    linkedLedgerAccountId: null,
    masterOpening: new Decimal(0),
    openingSideAssumed: false,
    carriedForward: new Decimal(0),
    periodDebit: new Decimal(debit),
    periodCredit: new Decimal(credit),
    baseMovement: new Decimal(closing),
    ...rest,
  };
}

const link = (companyId: number, accountId: number, balance: string, counterparties: number[]) => ({
  companyId,
  accountId,
  accountName: `IC ${companyId}/${accountId}`,
  counterpartyCompanyIds: counterparties,
  sources: [],
  balance,
});

const run = (ids: number[], over: Partial<Parameters<typeof consolidatedAccountingReport>[0]> = {}) =>
  consolidatedAccountingReport({
    asOfDate: "2026-09-30",
    fromDate: "2026-01-01",
    selectedCompanyIds: ids,
    allowedCompanyIds: new Set([1, 2, 3, 4]),
    ...over,
  });

beforeEach(() => {
  h.companies = [company(1), company(2), company(3), company(4, { baseCurrency: " zmw " })];
  h.balances = new Map();
  h.period = new Map();
  h.links = new Map();
  h.ready = new Map();
  h.scopes = [];
});

describe("consolidatedAccountingReport input", () => {
  it("rejects a malformed or reversed period", async () => {
    const message = "Consolidation period must contain two valid dates, fromDate <= asOfDate";
    await expect(run([1], { asOfDate: "2026-9-30" })).rejects.toThrow(message);
    await expect(run([1], { fromDate: "2026-02-30" })).rejects.toThrow(message);
    await expect(run([1], { fromDate: "2026-10-01" })).rejects.toThrow(message);
  });

  it("needs 1 to 50 authorised companies, each readable and USD functional", async () => {
    const message = "Select between 1 and 50 companies that you are authorized to view";
    await expect(run([])).rejects.toThrow(message);
    const many = Array.from({ length: 51 }, (_, i) => i + 1);
    await expect(run(many, { allowedCompanyIds: new Set(many) })).rejects.toThrow(message);
    await expect(run([1, 0])).rejects.toThrow(message);
    await expect(run([1.5])).rejects.toThrow(message);
    await expect(run([5])).rejects.toThrow(message);
    await expect(run([3], { allowedCompanyIds: new Set([3]) })).resolves.toBeTruthy();
    h.companies = [company(1)];
    await expect(run([1, 2])).rejects.toThrow("One selected company is not accessible");
    h.companies = [company(1), company(4, { baseCurrency: " zmw " })];
    await expect(run([1, 4])).rejects.toThrow(
      "Cannot consolidate Co 4: USD functional currency required; translated group base not certified"
    );
    h.companies = [company(1, { baseCurrency: null })];
    await expect(run([1, 1])).resolves.toMatchObject({ companies: [{ companyId: 1, baseCurrency: "USD" }] });
    expect(h.scopes).toEqual([3, 1]);
  });
});

describe("consolidatedAccountingReport rows and totals", () => {
  it("classifies each balance row and totals the statements from booked USD", async () => {
    h.balances.set(1, [
      row({ kind: "bank", id: 10, name: "Bank", closing: 500 }),
      row({ kind: "bank", id: 11, name: "Overdraft", closing: -40 }),
      row({ kind: "customer", id: 12, name: "Debtor", closing: 30 }),
      row({ kind: "supplier", id: 13, name: "Creditor", closing: -70, openingSideAssumed: true }),
      row({ id: 14, name: "Loan", accountType: "Loan", closing: -200 }),
      row({ id: 15, name: "Refund due", accountType: "Liability", closing: 5 }),
      row({ id: 16, name: "Capital", accountType: "Equity", closing: -100 }),
      row({ id: 17, name: "Sales", accountType: "Income", closing: -300 }),
      row({ id: 18, name: "Purchases", accountType: "COGS", closing: 150 }),
      row({ id: 19, name: "Rent", accountType: "Expense", closing: 25 }),
      row({ kind: "missingAccount", id: null, name: "Missing", closing: 0.004 }),
      row({ id: 23, name: "Due to sister", accountType: "Intercompany", closing: -15 }),
      row({ id: 24, name: "Due from sister", accountType: "Intercompany", closing: 15 }),
    ]);
    h.period.set(1, [row({ id: 17, debit: 10, credit: 290 }), row({ id: 18, debit: 150 }), row({ id: 19, debit: 25 })]);
    const report = await run([1]);
    const classes = Object.fromEntries(
      report.rows.map((r) => [r.name, [r.financialClass, r.bookedUsd, r.periodMovementUsd]])
    );
    expect(classes).toEqual({
      Bank: ["asset", "500.00", "0.00"],
      Overdraft: ["asset", "-40.00", "0.00"],
      Debtor: ["asset", "30.00", "0.00"],
      Creditor: ["liability", "-70.00", "0.00"],
      Loan: ["liability", "-200.00", "0.00"],
      "Refund due": ["liability", "5.00", "0.00"],
      Capital: ["equity", "-100.00", "0.00"],
      Sales: ["income", "-300.00", "-280.00"],
      Purchases: ["cost_of_sales", "150.00", "150.00"],
      Rent: ["expense", "25.00", "25.00"],
      Missing: ["unknown", "0.00", "0.00"],
      "Due to sister": ["liability", "-15.00", "0.00"],
      "Due from sister": ["asset", "15.00", "0.00"],
    });
    expect(report.rows.find((r) => r.name === "Creditor")?.openingSideAssumed).toBe(true);
    expect(report.totals).toMatchObject({
      grossDebitUsd: "725.00",
      grossCreditUsd: "725.00",
      grossUnbalancedUsd: "0.00",
      eliminationDebitUsd: "0.00",
      adjustedUnbalancedUsd: "0.00",
      assetsUsd: "550.00",
      liabilitiesUsd: "325.00",
      equityUsd: "100.00",
      periodIncomeUsd: "280.00",
      periodCostOfSalesUsd: "150.00",
      periodOperatingExpensesUsd: "25.00",
      periodResultBeforeInternalSalesEliminationUsd: "105.00",
      unmatchedIntercompanyUsd: "0.00",
    });
    expect(report.companies).toEqual([
      {
        companyId: 1,
        companyName: "Co 1",
        companyCode: "C1",
        companyType: "trading",
        baseCurrency: "USD",
        parentCompanyId: null,
        balances: 13,
        historicalFxReady: true,
        unresolvedCurrencyCount: 7,
      },
    ]);
    // The near-zero missing row is not an unknown balance; the books balance.
    expect(report.certification).toMatchObject({
      historicalFxResolved: true,
      unknownBalanceRows: 0,
      unpairedOrMismatchedPairs: 0,
      bookBalanced: true,
      certified: false,
    });
    expect(report.certification.blockers).toHaveLength(2);
    expect(report).toMatchObject({
      mode: "PROVISIONAL_LEDGER_CONSOLIDATION",
      currency: "USD",
      eliminations: [],
      pairs: [],
    });
  });

  it("lists every certification blocker", async () => {
    h.ready.set(2, false);
    h.balances.set(1, [
      row({ kind: "unassigned", id: null, name: "Suspense", closing: 12.5 }),
      row({ id: 20, name: "IC receivable", accountType: "Intercompany", closing: 80 }),
    ]);
    h.balances.set(2, [row({ id: 30, name: "IC payable", accountType: "Intercompany", closing: -50 })]);
    h.links.set(1, [link(1, 20, "80", [2])]);
    h.links.set(2, [link(2, 30, "-50", [1])]);
    const report = await run([1, 2]);
    expect(report.certification).toMatchObject({
      historicalFxResolved: false,
      unknownBalanceRows: 1,
      unknownAmountUsd: "12.50",
      unpairedOrMismatchedPairs: 1,
      blockedEliminationPairs: 0,
      bookBalanced: false,
    });
    expect(report.certification.blockers.slice(0, 4)).toEqual([
      "Unresolved historical currency columns or openings in one or more companies",
      "Unattributed/unknown-class trial-balance lines remain",
      "Unpaired or mismatched intercompany balances remain visible",
      "Gross trial balance does not reconcile to zero",
    ]);
    expect(report.totals).toMatchObject({ unmatchedIntercompanyUsd: "30.00", grossUnbalancedUsd: "42.50" });
    // The 50 both sides agree on is still eliminated; the 30 residual stays visible.
    expect(report.pairs).toEqual([
      {
        companyIds: [1, 2],
        companyNames: ["Co 1", "Co 2"],
        status: "mismatched",
        receivables: "80.00",
        payables: "50.00",
        matchedUsd: "50.00",
        differenceUsd: "30.00",
        appliedUsd: "50.00",
        reason: null,
      },
    ]);
  });
});

describe("consolidatedAccountingReport eliminations", () => {
  it("offsets a matched receivable and payable through presentation-only entries", async () => {
    h.balances.set(1, [
      row({ id: 20, name: "Due from Co 2", accountType: "Intercompany", closing: 60 }),
      row({ id: 21, name: "Due from Co 2 (old)", accountType: "Intercompany", closing: 40 }),
      row({ kind: "bank", id: 22, name: "Bank", closing: -100 }),
      // A bank record that happens to share a ledger account's id is not adjusted.
      row({ kind: "bank", id: 20, name: "Petty cash", closing: 0 }),
    ]);
    h.balances.set(2, [
      row({ id: 30, name: "Due to Co 1", accountType: "Intercompany", closing: -100 }),
      row({ kind: "bank", id: 31, name: "Bank", closing: 100 }),
    ]);
    h.links.set(1, [link(1, 21, "40", [2]), link(1, 20, "60", [2])]);
    h.links.set(2, [link(2, 30, "-100", [1])]);
    const report = await run([2, 1]);
    expect(report.eliminations).toEqual([
      {
        pairCompanyIds: [1, 2],
        debitCompanyId: 2,
        debitAccountId: 30,
        creditCompanyId: 1,
        creditAccountId: 20,
        amountUsd: "60.00",
        narrative: "Consolidation-only: Dr intercompany payable 2/30, Cr intercompany receivable 1/20",
        kind: "intercompany_balance",
        posted: false,
      },
      expect.objectContaining({ debitAccountId: 30, creditAccountId: 21, amountUsd: "40.00" }),
    ]);
    const adjusted = Object.fromEntries(
      report.rows.map((r) => [
        `${r.companyId}/${r.accountId}${r.accountKind === "ledger" ? "" : ` ${r.name}`}`,
        [r.eliminationUsd, r.adjustedUsd],
      ])
    );
    expect(adjusted).toEqual({
      "1/20": ["-60.00", "0.00"],
      "1/21": ["-40.00", "0.00"],
      "1/22 Bank": ["0.00", "-100.00"],
      "1/20 Petty cash": ["0.00", "0.00"],
      "2/30": ["100.00", "0.00"],
      "2/31 Bank": ["0.00", "100.00"],
    });
    expect(report.totals).toMatchObject({
      grossDebitUsd: "200.00",
      eliminationDebitUsd: "100.00",
      eliminationCreditUsd: "100.00",
      adjustedDebitUsd: "100.00",
      adjustedCreditUsd: "100.00",
      adjustedUnbalancedUsd: "0.00",
    });
    expect(report.pairs[0]).toMatchObject({
      status: "matched",
      matchedUsd: "100.00",
      appliedUsd: "100.00",
      reason: null,
    });
    expect(report.certification.blockedEliminationPairs).toBe(0);
    expect(report.companies.map((c) => c.companyId)).toEqual([2, 1]);
  });

  it("refuses pairs it cannot attribute to distinct ledger sides", async () => {
    // Co 1 ↔ Co 2: Co 1's linked account has no ledger row (only a bank record shares its id).
    h.balances.set(1, [
      row({ id: 20, name: "IC", accountType: "Intercompany", closing: 10 }),
      row({ kind: "bank", id: 99, name: "Bank", closing: 10 }),
    ]);
    h.balances.set(2, [row({ id: 30, name: "IC", accountType: "Intercompany", closing: -10 })]);
    h.links.set(1, [link(1, 99, "10", [2])]);
    h.links.set(2, [link(2, 30, "-10", [1])]);
    let report = await run([1, 2]);
    expect(report.pairs[0]).toMatchObject({
      matchedUsd: "10.00",
      appliedUsd: "0.00",
      reason: "Paired account is not a resolvable ledger financial row",
    });
    expect(report.eliminations).toEqual([]);
    expect(report.certification.blockedEliminationPairs).toBe(1);
    expect(report.certification.blockers).toContain(
      "Some intercompany matches cannot be safely attributed to their GL account sides"
    );

    // The row exists but its account type is unclassifiable.
    h.balances.set(1, [row({ id: 20, name: "IC", accountType: null, closing: 10 })]);
    h.links.set(1, [link(1, 20, "10", [2])]);
    report = await run([1, 2]);
    expect(report.pairs[0].reason).toBe("Paired account is not a resolvable ledger financial row");

    // The link's balance disagrees with the canonical trial balance.
    h.balances.set(1, [row({ id: 20, name: "IC", accountType: "Intercompany", closing: 10.02 })]);
    report = await run([1, 2]);
    expect(report.pairs[0].reason).toBe("Group linked-account balance disagrees with the canonical trial balance");
    h.balances.set(1, [row({ id: 20, name: "IC", accountType: "Intercompany", closing: 10.01 })]);
    report = await run([1, 2]);
    expect(report.pairs[0].reason).toBeNull();

    // One company holds both a receivable and a payable with the other.
    h.balances.set(1, [
      row({ id: 20, name: "IC rec", accountType: "Intercompany", closing: 30 }),
      row({ id: 21, name: "IC pay", accountType: "Intercompany", closing: -5 }),
    ]);
    h.links.set(1, [link(1, 20, "30", [2]), link(1, 21, "-5", [2])]);
    h.balances.set(2, [row({ id: 30, name: "IC", accountType: "Intercompany", closing: -25 })]);
    h.links.set(2, [link(2, 30, "-25", [1])]);
    report = await run([1, 2]);
    expect(report.pairs[0]).toMatchObject({
      reason: "Mixed receivable and payable sides within one company require document-level attribution",
      appliedUsd: "0.00",
    });
    expect(report.rows.every((r) => r.eliminationUsd === "0.00")).toBe(true);
  });

  it("explains pairs with nothing to eliminate and accounts linked to several companies", async () => {
    h.balances.set(1, [
      row({ id: 20, name: "IC 2", accountType: "Intercompany", closing: 10 }),
      row({ id: 21, name: "IC 2+3", accountType: "Intercompany", closing: 4 }),
      row({ id: 22, name: "IC none", accountType: "Intercompany", closing: 0 }),
    ]);
    h.balances.set(2, [row({ id: 30, name: "IC 1", accountType: "Intercompany", closing: 6 })]);
    h.balances.set(3, [
      row({ id: 40, name: "IC 1 settled", accountType: "Intercompany", closing: 0 }),
      row({ id: 41, name: "IC outside", accountType: "Intercompany", closing: 3 }),
    ]);
    h.links.set(1, [link(1, 20, "10", [2]), link(1, 21, "4", [2, 3]), link(1, 22, "0", [])]);
    h.links.set(2, [link(2, 30, "6", [1])]);
    h.links.set(3, [link(3, 40, "0", [1]), link(3, 41, "3", [9])]);
    const report = await run([1, 2, 3]);
    const byKey = Object.fromEntries(report.pairs.map((p) => [`${p.companyIds.join(":")}:${p.status}`, p.reason]));
    expect(byKey).toEqual({
      "1:2:mismatched": "No opposite-side receivable/payable amount to eliminate",
      "1:2:3:mismatched": "Unpaired or multi-company account relationships cannot be safely journal-matched",
      "1:3:matched": null,
      "1:unpaired": "Unpaired or multi-company account relationships cannot be safely journal-matched",
      "3:unpaired": "Unpaired or multi-company account relationships cannot be safely journal-matched",
    });
    // None of them had a matched amount, so none counts as a blocked elimination.
    expect(report.certification.blockedEliminationPairs).toBe(0);
    expect(report.certification.unpairedOrMismatchedPairs).toBe(4);
    expect(report.totals.unmatchedIntercompanyUsd).toBe("23.00");
  });
});
