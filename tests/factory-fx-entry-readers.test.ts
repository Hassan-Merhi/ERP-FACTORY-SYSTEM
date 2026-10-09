/**
 * Factory foreign-currency entries (2026-10 accounting audit, wave 6): readers.
 *
 * A normalized voucher entry holds its USD base in debit_amount and its native
 * amount in transaction_*; a legacy one holds the native amount in debit_amount.
 * The factory supplier readers converted debit_amount on every row, so a
 * normalized (e.g. CFA) payment was converted a second time. They now read the
 * stored base of a normalized entry and convert only a legacy one, unchanged.
 */
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ queue: [] as unknown[] }));

vi.mock("../server/auth", () => ({ requireAuth: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../server/db", () => {
  const query = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["from", "where", "innerJoin", "orderBy", "limit"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return { db: { select: () => query(harness.queue.shift() ?? []) } };
});

// The ledger balance comes from the balance engine (wave 13); these tests read
// the operational memo, which is where the voucher payment conversion lives.
vi.mock("../server/routes/factory/suppliers/balance/factorySupplierLedger", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/routes/factory/suppliers/balance/factorySupplierLedger")>();
  return { ...actual, loadFactorySupplierLedgerViews: async () => new Map() };
});

import { registerSupplierBalanceSingleRoutes } from "../server/routes/factory/suppliers/balance/single";
import {
  entryNativeAmounts,
  entryStoredUsdAmounts,
  isNormalizedEntry,
} from "../server/services/factory/voucherEntryCurrency";

const legacyEur = {
  debitAmount: "1000.00",
  creditAmount: "0.00",
  currency: "EUR",
  transactionCurrency: null,
  transactionDebitAmount: null,
  transactionCreditAmount: null,
  baseDebitAmount: null,
  baseCreditAmount: null,
};
// A CFA payment as the voucher-entry trigger stores it: 655,957 CFA at 655.957 per USD.
const normalizedCfa = {
  debitAmount: "1000.00",
  creditAmount: "0.00",
  currency: "CFA",
  transactionCurrency: "CFA",
  transactionDebitAmount: "655957.000000",
  transactionCreditAmount: "0.000000",
  baseDebitAmount: "1000.000000",
  baseCreditAmount: "0.000000",
};

describe("voucher entry currency helpers", () => {
  it("reads a legacy entry's native amount from debit_amount and has no stored USD", () => {
    expect(isNormalizedEntry(legacyEur)).toBe(false);
    expect(entryNativeAmounts(legacyEur)).toMatchObject({ currency: "EUR" });
    expect(entryNativeAmounts(legacyEur).debit.toFixed(2)).toBe("1000.00");
    expect(entryStoredUsdAmounts(legacyEur)).toBeNull();
  });

  it("reads a normalized entry's native amount from transaction_* and its USD from the base", () => {
    expect(isNormalizedEntry(normalizedCfa)).toBe(true);
    expect(entryNativeAmounts(normalizedCfa).currency).toBe("CFA");
    expect(entryNativeAmounts(normalizedCfa).debit.toFixed(0)).toBe("655957");
    expect(entryStoredUsdAmounts(normalizedCfa)?.debit.toFixed(2)).toBe("1000.00");
  });

  it("treats a legacy USD entry's debit_amount as USD", () => {
    expect(entryStoredUsdAmounts({ ...legacyEur, currency: "USD" })?.debit.toFixed(2)).toBe("1000.00");
  });
});

function balanceHandler() {
  let handler: ((req: unknown, res: unknown) => Promise<unknown>) | undefined;
  registerSupplierBalanceSingleRoutes({
    get: (path: string, ...handlers: never[]) => {
      if (path === "/api/factory/suppliers/:id/balance") handler = handlers.at(-1);
    },
  } as never);
  return handler!;
}

async function balanceWithVoucherPayment(row: Record<string, unknown>) {
  const supplier = { id: 5, companyId: 7, name: "FX", parentId: null, openingBalance: "0" };
  // suppliers, containers, payments, voucher payments, FX transfers, post-offload charges
  harness.queue = [[supplier], [], [], [{ factorySupplierId: 5, optional: false, ...row }], [], []];
  let body: { operationalMemo: { outstandingUsd: string } } | undefined;
  await balanceHandler()(
    { session: { factoryCompanyId: 7 }, params: { id: "5" } },
    { set: () => undefined, status: () => ({ json: () => undefined }), json: (b: typeof body) => (body = b) }
  );
  return Number(body!.operationalMemo.outstandingUsd);
}

describe("factory supplier balance voucher payments (operational memo)", () => {
  it("uses a normalized CFA payment's stored USD base instead of converting it again", async () => {
    // Converting the stored 1000 USD again at 655.957 gave 1.52.
    expect(await balanceWithVoucherPayment({ ...normalizedCfa, exchangeRate: "655.957" })).toBe(-1000);
  });

  it("converts a legacy foreign-currency payment exactly as before", async () => {
    expect(await balanceWithVoucherPayment({ ...legacyEur, exchangeRate: "0.8" })).toBe(-1250);
  });
});
