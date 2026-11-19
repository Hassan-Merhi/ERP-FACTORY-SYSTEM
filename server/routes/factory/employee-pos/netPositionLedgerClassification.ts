// Extracted from ./employeeNetPositionRoutes.ts: ledger classification and customer balances for the Factory Net Position.
import { isExcludedFromCompany12ManagementReports } from "../../../lib/payrollOverpaymentReporting";
import {
  classifyNetPositionAccounts,
  PERPETUAL_STOCK_ACCOUNT_CODES,
  type AccountLike,
} from "../../../netPositionHelper";
import { getCustomerLedgerAndMemo } from "../customers-core/customerLedgerSplit";
import { MoneyDecimal } from "../../../lib/money";
import type { loadNetPositionLedgerBalances } from "./netPositionLedgerBalances";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";

type LoadNetPositionLedgerBalancesResult = Awaited<ReturnType<typeof loadNetPositionLedgerBalances>>;

export async function classifyFactoryNetPositionLedger({
  factoryAccounts,
  companyId,
  projectedAccountBalances,
  ledgerStock,
  factoryExcludedCodes,
  allCustomersForNP,
  round2,
  asOf,
  asOfContext,
}: {
  factoryAccounts: LoadNetPositionLedgerBalancesResult["factoryAccounts"];
  companyId: number;
  projectedAccountBalances: LoadNetPositionLedgerBalancesResult["projectedAccountBalances"];
  ledgerStock: LoadNetPositionLedgerBalancesResult["ledgerStock"];
  factoryExcludedCodes: LoadNetPositionLedgerBalancesResult["factoryExcludedCodes"];
  allCustomersForNP: LoadNetPositionLedgerBalancesResult["allCustomersForNP"];
  round2: (n: number) => number;
  asOf: string;
  asOfContext: FactoryNetPositionAsOf;
}) {
  const classified = classifyNetPositionAccounts(
    factoryAccounts.filter((account) => !isExcludedFromCompany12ManagementReports(companyId, account)) as AccountLike[],
    projectedAccountBalances,
    {
      ledgerStockAccounts: ledgerStock,
      additionalExcludedCodes: factoryExcludedCodes,
      // Supplier-type ledger accounts are independently calculated.
      includeSupplierTypeAccounts: false,
    }
  );

  // Build a set of ledger account IDs owned by customers so we can strip them
  // from the ledger classification output (prevents double-counting).
  const customerLedgerIds = new Set<number>(
    allCustomersForNP.filter((c) => c.ledgerAccountId).map((c) => c.ledgerAccountId as number)
  );

  // Strip customer-linked accounts from the classifier output.
  const ledgerForUs = classified.forUsAccounts.filter((a) => a.id === undefined || !customerLedgerIds.has(a.id));
  const ledgerOnUsRaw = classified.onUsAccounts.filter((a) => a.id === undefined || !customerLedgerIds.has(a.id));

  // ── Strip any ledger-based "Payroll Payable" accounts ─────────────────────
  // The authoritative source for payroll payable is employees.currentBalance
  // (tracked directly via employeeId on voucher entries, not via a ledger account).
  // Any ledger account named/coded as "Payroll Payable" duplicates that and
  // must be excluded here — the single correct figure is injected below.
  const ledgerOnUs = ledgerOnUsRaw.filter((a) => {
    // Stock credit balances are inventory contra-assets, not separate supplier debts.
    if (PERPETUAL_STOCK_ACCOUNT_CODES.has((a.code || "").trim().toUpperCase())) return false;
    const nameLower = (a.name || "").toLowerCase();
    const code = (a.code || "").toUpperCase();
    const isPayrollPayable =
      nameLower.includes("payroll payable") || code === "PAYROLL_PAYABLE" || code === "PAY_PAYABLE";
    // Exclude ledger-based rent payable — the computed rentPayable (expected − paid
    // up to asOf) is always more accurate than the accrual-scheduler-dependent ledger account.
    const isAccruedRentPayable =
      nameLower.includes("accrued rent") || code === "ACCR-RENT-PAY" || code === "ACCRUED_RENT_PAYABLE";
    // Also exclude the "Factory Worker Advances" ledger account on the liability side —
    // its balance drifts from reality (advance repayments/deductions aren't always posted
    // back to it), and the asset side already strips it in favor of the authoritative
    // factory_worker_advances table sum injected below. Without this, a stray credit
    // balance on that ledger account leaks through here as a bogus liability line.
    const isFactoryWorkerAdvances = nameLower.replace(/\s+/g, " ").trim() === "factory worker advances";
    // Exclude per-worker insurance liability accounts (e.g. "Insurance - أحمد علي رمضان").
    // These are tracked and displayed separately via the Insurance section, not here.
    const isInsuranceMember = /^insurance\s*[-–]/i.test(a.name || "");
    return !isPayrollPayable && !isAccruedRentPayable && !isFactoryWorkerAdvances && !isInsuranceMember;
  });
  const ledgerOnUsTotal = round2(ledgerOnUs.reduce((s: number, a) => s + a.value, 0));

  const customerItems: { customerId: number; name: string; balanceUsd: number; ledgerAccountId?: number }[] = [];

  if (allCustomersForNP.length > 0) {
    // Match the Parties page's combined ledger + operational balance exactly.
    const figures = await getCustomerLedgerAndMemo(
      companyId,
      allCustomersForNP.map((c) => c.id),
      asOf,
      asOfContext.isHistorical ? asOfContext : undefined
    );
    for (const c of allCustomersForNP) {
      const f = figures.get(c.id);
      const balance = (f?.ledger ?? new MoneyDecimal(0)).plus(f?.memoTotal ?? 0);
      if (balance.abs().gte(0.01))
        customerItems.push({
          customerId: c.id,
          name: c.legalName || `Customer #${c.id}`,
          balanceUsd: round2(balance.toNumber()),
          ledgerAccountId: c.ledgerAccountId || undefined,
        });
    }
  }

  return { ledgerForUs, ledgerOnUs, ledgerOnUsTotal, customerItems };
}
