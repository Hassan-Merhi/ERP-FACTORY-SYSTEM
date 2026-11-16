/**
 * Golden Coast Phase 16 — payable / equity separation.
 *
 * The Phase 16 cleanup exists because a payable was once at risk of being
 * converted into equity. The two must stay distinct in both directions:
 *
 *   * what Golden Coast OWES (GC Sales Cash, Hassan Savings) is a liability and
 *     is settled with cash, never absorbed into a partner's capital, and
 *   * what the partners OWN (Fresh Start / Hassan equity, Profit Pending
 *     Distribution) moves only through capital contributions, drawings and the
 *     monthly profit close.
 *
 * These are structural assertions over the canonical role table and the real
 * posting builders, so a future "conversion" that blurred the two would fail
 * here rather than silently reclassifying a debt as ownership.
 */
import { describe, expect, it } from "vitest";
import {
  GOLDEN_COAST_PHASE2_ACCOUNT_DEFS,
  getGoldenCoastAccountDefinition,
  planGoldenCoastAccountProvisioning,
  type GoldenCoastAccountRole,
  type GoldenCoastLedgerRow,
} from "./goldenCoastAccounts";
import {
  buildGoldenCoastPhase11MonthlyClosePosting,
  planGoldenCoastPhase11MonthlyClose,
} from "./goldenCoastMonthlyClose";

/** Roles that record what Golden Coast owes someone else. */
const OBLIGATION_ROLES: readonly GoldenCoastAccountRole[] = ["gc_sales_cash", "hassan_savings"];

/** Roles that record what the partners own. */
const OWNERSHIP_ROLES: readonly GoldenCoastAccountRole[] = [
  "fresh_start_equity",
  "hassan_equity",
  "profit_pending_distribution",
];

const OBLIGATION_TYPES = ["Liability", "Accounts Payable", "Loans"];
const OWNERSHIP_TYPES = ["Equity", "Profit"];

describe("obligation roles stay liabilities", () => {
  it.each(OBLIGATION_ROLES)("%s is a liability and never accepts an equity type", (role) => {
    const definition = getGoldenCoastAccountDefinition(role);
    expect(OBLIGATION_TYPES).toContain(definition.accountType);
    for (const accepted of definition.acceptedAccountTypes) {
      expect(OWNERSHIP_TYPES).not.toContain(accepted);
      expect(OBLIGATION_TYPES).toContain(accepted);
    }
  });

  it("carries no ownership share or opening equity target on an obligation role", () => {
    // A payable that grew a partner share would be equity wearing a debt label.
    for (const role of OBLIGATION_ROLES) {
      const definition = getGoldenCoastAccountDefinition(role);
      expect(definition.ownershipSharePct).toBeUndefined();
      expect(definition.openingBalanceTargetUsd).toBeUndefined();
    }
  });

  it("repairs a payable that was reclassified as equity back to a liability", () => {
    const definition = getGoldenCoastAccountDefinition("gc_sales_cash");
    const accounts: GoldenCoastLedgerRow[] = [
      {
        id: 1,
        companyId: 7,
        code: definition.code,
        name: definition.name,
        // The exact conversion Phase 16 has to undo.
        accountType: "Equity",
        subType: definition.subType,
        isHidden: false,
        active: true,
        deletedAt: null,
      },
    ];

    const plan = planGoldenCoastAccountProvisioning({ companyId: 7, accounts });
    const item = plan.items.find((candidate) => candidate.role === "gc_sales_cash")!;

    expect(item.action).toBe("repair");
    expect(item.repairs).toContainEqual(
      expect.objectContaining({ field: "accountType", from: "Equity", to: "Liability" })
    );
    // Repair-only: the account keeps its identity, so posted history still points at it.
    expect(item.accountId).toBe(1);
  });
});

describe("ownership roles stay equity", () => {
  it.each(OWNERSHIP_ROLES)("%s is equity and never accepts a liability type", (role) => {
    const definition = getGoldenCoastAccountDefinition(role);
    expect(OWNERSHIP_TYPES).toContain(definition.accountType);
    for (const accepted of definition.acceptedAccountTypes) {
      expect(OBLIGATION_TYPES).not.toContain(accepted);
    }
  });

  it("repairs an equity account that was reclassified as a liability", () => {
    const definition = getGoldenCoastAccountDefinition("fresh_start_equity");
    const plan = planGoldenCoastAccountProvisioning({
      companyId: 7,
      accounts: [
        {
          id: 2,
          companyId: 7,
          code: definition.code,
          name: definition.name,
          accountType: "Liability",
          subType: definition.subType,
          isHidden: false,
          active: true,
          deletedAt: null,
        },
      ],
    });
    const item = plan.items.find((candidate) => candidate.role === "fresh_start_equity")!;

    expect(item.repairs).toContainEqual(
      expect.objectContaining({ field: "accountType", from: "Liability", to: "Equity" })
    );
  });

  it("keeps every role's sub type unique so no account can hold both meanings", () => {
    const subTypes = GOLDEN_COAST_PHASE2_ACCOUNT_DEFS.map((definition) => definition.subType);
    expect(new Set(subTypes).size).toBe(subTypes.length);
  });
});

describe("the monthly close moves profit into equity without touching the payable", () => {
  const ACCOUNTS = {
    salesAccountId: 501,
    cogsAccountId: 502,
    sharedChargesAccountId: 503,
    profitPendingDistributionAccountId: 504,
    freshStartEquityAccountId: 505,
    hassanEquityAccountId: 506,
  };
  const GC_SALES_CASH = 104;
  const HASSAN_SAVINGS = 103;

  function closePosting(revenue: string, cogs: string, shared: string) {
    const plan = planGoldenCoastPhase11MonthlyClose({
      close: { companyId: 7, periodMonth: "2026-09", clientRequestId: "p16-close", reference: null },
      totalRevenueUsd: revenue,
      totalCogsUsd: cogs,
      totalSharedChargesUsd: shared,
    });
    return { plan, posting: buildGoldenCoastPhase11MonthlyClosePosting({ plan, accounts: ACCOUNTS, digest: "p16" }) };
  }

  it("splits a profit 50/50 into the two equity accounts only", () => {
    const { plan, posting } = closePosting("1000.00", "400.00", "100.00");
    expect(plan.netProfitLossUsd).toBe("500.00");

    const touched = new Set(posting.entries.map((entry) => Number(entry.ledgerAccountId)));
    // The obligation accounts are absent: profit is never settled against a debt.
    expect(touched.has(GC_SALES_CASH)).toBe(false);
    expect(touched.has(HASSAN_SAVINGS)).toBe(false);

    const credited = (accountId: number) =>
      posting.entries
        .filter((entry) => Number(entry.ledgerAccountId) === accountId)
        .reduce((sum, entry) => sum + Number(entry.creditAmount || 0) - Number(entry.debitAmount || 0), 0);
    expect(credited(ACCOUNTS.freshStartEquityAccountId)).toBe(250);
    expect(credited(ACCOUNTS.hassanEquityAccountId)).toBe(250);
    // The clearing account returns to zero: it is a conduit, not a store of value.
    expect(credited(ACCOUNTS.profitPendingDistributionAccountId)).toBe(0);
  });

  it("charges a loss to equity rather than to any payable", () => {
    const { plan, posting } = closePosting("400.00", "900.00", "100.00");
    expect(plan.netProfitLossUsd).toBe("-600.00");

    const touched = new Set(posting.entries.map((entry) => Number(entry.ledgerAccountId)));
    expect(touched.has(GC_SALES_CASH)).toBe(false);
    expect(touched.has(HASSAN_SAVINGS)).toBe(false);

    const debited = (accountId: number) =>
      posting.entries
        .filter((entry) => Number(entry.ledgerAccountId) === accountId)
        .reduce((sum, entry) => sum + Number(entry.debitAmount || 0) - Number(entry.creditAmount || 0), 0);
    expect(debited(ACCOUNTS.freshStartEquityAccountId)).toBe(300);
    expect(debited(ACCOUNTS.hassanEquityAccountId)).toBe(300);
  });

  it("balances the close journal", () => {
    const { posting } = closePosting("1000.00", "400.00", "100.00");
    const debits = posting.entries.reduce((sum, entry) => sum + Number(entry.debitAmount || 0), 0);
    const credits = posting.entries.reduce((sum, entry) => sum + Number(entry.creditAmount || 0), 0);
    expect(debits).toBeCloseTo(credits, 6);
  });
});
