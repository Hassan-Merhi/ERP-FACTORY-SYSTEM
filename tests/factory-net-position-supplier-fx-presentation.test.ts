import { describe, expect, it, vi } from "vitest";

// Presentation calculations are pure: no live DB is read and no voucher is posted.
vi.mock("../server/db", () => ({ db: {} }));
import { supplierOpenPayableFxBasisAdjustment } from "../server/routes/factory/employee-pos/netPositionSupplierBalances";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const source = (rate: string, status = "OFFLOADED", confirmed = true) => ({
  currencyCode: "EUR",
  totalKg: "21270",
  ratePerKg: "0.36",
  fxRateToUsd: rate,
  fxRateConfirmed: confirmed,
  status,
});

const adjustment = (
  balance: string,
  rate: string,
  containers: any[] = [source("1.18")]
) => supplierOpenPayableFxBasisAdjustment({
  pools: [{ currencyCode: "EUR", balance }],
  containers,
  getConfigFx: () => Number(rate),
  round2,
});

describe("Factory Net Position supplier FX Gain/Loss presentation", () => {
  it("separates an outstanding 1.18 EUR purchase into a positive gain at 1.12", () => {
    // USD 9,035.50 historical - USD 8,576.06 current = USD 459.44.
    const gain = adjustment("7657.20", "1.12");
    expect(gain).toBe(459.44);
    const supplierHistoric = round2(8576.06 + gain);
    // Gain shown under Have, historic supplier under Owe: same net exposure.
    expect(round2(gain - supplierHistoric)).toBe(-8576.06);
  });

  it("shows a loss when the current payable rate rises", () => {
    const loss = adjustment("7657.20", "1.24");
    expect(loss).toBe(-459.43);
    // A loss appears under Owe while supplier's displayed historical basis falls.
    const currentLiability = 9494.93;
    const historicSupplier = round2(currentLiability + loss);
    expect(round2(historicSupplier + Math.abs(loss))).toBe(currentLiability);
  });

  it("uses only the outstanding amount after partial settlement", () => {
    expect(adjustment("4000", "1.12")).toBe(240);
    expect(adjustment("0", "1.12")).toBe(0);
    expect(adjustment("-100", "1.12")).toBe(0);
  });

  it("does not invent FX gains for unconfirmed, mixed-rate or OTW sources", () => {
    expect(adjustment("7657.20", "1.12", [source("1.18", "OFFLOADED", false)])).toBe(0);
    expect(adjustment("7657.20", "1.12", [source("1.18"), source("1.15")])).toBe(0);
    expect(adjustment("7657.20", "1.12", [source("1.18", "IN_TRANSIT")])).toBe(0);
    expect(adjustment("7657.20", "1.12", [])).toBe(0);
  });
});
