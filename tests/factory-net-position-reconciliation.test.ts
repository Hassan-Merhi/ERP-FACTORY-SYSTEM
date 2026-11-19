/**
 * Phase 7: historical Net Position must reconcile its header and categories
 * with the actual displayed rows after stock, party and rental projections.
 * Authored only; Claude will run this with the project checks later.
 */
import { describe, it, expect } from "vitest";
import {
  reconcileHistoricalPosition,
  groupPositionRows,
  sumPositionRows,
} from "../server/services/factory/netPositionReportTotals";

const row = (name: string, value: number, category: string, code = "TEST") => ({ name, code, value, category });

describe("Factory historical net position: canonical dated rows", () => {
  it("recalculates header, both sides and every category from the same accounts", () => {
    const report = {
      asOf: "2026-10-19",
      forUsTotal: 99999,
      onUsTotal: 99999,
      netPosition: 1,
      netPositionLabel: "stale",
      forUs: {
        total: 99999,
        breakdown: [{ name: "stale", value: 99999 }],
        accounts: [
          row("Inventory", 250, "Inventory", "INVENTORY"),
          row("Raw", 110, "Raw Material", "RAW_MATERIAL"),
          row("Prepaid timing adjustment", -30, "Asset", "PREPAID_ADJUST"),
          row("Cash", 100, "Asset", "CASH"),
          row("Verified", 75, "Uninvoiced Orders", "VERIFIED_ORDERS"),
          row("Loading", 25, "Uninvoiced Orders", "LOADING_ORDERS"),
        ],
      },
      onUs: {
        total: 99999,
        breakdown: [{ name: "stale", value: 99999 }],
        accounts: [
          row("Loan", 300, "Loans", "LOAN"),
          row("Supplier A", 60, "Supplier", "SUPPLIER"),
          row("Supplier B", 20, "Supplier", "SUPPLIER"),
          row("Payroll Payable", 40, "Liability", "EMPLOYEE_PAYROLL_PAYABLE"),
        ],
      },
    };
    reconcileHistoricalPosition(report);
    expect(report.forUsTotal).toBe(530);
    expect(report.onUsTotal).toBe(420);
    expect(report.netPosition).toBe(110);
    expect(report.forUs.total).toBe(report.forUsTotal);
    expect(report.onUs.total).toBe(report.onUsTotal);
    expect(report.forUs.breakdown).toEqual(
      [
        { name: "Inventory", value: 250 },
        { name: "Asset", value: 70 },
        { name: "Uninvoiced Orders", value: 100 },
        { name: "Raw Material", value: 110 },
      ].sort((a, b) => b.value - a.value)
    );
    expect(report.onUs.breakdown.find((item) => item.name === "Suppliers")?.value).toBe(80);
    expect(report.onUs.breakdown.reduce((sum, item) => sum + item.value, 0)).toBe(report.onUsTotal);
  });

  it("uses signed contra-assets, never their absolute values", () => {
    const rows = [row("Assets", 100, "Asset"), row("Prepaid credit", -40, "Asset")];
    expect(sumPositionRows(rows)).toBe(60);
    expect(groupPositionRows(rows)).toEqual([{ name: "Asset", value: 60 }]);
  });

  it("sums rows with decimal precision at each displayed cent", () => {
    const rows = [row("A", 0.1, "Cash"), row("B", 0.2, "Cash"), row("C", -0.15, "Cash")];
    expect(sumPositionRows(rows)).toBe(0.15);
    expect(groupPositionRows(rows)).toEqual([{ name: "Cash", value: 0.15 }]);
  });

  it("refuses nonfinite historical amounts rather than returning a false total", () => {
    expect(() => sumPositionRows([row("Unknown", Infinity, "Asset")])).toThrow(
      "HISTORICAL_NET_POSITION_NONFINITE_AMOUNT"
    );
  });

  it("remains consistent when inventory is worth more yesterday than today", () => {
    const report = {
      forUsTotal: 0,
      onUsTotal: 0,
      netPosition: 0,
      netPositionLabel: "",
      forUs: { total: 0, breakdown: [], accounts: [row("Inventory", 1000, "Inventory")] },
      onUs: { total: 0, breakdown: [], accounts: [row("Supplier", 100, "Supplier")] },
    };
    reconcileHistoricalPosition(report);
    expect(report.forUsTotal).toBe(1000);
    expect(report.netPosition).toBe(900);
    report.forUs.accounts[0].value = 250;
    reconcileHistoricalPosition(report);
    expect(report.forUsTotal).toBe(250);
    expect(report.netPosition).toBe(150);
  });
});
