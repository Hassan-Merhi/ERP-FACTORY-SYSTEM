import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportVoucherHelper } from "../../client/src/pages/vouchers/voucherActions";
import {
  exportFactoryDaybookSummary,
  exportFactoryDaybookDetailed,
} from "../../client/src/pages/factory/daybook/factoryDaybookExports";
import type { DaybookEntry } from "../../client/src/pages/factory/daybook/types";

const mocked = vi.hoisted(() => ({ exporter: vi.fn() }));
vi.mock("@/lib/operationalExcelExport", () => ({
  exportOperationalWorkbook: mocked.exporter,
}));

beforeEach(() => {
  mocked.exporter.mockReset();
  mocked.exporter.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

function daybookEntry(overrides: Partial<DaybookEntry> = {}): DaybookEntry {
  return {
    id: 5, companyId: 2, txDate: "2026-11-13", txType: "PAYMENT",
    referenceId: 51, referenceTable: "vouchers", description: "Cash payment",
    metaJson: null, currencyCode: "EUR", amountCurrency: "120.50",
    fxRateToUsd: "1.123456", amountUsd: "107.11",
    optional: false, createdAt: "2026-11-13T10:00:00Z", createdBy: null,
    ...overrides,
  };
}

describe("Phase 7 voucher financial exports", () => {
  it("keeps payment voucher item amounts numeric and the original account/notes columns", async () => {
    const toast = vi.fn();
    await exportVoucherHelper({
      activeTab: "payment", detailed: true, toast,
      formData: {
        voucherDate: new Date("2026-11-13T12:00:00Z"),
        entries: [
          { accountId: 7, accountName: "Customer A", accountType: "Customer", amount: "19.50" },
          { accountId: 8, accountName: "Customer B", accountType: "Customer", amount: "12.25" },
        ],
        paymentAccountName: "Main Cash", notes: "Approved", optional: true,
      },
    });
    expect(mocked.exporter).toHaveBeenCalledTimes(1);
    const data = mocked.exporter.mock.calls[0][0];
    expect(data.sheets[0].name).toBe("Payment Detailed");
    expect(data.sheets[0].rows[0].Amount).toBe(19.5);
    expect(data.sheets[0].rows[1].Amount).toBe(12.25);
    expect(data.sheets[0].rows[0]["Pay From/Receive In"]).toBe("Main Cash");
    expect(data.sheets[0].columns.map((c: { key: string }) => c.key)).toEqual([
      "Voucher Type", "Date", "Pay From/Receive In", "Account",
      "Account Type", "Amount", "Notes", "Optional",
    ]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Export successful" }));
  });

  it("keeps receipt voucher summary totals native numeric without recalculation", async () => {
    await exportVoucherHelper({
      activeTab: "receipt", detailed: false, toast: vi.fn(),
      formData: {
        entries: [{ accountId: 1, amount: "40.35" }, { accountId: 2, amount: "20.15" }],
        notes: "USD receipt",
      },
    });
    const data = mocked.exporter.mock.calls[0][0];
    expect(data.sheets[0].name).toBe("Receipt Summary");
    expect(data.sheets[0].rows[0]["Total Amount"]).toBeCloseTo(60.5, 8);
    expect(data.sheets[0].rows[0]["Number of Entries"]).toBe(2);
    expect(data.sheets[0].columns.find((col: { key: string }) => col.key === "Total Amount").type)
      .toBe("money");
  });

  it("does not export a voucher with no valid account entries", async () => {
    const toast = vi.fn();
    await exportVoucherHelper({
      activeTab: "payment", detailed: false, toast,
      formData: { entries: [{ accountId: 0, amount: "150" }] },
    });
    expect(mocked.exporter).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "No data to export" }));
  });
});

describe("Phase 7 Factory Daybook exports", () => {
  it("keeps base-currency value, transaction amount, and FX rate as separate numbers", async () => {
    const result = await exportFactoryDaybookSummary([daybookEntry()], (v) => v);
    expect(result.rowCount).toBe(1);
    const spec = mocked.exporter.mock.calls[0][0];
    expect(spec.sheets[0].name).toBe("Factory Daybook");
    expect(spec.sheets[0].rows[0].Amount).toBe(120.5);
    expect(spec.sheets[0].rows[0]["FX Rate"]).toBe(1.123456);
    expect(spec.sheets[0].rows[0]["Amount (USD)"]).toBe(107.11);
    expect(spec.sheets[0].columns.find((c: { key: string }) => c.key === "FX Rate").numFmt)
      .toBe("0.000000");
  });

  it("writes debit/credit lines in proper columns without converting them to strings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, json: async () => ({ entries: [
        { accountName: "Cash USD", debitAmount: "12.50", creditAmount: "0" },
        { accountName: "Supplier EUR", debitAmount: "0", creditAmount: "12.50" },
      ] }),
    })));
    const result = await exportFactoryDaybookDetailed([daybookEntry()], (v) => v);
    expect(result.rowCount).toBe(2);
    const spec = mocked.exporter.mock.calls[0][0];
    expect(spec.sheets).toHaveLength(1);
    expect(spec.sheets[0].rows[0]["Account Name"]).toBe("Cash USD");
    expect(spec.sheets[0].rows[0].Debit).toBe(12.5);
    expect(spec.sheets[0].rows[0].Credit).toBe("");
    expect(spec.sheets[0].rows[1].Debit).toBe("");
    expect(spec.sheets[0].rows[1].Credit).toBe(12.5);
    expect(spec.sheets[0].columns.map((c: { key: string }) => c.key).slice(-2))
      .toEqual(["Debit", "Credit"]);
  });

  it("rejects a partial detailed journal rather than exporting unaudited DR/CR lines", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(exportFactoryDaybookDetailed([daybookEntry()], (v) => v))
      .rejects.toThrow(/Could not verify all Daybook voucher lines/);
    expect(mocked.exporter).not.toHaveBeenCalled();
  });

  it("retains an empty workbook with declared columns for an empty filter", async () => {
    const result = await exportFactoryDaybookDetailed([], (v) => v);
    expect(result.rowCount).toBe(0);
    const spec = mocked.exporter.mock.calls[0][0];
    expect(spec.sheets[0].name).toBe("Factory Daybook Detail");
    expect(spec.sheets[0].rows).toHaveLength(0);
  });
});
