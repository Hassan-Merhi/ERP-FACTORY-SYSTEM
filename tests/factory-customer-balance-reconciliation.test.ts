import { beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyDecimal } from "../server/lib/money";

const harness = vi.hoisted(() => ({
  partyBalances: vi.fn(),
  heldCharges: vi.fn(),
}));
vi.mock("../server/db", () => ({ db: {} }));
vi.mock("../server/services/accounting/balances/ledgerBalanceEngine", () => ({
  getPartyBalances: harness.partyBalances,
}));
vi.mock("../server/routes/factory/customers-core/heldUnfinalizedCustomerCharges", () => ({
  heldUnfinalizedCustomerCharges: harness.heldCharges,
  customerStatementLedgerBalance: (balance: MoneyDecimal, held: MoneyDecimal) => balance.minus(held),
}));

import {
  getCustomerLedgerAndMemo,
  splitBalanceFields,
} from "../server/routes/factory/customers-core/customerLedgerSplit";

describe("factory customer statement / Parties / Net Position reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.partyBalances.mockResolvedValue({
      parties: [
        {
          id: 42,
          closing: "2900.00",
          masterOpening: "0.00",
          memoTotal: "0.00",
          memoLines: [],
        },
        {
          id: 43,
          closing: "120.00",
          masterOpening: "0.00",
          memoTotal: "0.00",
          memoLines: [],
        },
      ],
    });
    harness.heldCharges.mockResolvedValue(new Map([[42, new MoneyDecimal("2900.00")]]));
  });

  it("shows Angola as zero everywhere while retaining 2900 of posted vouchers for audit", async () => {
    const result = await getCustomerLedgerAndMemo(12, [42, 43], "2026-10-16");
    const angola = result.get(42)!;
    expect(angola.ledger.toFixed(2)).toBe("0.00");
    expect(angola.generalLedger.toFixed(2)).toBe("2900.00");
    expect(angola.heldUnfinalizedCharges.toFixed(2)).toBe("2900.00");
    expect(splitBalanceFields(angola)).toMatchObject({
      balance: 0,
      ledgerBalance: 0,
      generalLedgerBalance: 2900,
      heldUnfinalizedCharges: 2900,
      notInLedgerTotal: 0,
    });
    expect(splitBalanceFields(result.get(43))).toMatchObject({
      balance: 120,
      ledgerBalance: 120,
      heldUnfinalizedCharges: 0,
    });
    // No known-at cutoff: the live/date-only path, unchanged.
    expect(harness.heldCharges).toHaveBeenCalledWith(12, [42, 43], "2026-10-16", undefined);
  });

  it("does not subtract any amount if no charge voucher is held", async () => {
    harness.heldCharges.mockResolvedValue(new Map());
    const result = await getCustomerLedgerAndMemo(12, [42, 43]);
    expect(result.get(42)?.ledger.toFixed(2)).toBe("2900.00");
    expect(splitBalanceFields(result.get(42))).toMatchObject({ balance: 2900 });
  });
});
