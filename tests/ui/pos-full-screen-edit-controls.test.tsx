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

  it("updates a CFA sale in CFA at its own rate, from the CFA view or the USD view", () => {
    const save = (activeCurrency: string, rows: Array<Record<string, unknown>>) => {
      const mutate = vi.fn();
      const toast = vi.fn();
      usePosCheckout({
        activeLocation: depot,
        editVoucherId: "123",
        editVoucher: { locationId: depot.id, currency: "CFA", exchangeRate: "605" },
        posUser: { role: "POS" },
        rows,
        isCreditSale: false,
        paymentAccountType: "cash",
        paymentAccountId: null,
        selectedCustomerId: "",
        notes: "",
        saleDate: "2026-11-16",
        activeCurrency,
        // The edit screen hands over the sale's locked rate, not today's.
        exchangeRate: 605,
        dailyExchangeRate: 605,
        saveMutation: { mutate },
        toast,
      } as any).handleSaveSale();
      expect(toast).not.toHaveBeenCalled();
      return mutate.mock.calls[0][0];
    };
    const line = { id: "1", itemName: "A", stockItemId: 55, salesItemId: 71, quantity: 2 };
    const expected = expect.objectContaining({
      currency: "CFA",
      exchangeRate: "605",
      items: [expect.objectContaining({ originalCurrencyRate: "40000.00", rate: "66.115702" })],
    });
    expect(save("CFA", [{ ...line, rate: 40000, rateUSD: 40000 / 605, amount: 80000 }])).toEqual(expected);
    expect(save("USD", [{ ...line, rate: 66.12, rateUSD: 40000 / 605, amount: 132.24 }])).toEqual(expected);
    // A price sold with decimals is not rounded to a whole franc when saved from the USD view.
    expect(save("USD", [{ ...line, rate: 66.12, rateUSD: 40000.5 / 605, amount: 132.24 }]).items[0]).toMatchObject({
      originalCurrencyRate: "40000.50",
      rate: "66.116529",
    });
  });

  it("sends the typed CFA price with a new CFA sale so it can post exactly", () => {
    const mutate = vi.fn();
    const toast = vi.fn();
    usePosCheckout({
      activeLocation: depot,
      rows: [
        { id: "1", itemName: "A", stockItemId: 55, quantity: 3, rate: 45000, rateUSD: 45000 / 613, amount: 135000 },
      ],
      isCreditSale: false,
      paymentAccountType: "cash",
      paymentAccountId: "7",
      selectedCustomerId: "",
      notes: "",
      saleDate: "2026-11-18",
      activeCurrency: "CFA",
      exchangeRate: 613,
      dailyExchangeRate: 613,
      clientSaleIdRef: { current: "abc" },
      saveMutation: { mutate },
      toast,
    } as any).handleSaveSale();
    expect(toast).not.toHaveBeenCalled();
    expect(mutate.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        currency: "CFA",
        exchangeRate: "613",
        items: [expect.objectContaining({ originalCurrencyRate: "45000.00", rate: "73.409462" })],
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
