import React from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePosEditVoucherHydration } from "@/pages/pos/usePosEditVoucherHydration";

function editorProps() {
  const originalLocation = {
    id: 31,
    name: "LUSAKA DEPOT",
    code: "LD",
    city: null,
    state: null,
    country: null,
  };
  const otherLocation = { ...originalLocation, id: 32, name: "LUSAKA SHOP" };
  return {
    editVoucherId: "19",
    editVoucher: {
      currency: "ZMW",
      exchangeRate: "20.8",
      locationId: 31,
      voucherDate: "2026-11-18",
      voucherNumber: "SV-19-2026-000002",
      description: "Original sale",
      isCreditSale: true,
      salesItems: [
        {
          id: 71,
          stockItemId: 55,
          stockItemName: "GS Hard Toys 20 KGS",
          stockItemCode: "GS10851",
          quantity: "2",
          sellingPrice: "100.000000",
          // The cashier-safe detail API deliberately omits cost and totalSales.
        },
      ],
      entries: [],
    },
    editVoucherViewEntries: [],
    posUser: { role: "POS" } as any,
    posAssignedLocations: [otherLocation, originalLocation],
    posSelectedLocation: otherLocation,
    setPosSelectedLocation: vi.fn(),
    allLocations: [],
    allLedgerAccounts: [],
    selectedLocation: null,
    setSelectedLocation: vi.fn(),
    setRows: vi.fn(),
    setNotes: vi.fn(),
    setSaleDate: vi.fn(),
    setPaymentAccountType: vi.fn(),
    setPaymentAccountId: vi.fn(),
    setIsCreditSale: vi.fn(),
    setSelectedCustomerId: vi.fn(),
  };
}

describe("Daybook receipt hydration on the full Point of Sale editor", () => {
  it("selects the original assigned location and loads price, quantity and credit status without ledger data", () => {
    const props = editorProps();
    renderHook(() => usePosEditVoucherHydration(props));
    expect(props.setPosSelectedLocation).toHaveBeenCalledWith(props.posAssignedLocations[1]);
    expect(props.setSelectedLocation).not.toHaveBeenCalled();
    const newRows = props.setRows.mock.calls[0][0];
    expect(newRows[0]).toMatchObject({
      stockItemId: 55,
      salesItemId: 71,
      quantity: 2,
      rate: 2080,
      rateUSD: 100,
      amount: 4160,
    });
    expect(props.setNotes).toHaveBeenCalledWith("Original sale");
    expect(props.setSaleDate).toHaveBeenCalledWith("2026-11-18");
    expect(props.setIsCreditSale).toHaveBeenCalledWith(true);
  });

  it("loads a cent-rounded legacy Kwacha sale at the price typed, in Kwacha or as a USD view", () => {
    const legacySale = () => {
      const props = editorProps();
      props.editVoucher.salesItems[0].sellingPrice = "96.150000";
      return { ...props, editVoucher: { ...props.editVoucher, nativeZmwTotal: "4000.000000" } };
    };
    const kwachaView = legacySale();
    renderHook(() => usePosEditVoucherHydration(kwachaView));
    expect(kwachaView.setRows.mock.calls[0][0][0]).toMatchObject({ rate: 2000, amount: 4000 });

    const usdView = { ...legacySale(), activeCurrency: "USD" };
    renderHook(() => usePosEditVoucherHydration(usdView));
    const row = usdView.setRows.mock.calls[0][0][0];
    expect(row).toMatchObject({ rate: 96.15, amount: 192.3 });
    // The USD view still carries the exact price, so switching back shows K2,000.00.
    expect(Number((row.rateUSD * 20.8).toFixed(2))).toBe(2000);
  });

  it("loads a CFA sale in CFA at the price typed, or as a USD view, never as USD figures in a CFA grid", () => {
    const cfaSale = (activeCurrency?: string) => {
      const props = editorProps();
      return {
        ...props,
        activeCurrency,
        editVoucher: {
          ...props.editVoucher,
          currency: "CFA",
          exchangeRate: "605",
          // Legacy cent-rounded USD price of a 40,000 CFA item; the sale posted USD x rate.
          salesItems: [{ ...props.editVoucher.salesItems[0], sellingPrice: "66.120000" }],
          entries: [{ transactionCurrency: "CFA", transactionDebitAmount: "80005.200000", debitAmount: "132.24" }],
        },
      };
    };
    const cfaView = cfaSale("CFA");
    renderHook(() => usePosEditVoucherHydration(cfaView));
    expect(cfaView.setRows.mock.calls[0][0][0]).toMatchObject({ rate: 40000, amount: 80000 });

    const usdView = cfaSale("USD");
    renderHook(() => usePosEditVoucherHydration(usdView));
    const row = usdView.setRows.mock.calls[0][0][0];
    expect(row).toMatchObject({ rate: 66.12, amount: 132.24 });
    expect(Math.round(row.rateUSD * 605)).toBe(40000);
  });

  it("never selects an unassigned shop and does not overwrite rows during rerender", () => {
    const props = editorProps();
    props.posAssignedLocations = [props.posAssignedLocations[0]];
    const { rerender } = renderHook(() => usePosEditVoucherHydration(props));
    expect(props.setPosSelectedLocation).not.toHaveBeenCalled();
    expect(props.setRows).toHaveBeenCalledTimes(1);
    rerender();
    expect(props.setRows).toHaveBeenCalledTimes(1);
  });
});
