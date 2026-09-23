import { describe, expect, it } from "vitest";
import {
  buildGoldenCoastPhase6SaleRequest,
  goldenCoastPhase6SaleFingerprint,
  normalizeGoldenCoastPhase6Sale,
} from "../../client/src/pages/pos/hooks/goldenCoastPhase6Pos";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const saleData = {
  locationId: 27,
  voucherDate: "2026-09-05",
  clientSaleId: "sale-client-id",
  notes: "Walk-in customer",
  paymentAccountType: "cash",
  paymentAccountId: 44,
  items: [
    {
      stockItemId: 101,
      quantity: "2",
      rate: "12.345678",
      stockItemName: "Coffee",
      stockItemCode: "COF-1",
      configuredPrice: 10,
    },
  ],
};

const posSource = readFileSync(resolve(process.cwd(), "client/src/pages/pos/POS.tsx"), "utf8");
const readinessAlertSource = readFileSync(
  resolve(process.cwd(), "client/src/pages/pos/pos-components/GoldenCoastPosReadinessAlert.tsx"),
  "utf8"
);
const spSetupSource = readFileSync(resolve(process.cwd(), "client/src/pages/sp/SpSetupPanel.tsx"), "utf8");

describe("Golden Coast POS Phase 6 frontend contract", () => {
  it("builds the strict Phase 6 request and keeps the request identity", () => {
    expect(buildGoldenCoastPhase6SaleRequest(saleData, "stable-request-id")).toEqual({
      locationId: 27,
      saleDate: "2026-09-05",
      customerName: "Walk-in customer",
      clientRequestId: "stable-request-id",
      notes: "Walk-in customer",
      lines: [
        {
          stockItemId: 101,
          qty: "2",
          unitPriceUsd: "12.35",
          description: "Coffee",
        },
      ],
    });
  });

  it("keeps payload fingerprints stable across request-id rotation", () => {
    const first = buildGoldenCoastPhase6SaleRequest(saleData, "first-request-id");
    const retry = buildGoldenCoastPhase6SaleRequest(saleData, "retry-request-id");

    expect(goldenCoastPhase6SaleFingerprint(first)).toBe(goldenCoastPhase6SaleFingerprint(retry));
  });

  it("adapts the revenue posting and replay response for the existing receipt", () => {
    const normalized = normalizeGoldenCoastPhase6Sale(
      {
        replayed: true,
        revenueUsd: null,
        cogsUsd: null,
        grossProfitUsd: null,
        specialLocationDeductionUsd: "10.00",
        lines: null,
        postings: [
          {
            role: "revenue",
            voucher: {
              id: 9001,
              voucherNumber: "GC-POS-9001",
              description: "Golden Coast Phase 6 POS sale",
            },
            entries: [],
          },
          { role: "cogs", voucher: { id: 9002 }, entries: [] },
        ],
      },
      saleData,
      { id: 27, name: "Main", code: "MAIN", city: null, state: null, country: null }
    );

    expect(normalized.voucher.id).toBe(9001);
    expect(normalized.voucherNumber).toBe("GC-POS-9001");
    expect(normalized.grandTotal).toBe("24.70");
    expect(normalized.items).toEqual([
      expect.objectContaining({
        stockItemId: 101,
        stockItemName: "Coffee",
        stockItemCode: "COF-1",
        quantity: "2",
        rate: "12.35",
        amount: "24.70",
      }),
    ]);
    expect(normalized.phase6).toEqual({
      replayed: true,
      cogsUsd: null,
      grossProfitUsd: null,
      specialLocationDeductionUsd: "10.00",
    });
  });

  it("shows accounting blockers without requiring a cutover", () => {
    expect(posSource).toContain("goldenCoastPosBlocked");
    expect(posSource).toContain("disableSave={goldenCoastPosSaveDisabled || posWritesDisabled}");
    expect(readinessAlertSource).toContain('data-testid="golden-coast-pos-readiness-alert"');
    expect(readinessAlertSource).toContain("current inventory cost");
    expect(readinessAlertSource).not.toContain("Phase 3 opening cutover");
    expect(readinessAlertSource).not.toContain("Phase 4 FIFO bridge");
  });

  it("does not expose the optional cutover carry-forward in active setup UI", () => {
    expect(spSetupSource).not.toContain("ExistingPositionCarryForwardPanel");
  });
});
