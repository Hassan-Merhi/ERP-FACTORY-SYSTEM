/**
 * Supplier balances per currency and the historical base balance were float
 * running totals over every voucher entry: credits of 0.10 and 0.20 summed to
 * 0.30000000000000004, and the residue grew with the supplier's history.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/routes/performance/supplierVoucherEntryBatcher", () => ({
  getVoucherEntriesBySupplierBatched: vi.fn(),
}));

import { getSupplierBalanceForContext } from "../server/routes/helpers/supplierBalanceHelpers";
import { getVoucherEntriesBySupplierBatched } from "../server/routes/performance/supplierVoucherEntryBatcher";

describe("supplier balance by currency", () => {
  it("sums each currency and the historical base balance exactly", async () => {
    const entries = [
      { creditAmount: "0.10", debitAmount: "0", transactionCurrency: "USD" },
      { creditAmount: "0.20", debitAmount: "0", transactionCurrency: "USD" },
      { creditAmount: "0", debitAmount: "0.10", transactionCurrency: "USD" },
    ];
    vi.mocked(getVoucherEntriesBySupplierBatched).mockResolvedValue(
      entries as unknown as Awaited<ReturnType<typeof getVoucherEntriesBySupplierBatched>>
    );

    const result = await getSupplierBalanceForContext({ id: 1, companyId: 5, openingBalance: "0" }, 5);

    expect(result.balancesByCurrency.USD).toEqual({ debit: 0.1, credit: 0.3, net: 0.2 });
    expect(result.historicalBaseBalance).toBe(0.2);
    expect(result.balance).toBe(0.2);
  });
});
