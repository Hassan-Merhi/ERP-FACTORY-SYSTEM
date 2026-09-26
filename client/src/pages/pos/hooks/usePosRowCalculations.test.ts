import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SaleRow } from "../pos-components/posTypes";
import { resolvePosItemRate, usePosRowCalculations } from "./usePosRowCalculations";

const item = { code: "A", name: "Item A", stock: 10, price: 2, configuredPrice: 1.5, stockItemId: 7 };

describe("resolvePosItemRate", () => {
  it("prefers the last sold price and converts to CFA", () => {
    expect(resolvePosItemRate(item, {}, "USD", null)).toEqual({
      rateUSD: 2,
      displayRate: 2,
      normalDisplayRate: 2,
      lastSoldDisplayRate: null,
    });
    expect(resolvePosItemRate(item, { 7: "3" }, "CFA", 600)).toEqual({
      rateUSD: 3,
      displayRate: 1800,
      normalDisplayRate: 1200,
      lastSoldDisplayRate: 1800,
    });
  });
});

function setup(overrides: Partial<Parameters<typeof usePosRowCalculations>[0]> = {}) {
  let rows: SaleRow[] = [{ id: "r0", itemName: "", quantity: 0, rate: 0, rateUSD: 0, amount: 0 }];
  const setRows = vi.fn((next: SaleRow[] | ((current: SaleRow[]) => SaleRow[])) => {
    rows = typeof next === "function" ? next(rows) : next;
  });
  const setZeroStockAlert = vi.fn();
  const hook = renderHook(() =>
    usePosRowCalculations({
      rows,
      activeRow: null,
      setRows: setRows as never,
      setSearchTerm: vi.fn(),
      setZeroStockItem: vi.fn(),
      setZeroStockAlert,
      lastSoldPrices: {},
      activeCurrency: "CFA",
      exchangeRate: 600,
      focusCell: vi.fn(),
      ...overrides,
    })
  );
  return { hook, getRows: () => rows, setZeroStockAlert };
}

describe("usePosRowCalculations.selectItem", () => {
  it("adds the default line when no overrides are given (grid behaviour unchanged)", () => {
    const { hook, getRows } = setup();
    act(() => hook.result.current.selectItem(item));
    expect(getRows()[0]).toMatchObject({ stockItemId: 7, quantity: 1, rate: 1200, rateUSD: 2, amount: 1200 });
  });

  it("applies the phone sheet's quantity and price, converting the price back to USD", () => {
    const { hook, getRows } = setup();
    act(() => hook.result.current.selectItem(item, undefined, { quantity: 5, rate: 1500 }));
    expect(getRows()[0]).toMatchObject({ quantity: 5, rate: 1500, rateUSD: 2.5, amount: 7500 });
  });

  it("blocks zero-stock items without negative-stock permission", () => {
    const { hook, getRows, setZeroStockAlert } = setup();
    let allowed = true;
    act(() => {
      allowed = hook.result.current.ensureItemSellable({ ...item, stock: 0 });
    });
    expect(allowed).toBe(false);
    expect(setZeroStockAlert).toHaveBeenCalledWith(true);
    act(() => hook.result.current.selectItem({ ...item, stock: 0 }, undefined, { quantity: 2 }));
    expect(getRows()[0].stockItemId).toBeUndefined();
  });
});
