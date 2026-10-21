/**
 * useVoucherFxWalletPayment posts a Payment voucher from an FX agent's EUR
 * wallet as one settlement request. These tests pin the request it sends for
 * the USD-exchange and direct-EUR payouts and the guards that stop it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import type { VoucherFormData } from "@/pages/vouchers/voucherTypes";
import { useVoucherFxWalletPayment } from "@/pages/vouchers/useVoucherFxWalletPayment";

const WALLET = {
  wallet: { id: 7, ledgerAccountId: 70, accountName: "Access Cash" },
  state: { eur: "5000", usd: "0", totalBookUsd: "5700" },
  synchronized: true,
};

function formValues(entry: Partial<VoucherFormData["entries"][number]>): VoucherFormData {
  return {
    paymentAccountType: "ledger",
    paymentAccountId: 70,
    paymentAccountName: "Access Cash",
    voucherDate: new Date("2026-10-21T00:00:00"),
    entries: [{ accountType: "ledger", accountId: 12, accountName: "Payee", amount: "1140", narration: "", ...entry }],
    paymentAccountNarration: "",
    notes: "Agent payment",
    optional: false,
  };
}

function setup(entry: Partial<VoucherFormData["entries"][number]> = {}, supplierEur = "800") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/factory/fx-agent-wallets") return new Response(JSON.stringify({ wallets: [WALLET] }));
      if (url.includes("fxEurPayout=true")) {
        return new Response(
          JSON.stringify({
            fxEurPayable: { balance: supplierEur, basis: "native-ledger", includeOtw: false, eligible: true },
          })
        );
      }
      throw new Error("unexpected fetch " + url);
    })
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const values = formValues(entry);
  return renderHook(
    () => {
      const form = useForm<VoucherFormData>({ defaultValues: values });
      const hook = useVoucherFxWalletPayment({
        selectedCompany: { id: 4 },
        isFactoryMode: true,
        isFactoryCompany: true,
        isPOS: false,
        activeTab: "payment",
        voucherIdToEdit: null,
        paymentAccountType: "ledger",
        paymentAccountId: 70,
        entries: values.entries,
        form,
        payFromAccounts: [],
      });
      return { hook, values };
    },
    { wrapper }
  );
}

const apiRequest = vi.fn(async (_method: string, _url: string, _body?: unknown) => new Response("{}"));
const post = (result: { current: ReturnType<typeof setup>["result"]["current"] }) =>
  result.current.hook.postWalletPayment(result.current.values, {
    selectedCurrency: "USD",
    voucherEffectiveDate: "",
    modeApiRequest: apiRequest,
  });

beforeEach(() => {
  apiRequest.mockClear();
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("useVoucherFxWalletPayment", () => {
  it("offers the agent wallet as a Pay From account and recognizes the wallet payment", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.hook.isWalletPayment).toBe(true));
    expect(result.current.hook.paymentPayFromAccounts).toEqual([
      { type: "ledger", id: 70, name: "Access Cash (FX EUR)", code: "FX" },
    ]);
    expect(result.current.hook.fxPayoutCurrency).toBe("USD");
  });

  it("posts a USD payout as one settlement at the agreed rate", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.hook.isWalletPayment).toBe(true));
    act(() => result.current.hook.setFxPaymentRate("1.14"));
    await post(result);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [method, url, body] = apiRequest.mock.calls[0];
    expect(method).toBe("POST");
    expect(url).toBe("/api/factory/fx-agent-wallets/7/settle");
    expect(body).toMatchObject({
      paymentVoucher: true,
      targetCurrency: "USD",
      usdAmount: "1140.00",
      rateUsdPerEur: "1.14",
      targetKind: "ledger",
      targetId: 12,
      date: "2026-10-21",
    });
  });

  it("refuses a USD payout without a rate, to the agent itself, or beyond the wallet", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.hook.isWalletPayment).toBe(true));
    await expect(post(result)).rejects.toThrow("Enter the negotiated USD per EUR payment rate");

    act(() => result.current.hook.setFxPaymentRate("0.1"));
    await expect(post(result)).rejects.toThrow("FX agent has insufficient EUR");

    const self = setup({ accountId: 70 });
    await waitFor(() => expect(self.result.current.hook.isWalletPayment).toBe(true));
    act(() => self.result.current.hook.setFxPaymentRate("1.14"));
    await expect(post(self.result)).rejects.toThrow("FX agent cannot pay itself");
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("pays a factory supplier directly in EUR within its payable and never above it", async () => {
    const { result } = setup({ accountType: "factorySupplier", accountId: 31, amount: "800" });
    await waitFor(() => expect(result.current.hook.fxPayoutCurrency).toBe("EUR"));
    await post(result);
    expect(apiRequest.mock.calls[0][2]).toMatchObject({ targetCurrency: "EUR", eurAmount: "800.00", targetId: 31 });

    const over = setup({ accountType: "factorySupplier", accountId: 31, amount: "900" });
    await waitFor(() => expect(over.result.current.hook.fxPayoutCurrency).toBe("EUR"));
    await expect(post(over.result)).rejects.toThrow("do not exceed its EUR balance");
  });

  it("asks for confirmation and blocks incomplete payments", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.hook.isWalletPayment).toBe(true));
    const toast = vi.fn();
    expect(result.current.hook.confirmWalletPayment(result.current.values.entries, toast)).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Payment details required" }));

    act(() => result.current.hook.setFxPaymentRate("1.14"));
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    expect(result.current.hook.confirmWalletPayment(result.current.values.entries, toast)).toBe(true);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("From: Access Cash"));
  });
});
