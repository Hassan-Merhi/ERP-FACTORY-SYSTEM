import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PosCheckoutStrip } from "@/pages/pos/pos-components/PosCheckoutStrip";
import { usePosCheckout } from "@/pages/pos/hooks/usePosCheckout";

vi.mock("@/contexts/ApplicationLanguageContext", () => ({
  useApplicationLanguage: () => ({ t: (text: string) => text }),
}));

const depot = { id: 7, name: "LUSAKA DEPOT", code: "LD", city: null, state: null, country: null };
const shop = { ...depot, id: 8, name: "LUSAKA SHOP" };

describe("full POS receipt edit protections", () => {
  it("locks original location, credit toggle and payment details on the desktop checkout strip", () => {
    render(
      <PosCheckoutStrip
        posUser={{ role: "POS" } as any}
        editVoucherId="123"
        activeLocation={depot}
        allLocations={[]}
        posAssignedLocations={[depot, shop]}
        posSelectedLocation={depot}
        setPosSelectedLocation={vi.fn()}
        setSelectedLocation={vi.fn()}
        saleDate="2026-11-18"
        setSaleDate={vi.fn()}
        paymentAccountType="cash"
        setPaymentAccountType={vi.fn()}
        paymentAccountId={null}
        setPaymentAccountId={vi.fn()}
        isCreditSale={false}
        setIsCreditSale={vi.fn()}
        customerComboOpen={false}
        setCustomerComboOpen={vi.fn()}
        selectedCustomerId=""
        setSelectedCustomerId={vi.fn()}
        customerAccounts={[]}
        bankAccounts={[]}
        cashLedgerAccounts={[]}
      />
    );
    expect(screen.getByTestId("select-pos-location-strip")).toBeDisabled();
    expect(screen.getByTestId("input-sale-date")).toHaveAttribute("readonly");
    expect(screen.getByTestId("toggle-credit-sale")).toBeDisabled();
    expect(screen.getByTestId("pos-edit-payment-locked")).toHaveTextContent("Original payment");
    expect(screen.queryByTestId("select-payment-account")).not.toBeInTheDocument();
  });

  it("can update the original Kwacha sale without reselecting its payment account", () => {
    const mutate = vi.fn();
    const toast = vi.fn();
    const params = {
      activeLocation: depot,
      editVoucherId: "123",
      editVoucher: { locationId: depot.id, currency: "ZMW", exchangeRate: "20.8" },
      posUser: { role: "POS" },
      rows: [
        {
          id: "1",
          itemName: "GS Hard Toys",
          stockItemId: 55,
          salesItemId: 71,
          quantity: 1,
          rate: 5000,
          rateUSD: 240.384615,
          amount: 5000,
        },
      ],
      isCreditSale: false,
      paymentAccountType: "cash",
      paymentAccountId: null,
      selectedCustomerId: "",
      notes: "Edited",
      saleDate: "2026-11-18",
      activeCurrency: "ZMW",
      exchangeRate: 20.8,
      dailyExchangeRate: 20.8,
      saveMutation: { mutate },
      toast,
    } as any;
    const checkout = usePosCheckout(params);
    checkout.handleSaveSale();
    expect(toast).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        locationId: depot.id,
        voucherDate: "2026-11-18",
        isCreditSale: false,
        paymentAccountType: undefined,
        paymentAccountId: undefined,
        items: [
          expect.objectContaining({
            salesItemId: 71,
            originalCurrencyRate: "5000.00",
            rate: "240.384615",
          }),
        ],
      })
    );
  });

  it("keeps a Kwacha sale in Kwacha when it is updated from the USD view", () => {
    const mutate = vi.fn();
    const toast = vi.fn();
    const checkout = usePosCheckout({
      activeLocation: depot,
      editVoucherId: "123",
      editVoucher: { locationId: depot.id, currency: "ZMW", exchangeRate: "20.8" },
      posUser: { role: "POS" },
      rows: [
        // Untouched line: shown as $96.15, still carrying the exact K2,000 price.
        { id: "1", itemName: "A", stockItemId: 55, salesItemId: 71, quantity: 1, rate: 96.15, rateUSD: 2000 / 20.8 },
        // Line retyped in USD while viewing the sale in USD.
        { id: "2", itemName: "B", stockItemId: 56, salesItemId: 72, quantity: 2, rate: 100, rateUSD: 100 },
      ].map((row) => ({ ...row, amount: row.quantity * row.rate })),
      isCreditSale: false,
      paymentAccountType: "cash",
      paymentAccountId: null,
      selectedCustomerId: "",
      notes: "",
      saleDate: "2026-11-18",
      activeCurrency: "USD",
      exchangeRate: 20.8,
      dailyExchangeRate: 20.8,
      saveMutation: { mutate },
      toast,
    } as any);
    checkout.handleSaveSale();
    expect(toast).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: "ZMW",
        exchangeRate: "20.8",
        items: [
          expect.objectContaining({ originalCurrencyRate: "2000.00", rate: "96.153846" }),
          expect.objectContaining({ originalCurrencyRate: "2080.00", rate: "100.000000" }),
        ],
      })
    );
  });

  it("rejects a stale or mismatched location before sending an edit", () => {
    const mutate = vi.fn();
    const toast = vi.fn();
    const checkout = usePosCheckout({
      posUser: { role: "POS" },
      editVoucherId: "123",
      editVoucher: { locationId: depot.id },
      activeLocation: shop,
      saveMutation: { mutate },
      toast,
    } as any);
    checkout.handleSaveSale();
    expect(mutate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Sale not ready" }));
  });
});
