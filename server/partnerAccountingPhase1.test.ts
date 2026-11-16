import { describe, expect, it } from "vitest";

import {
  assertBalancedPhase1Voucher,
  buildContainerReservePlan,
  buildFundingAllocationPlan,
  buildLocationSaleVoucher,
  calculateSaleEconomics,
  type PostingAccount,
} from "./partnerAccounting";

// Phase 1 acceptance examples are intentionally kept as explicit regression cases.
const ledger = (id: number, name: string): PostingAccount => ({ kind: "ledger", id, name });
const bank = (id: number, name: string): PostingAccount => ({ kind: "bank", id, name });

describe("Golden Coast Phase 1 accounting rules", () => {
  it("keeps the $22,300 container reserve as a plan rather than a prepaid expense", () => {
    expect(
      buildContainerReservePlan({
        reserveUsd: 22_300,
        expectedDutyUsd: 8_500,
        expectedTransportUsd: 12_200,
      })
    ).toEqual({
      reserveUsd: "22300.00",
      expectedDutyUsd: "8500.00",
      expectedTransportUsd: "12200.00",
      expectedTotalUsd: "20700.00",
      reserveHeadroomUsd: "1600.00",
    });
  });

  it("calculates $33,700 remaining after stock OTW and the reserve", () => {
    expect(
      buildFundingAllocationPlan({
        fundingBalanceUsd: 100_000,
        inventoryInTransitUsd: 44_000,
        containerReserveUsd: 22_300,
      })
    ).toEqual({
      fundingBalanceUsd: "100000.00",
      inventoryInTransitUsd: "44000.00",
      containerReserveUsd: "22300.00",
      savingsAvailableUsd: "33700.00",
    });
  });

  it("calculates the 30-bag example as $1,800 revenue, $660 COGS and $1,140 gross profit", () => {
    expect(
      calculateSaleEconomics({
        quantity: 30,
        salePricePerUnitUsd: 60,
        inventoryCostPerUnitUsd: 22,
      })
    ).toEqual({
      quantity: "30",
      revenueUsd: "1800.00",
      cogsUsd: "660.00",
      grossProfitUsd: "1140.00",
    });
  });

  it.each([1, 2, 3])("attributes a sale and COGS to location %s", (locationId) => {
    const voucher = buildLocationSaleVoucher({
      quantity: 30,
      salePricePerUnitUsd: 60,
      inventoryCostPerUnitUsd: 22,
      locationId,
      cashOrReceivableAccount: bank(1, "Operating Bank"),
      salesRevenueAccount: ledger(401, "Sales"),
      cogsAccount: ledger(501, "COGS"),
      inventoryAccount: ledger(202, "Inventory"),
    });

    expect(voucher.locationId).toBe(locationId);
    expect(voucher.totalAmount).toBe("1800.00");
    expect(voucher.entries).toHaveLength(4);
  });

  it("rejects an unbalanced voucher", () => {
    expect(() =>
      assertBalancedPhase1Voucher({
        voucherType: "Journal",
        totalAmount: "100.00",
        description: "bad voucher",
        entries: [
          { ledgerAccountId: 1, debitAmount: "100.00", creditAmount: "0.00", narration: "debit" },
          { ledgerAccountId: 2, debitAmount: "0.00", creditAmount: "90.00", narration: "credit" },
        ],
      })
    ).toThrow("Voucher is not balanced");
  });
});
