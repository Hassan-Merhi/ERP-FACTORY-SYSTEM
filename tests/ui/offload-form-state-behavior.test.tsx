/**
 * Raw-stock offload form state. Selecting a container prefills the offload
 * with the container's cost, currency and charges; the rules below decide
 * which account each charge is credited to and which FX rate prices it, so a
 * regression here misstates landed cost without any visible error:
 *
 *  - freight credits the explicit freight supplier, else the company's own
 *    account, and never falls back to the DR expense account
 *  - a non-USD freight / other-charge / commission currency fetches its own
 *    live USD rate instead of posting at 1
 *  - a commission in a third currency uses that currency's rate, not the
 *    container's; a confirmed stored commission rate wins
 *  - a PARTIALLY_RECEIVED container defaults to the remaining kg, uses the
 *    fixed landed rate and locks every charge
 */
import { act, renderHook, waitFor } from "@testing-library/react";

const fx = vi.hoisted(() => ({ rates: {} as Record<string, number | null>, calls: [] as string[] }));
vi.mock("@/lib/factoryApi", () => ({
  factoryApiRequest: vi.fn(async (_method: string, url: string) => {
    fx.calls.push(url);
    const ccy = url.split("/").pop()!;
    const rate = fx.rates[ccy];
    if (rate === undefined) throw new Error("network");
    return { ok: rate !== null, json: async () => ({ rate, date: "2026-09-20" }) };
  }),
}));

import { useOffloadFormState } from "@/pages/factory/production-raw-stock/useOffloadFormState";

const suppliers = [
  { id: 7, name: "Broker Bob" },
  { id: 8, name: "Freight Co" },
];

const containers: any[] = [
  {
    id: 1,
    status: "ARRIVED",
    totalKg: "20000",
    currencyCode: "AUD",
    fxRateToUsd: "0.67",
    ratePerKg: "0.5",
    freight: "900",
    freightCurrencyCode: "AUD",
    freightSupplierId: 8,
    freightAccountId: 99,
    otherCharges: "120",
    otherChargesCurrencyCode: "USD",
    otherChargesAccountId: 44,
    commissionAmount: "300",
    commissionCurrencyCode: "EUR",
    commissionSupplierId: 7,
  },
  {
    id: 2,
    status: "ARRIVED",
    totalKg: "1000",
    currencyCode: "USD",
    fxRateToUsd: "1",
    ratePerKg: "1.2",
    freight: "0",
    freightPaidBy: "own",
    freightOwnAccountId: 55,
    commissionAmount: "80",
    commissionCurrencyCode: "EUR",
    commissionFxRateToUsd: "1.1",
    commissionFxRateConfirmed: true,
  },
  {
    id: 3,
    status: "PARTIALLY_RECEIVED",
    totalKg: "10000",
    actualReceivedKg: "6000",
    currencyCode: "USD",
    fxRateToUsd: "1",
    ratePerKg: "0.9",
    fixedCostPerKgUsd: "0.95",
    freight: "500",
  },
];

beforeEach(() => {
  fx.rates = { EUR: 1.18, GBP: 1.27, AUD: 0.67 };
  fx.calls = [];
});

function setup() {
  return renderHook(({ open }) => useOffloadFormState(open, containers, suppliers), { initialProps: { open: true } });
}

describe("container prefill", () => {
  it("prefills cost, charges and credit destinations from a fresh container", async () => {
    const { result } = setup();
    act(() => result.current.handleContainerSelect("1"));

    const f = result.current.fields;
    expect(f).toMatchObject({
      selectedContainerId: "1",
      currencyCode: "AUD",
      fxRateToUsd: "0.67",
      costPerKg: "0.5",
      actualReceivedKg: "20000",
      freight: "900",
      freightFromContainer: true,
      freightCurrencyCode: "AUD",
      freightFxRate: "0.67",
      // Explicit freight supplier, never the DR expense account (99).
      freightAccountId: "SUP:8",
      otherCharges: "120",
      otherChargesCurrencyCode: "USD",
      otherChargesFxRate: "1",
      otherChargesAccountId: "44",
      commissionType: "FIXED",
      commissionRate: "300",
      commissionPersonName: "Broker Bob",
      containerCommissionCcy: "EUR",
    });
    expect(result.current.isSubsequentReceipt).toBe(false);

    // EUR commission on an AUD container resolves EUR/USD, not AUD/USD.
    await waitFor(() => expect(result.current.fields.commissionFxRate).toBe("1.18"));
    expect(result.current.fields.commissionFxEffectiveDate).toBe("2026-09-20");
    expect(fx.calls).toContain("/api/factory/fx-rates/latest/EUR");
  });

  it("credits freight to the company's own account and keeps a confirmed stored commission rate", () => {
    const { result } = setup();
    act(() => result.current.handleContainerSelect("2"));

    expect(result.current.fields.freightAccountId).toBe("55");
    expect(result.current.fields.freight).toBe("");
    expect(result.current.fields.freightFromContainer).toBe(false);
    expect(result.current.fields.commissionFxRate).toBe("1.1");
    expect(result.current.fields.commissionPersonName).toBe("Commission");
  });

  it("defaults a partial receipt to the remaining kg at the fixed landed rate and locks charges", () => {
    const { result } = setup();
    act(() => result.current.handleContainerSelect("1"));
    act(() => result.current.handleContainerSelect("3"));

    const f = result.current.fields;
    expect(result.current.isSubsequentReceipt).toBe(true);
    expect(f.actualReceivedKg).toBe("4000.000");
    expect(f.costPerKg).toBe("0.95");
    expect(f).toMatchObject({
      freight: "",
      freightAccountId: "",
      otherCharges: "",
      commissionPersonName: "",
      commissionRate: "",
      dutyAmount: "",
      additionalCharges: [],
    });
    expect(result.current.partialReceiptInfo).not.toBeNull();

    act(() => result.current.setActualReceivedKg("1000"));
    expect(result.current.receiptValue).not.toBeNull();
  });

  it("ignores an unknown container id beyond recording the selection", () => {
    const { result } = setup();
    act(() => result.current.handleContainerSelect("404"));
    expect(result.current.fields.selectedContainerId).toBe("404");
    expect(result.current.fields.costPerKg).toBe("");
  });
});

describe("currency changes", () => {
  it("fetches a live rate when freight or other charges move off USD, and resets to 1 on USD", async () => {
    const { result } = setup();
    act(() => result.current.setFreightCurrencyCode("GBP"));
    await waitFor(() => expect(result.current.fields.freightFxRate).toBe("1.27"));
    expect(result.current.fields.freightFxRateLoading).toBe(false);

    act(() => result.current.setOtherChargesCurrencyCode("EUR"));
    await waitFor(() => expect(result.current.fields.otherChargesFxRate).toBe("1.18"));

    act(() => result.current.setFreightCurrencyCode("USD"));
    expect(result.current.fields.freightFxRate).toBe("1");
  });

  it("leaves the rate untouched when the rate lookup fails", async () => {
    fx.rates = {};
    const { result } = setup();
    act(() => result.current.setFreightCurrencyCode("GBP"));
    await waitFor(() => expect(result.current.fields.freightFxRateLoading).toBe(false));
    expect(result.current.fields.freightFxRate).toBe("1");
  });
});

describe("additional charges", () => {
  it("adds, edits, re-prices and removes charge rows", async () => {
    const { result } = setup();
    act(() => result.current.handleAddAdditionalCharge());
    const id = result.current.fields.additionalCharges[0].id;

    act(() => result.current.handleUpdateAdditionalCharge(id, "description", "Fumigation"));
    act(() => result.current.handleUpdateAdditionalCharge(id, "amount", "75"));
    act(() => result.current.handleUpdateAdditionalCharge(id, "currencyCode", "EUR"));
    expect(result.current.fields.additionalCharges[0]).toMatchObject({ fxRateLoading: true, fxRate: "" });
    await waitFor(() => expect(result.current.fields.additionalCharges[0].fxRate).toBe("1.18"));
    expect(result.current.fields.additionalCharges[0]).toMatchObject({
      description: "Fumigation",
      amount: "75",
      currencyCode: "EUR",
      fxRateLoading: false,
    });

    act(() => result.current.handleUpdateAdditionalCharge(id, "currencyCode", "USD"));
    expect(result.current.fields.additionalCharges[0]).toMatchObject({ currencyCode: "USD", fxRate: "1" });

    fx.rates = {};
    act(() => result.current.handleUpdateAdditionalCharge(id, "currencyCode", "CHF"));
    await waitFor(() => expect(result.current.fields.additionalCharges[0].fxRateLoading).toBe(false));
    expect(result.current.fields.additionalCharges[0].fxRate).toBe("");

    act(() => result.current.handleRemoveAdditionalCharge(id));
    expect(result.current.fields.additionalCharges).toEqual([]);
  });
});

describe("idempotency key", () => {
  it("is cleared when the dialog closes and when a partial-receipt container is chosen", () => {
    const { result, rerender } = setup();
    result.current.idempotencyKeyRef.current = "key-1";
    rerender({ open: false });
    expect(result.current.idempotencyKeyRef.current).toBeNull();

    rerender({ open: true });
    result.current.idempotencyKeyRef.current = "key-2";
    act(() => result.current.handleContainerSelect("3"));
    expect(result.current.idempotencyKeyRef.current).toBeNull();
  });
});

describe("estimated average cost", () => {
  it("recomputes from the selected container and received weight", () => {
    const { result } = setup();
    const before = result.current.estimatedAvgCostKg;
    act(() => result.current.handleContainerSelect("2"));
    expect(result.current.estimatedAvgCostKg).not.toEqual(before);
  });
});
