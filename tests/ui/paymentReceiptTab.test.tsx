/**
 * PaymentReceiptTab — presentation contract for the payment/receipt voucher form.
 *
 * These cover the parts of the redesigned screen that are easy to regress by accident:
 *  - required-field warnings stay hidden until the form is submitted,
 *  - the chosen source account collapses into a summary card,
 *  - the hero total, the action-bar total and the running column all read off the
 *    same entry amounts,
 *  - Save explains why it is disabled.
 *
 * No network, no DB — the component is driven entirely through props.
 */
import React from "react";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { useForm, useFieldArray } from "react-hook-form";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PaymentReceiptTab } from "@/components/vouchers/PaymentReceiptTab";
import { renderWithProviders, stubFetch } from "./helpers";

beforeAll(() => stubFetch());

vi.mock("@/contexts/CurrencyContext", () => ({
  useCurrencyContext: () => ({
    selectedCurrency: "USD",
    convertToUSD: (v: number) => v,
    formatAmount: (v: any) => `$${Number(v ?? 0).toFixed(2)}`,
  }),
}));

vi.mock("@/contexts/DateFormatContext", () => ({
  useDateFormat: () => ({
    formatDisplayDate: (d: any) => String(d),
  }),
}));

type HarnessProps = {
  paymentAccountId?: number;
  entries?: { accountType: string; accountId: number; accountName: string; amount: string }[];
  /** Any further PaymentReceiptTab props (receipt tab, edit mode, FX payment). */
  extra?: Record<string, unknown>;
};

const ACCOUNTS = [
  { id: 11, type: "supplier" as const, name: "AJ DUBAI", code: "S-11", balance: -1683833.84 },
  { id: 12, type: "ledger" as const, name: "Accrued Rent Payable", code: "L-12", balance: -48600 },
  { id: 13, type: "ledger" as const, name: "Access Cash", code: "L-13", balance: 173.86 },
];

/** Mounts the tab with a real react-hook-form instance behind it. */
function Harness({ paymentAccountId = 0, entries = [], extra = {} }: HarnessProps) {
  const rows = entries.length > 0 ? entries : [{ accountType: "ledger", accountId: 0, accountName: "", amount: "" }];
  const form = useForm<any>({
    defaultValues: {
      voucherDate: new Date("2026-08-01T00:00:00"),
      paymentAccountId,
      paymentAccountType: paymentAccountId > 0 ? "ledger" : "",
      paymentAccountName: paymentAccountId > 0 ? "Access Cash" : "",
      optional: false,
      notes: "",
      entries: rows,
    },
  });
  const fieldArray = useFieldArray({ control: form.control, name: "entries" });
  const total = rows.reduce((sum, e) => sum + (parseFloat(e.amount || "0") || 0), 0);

  // PaymentReceiptTab is imported statically at the top of this file. It used to
  // be pulled in by a dynamic import() inside a useEffect, with the harness
  // rendering null until it resolved — which raced findBy*'s 1s default timeout.
  // The suite passed in isolation and failed under full-suite load or coverage
  // instrumentation, where transforming the module tree takes longer than the
  // wait window. vi.mock is hoisted above imports, so the context mocks below
  // still apply to a static import.

  // The app mounts a single TooltipProvider at the root; the tab relies on it for
  // the disabled Print/Export explanations.
  return (
    <TooltipProvider>
      <PaymentReceiptTab
        form={form}
        fieldArray={fieldArray}
        entries={rows}
        total={total}
        paymentAccountId={paymentAccountId}
        paymentAccountType={paymentAccountId > 0 ? "ledger" : ""}
        paymentAccountName={paymentAccountId > 0 ? "Access Cash" : ""}
        accountBalance={173.86}
        allAccounts={ACCOUNTS as any}
        sidebarAccounts={ACCOUNTS as any}
        filteredSidebarAccounts={ACCOUNTS as any}
        sidebarSearchValue=""
        setSidebarSearchValue={vi.fn()}
        sidebarHighlightedIndex={0}
        setSidebarHighlightedIndex={vi.fn()}
        selectedAccountId={null}
        selectedAccountType={null}
        handleSidebarAccountSelect={vi.fn()}
        handleAmountCommit={vi.fn()}
        handlePrint={vi.fn()}
        onSubmit={vi.fn()}
        activeTab="payment"
        activeRowIndex={null}
        setActiveRowIndex={vi.fn()}
        {...extra}
      />
    </TooltipProvider>
  );
}

describe("PaymentReceiptTab — deferred validation", () => {
  it("does not warn about the missing account on an untouched form", async () => {
    renderWithProviders(<Harness />);
    expect(await screen.findByTestId("button-save-voucher")).toBeInTheDocument();
    expect(screen.queryByTestId("voucher-validation")).not.toBeInTheDocument();
  });

  it("warns once the form has been submitted", async () => {
    renderWithProviders(<Harness />);
    const save = await screen.findByTestId("button-save-voucher");
    // The button is disabled by design, so submit the form directly.
    fireEvent.submit(save.closest("form")!);
    expect(await screen.findByTestId("voucher-validation")).toHaveTextContent("Pay From account is required");
  });
});

describe("PaymentReceiptTab — source account", () => {
  it("shows the picker and no summary card while no account is chosen", async () => {
    renderWithProviders(<Harness />);
    expect(await screen.findByTestId("field-source-picker")).not.toHaveClass("hidden");
    expect(screen.queryByTestId("card-selected-source")).not.toBeInTheDocument();
  });

  it("collapses into a summary card once an account is chosen", async () => {
    renderWithProviders(<Harness paymentAccountId={13} />);
    const card = await screen.findByTestId("card-selected-source");
    expect(card).toHaveTextContent("Access Cash");
    expect(card).toHaveTextContent("Pay From");
    expect(screen.getByTestId("field-source-picker")).toHaveClass("hidden");
  });

  it("reopens the picker via Change", async () => {
    renderWithProviders(<Harness paymentAccountId={13} />);
    fireEvent.click(await screen.findByTestId("button-change-source"));
    expect(screen.getByTestId("field-source-picker")).not.toHaveClass("hidden");
  });
});

describe("PaymentReceiptTab — totals", () => {
  const filled = [
    { accountType: "supplier", accountId: 11, accountName: "AJ DUBAI", amount: "1000" },
    { accountType: "ledger", accountId: 12, accountName: "Accrued Rent Payable", amount: "500" },
  ];

  it("states the same total in the hero and the action bar", async () => {
    renderWithProviders(<Harness paymentAccountId={13} entries={filled} />);
    expect(await screen.findByTestId("text-hero-total")).toHaveTextContent("$1500.00");
    expect(screen.getByTestId("text-total-amount")).toHaveTextContent("$1500.00");
  });

  it("accumulates the running column down the rows", async () => {
    renderWithProviders(<Harness paymentAccountId={13} entries={filled} />);
    expect(await screen.findByTestId("text-running-0")).toHaveTextContent("$1000.00");
    expect(screen.getByTestId("text-running-1")).toHaveTextContent("$1500.00");
  });

  it("shows an em dash rather than a zero before anything is entered", async () => {
    renderWithProviders(<Harness />);
    expect(await screen.findByTestId("text-hero-total")).toHaveTextContent("—");
  });
});

describe("PaymentReceiptTab — keyboard entry", () => {
  const oneRow = [{ accountType: "supplier", accountId: 11, accountName: "AJ DUBAI", amount: "1000" }];

  it("moves from the account field to that row's amount on Tab", async () => {
    renderWithProviders(<Harness paymentAccountId={13} entries={oneRow} />);
    const account = await screen.findByTestId("input-account-0");
    account.focus();
    fireEvent.keyDown(account, { key: "Tab" });

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-amount-0")));
  });

  it("adds the next row when tabbing out of the last amount", async () => {
    renderWithProviders(<Harness paymentAccountId={13} entries={oneRow} />);
    const amount = await screen.findByTestId("input-amount-0");
    expect(screen.queryByTestId("input-account-1")).not.toBeInTheDocument();

    fireEvent.keyDown(amount, { key: "Tab" });

    await waitFor(() => expect(screen.getByTestId("input-account-1")).toBeInTheDocument());
  });

  it("leaves an untouched last row alone instead of stacking blank lines", async () => {
    renderWithProviders(<Harness paymentAccountId={13} />);
    const amount = await screen.findByTestId("input-amount-0");
    fireEvent.keyDown(amount, { key: "Tab" });

    await waitFor(() => expect(screen.queryByTestId("input-account-1")).not.toBeInTheDocument());
  });

  it("goes back to the account field on ArrowLeft", async () => {
    renderWithProviders(<Harness paymentAccountId={13} entries={oneRow} />);
    const amount = await screen.findByTestId("input-amount-0");
    amount.focus();
    fireEvent.keyDown(amount, { key: "ArrowLeft" });

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-account-0")));
  });

  it("never intercepts Shift+Tab", async () => {
    renderWithProviders(<Harness paymentAccountId={13} entries={oneRow} />);
    const account = await screen.findByTestId("input-account-0");
    account.focus();
    fireEvent.keyDown(account, { key: "Tab", shiftKey: true });

    // Focus stays put — the browser's own back-tabbing takes it from here.
    expect(document.activeElement).toBe(account);
  });
});

describe("PaymentReceiptTab — save affordance", () => {
  it("explains why Save is disabled", async () => {
    renderWithProviders(<Harness />);
    expect(await screen.findByTestId("text-save-hint")).toHaveTextContent("Select a Pay From account to save");
  });

  it("drops the hint and enables Save once the voucher is complete", async () => {
    renderWithProviders(
      <Harness
        paymentAccountId={13}
        entries={[{ accountType: "supplier", accountId: 11, accountName: "AJ DUBAI", amount: "1000" }]}
      />
    );
    expect(await screen.findByTestId("button-save-voucher")).toBeEnabled();
    expect(screen.queryByTestId("text-save-hint")).not.toBeInTheDocument();
  });
});

const LINE = { accountType: "ledger", accountId: 12, accountName: "Accrued Rent Payable", amount: "100" };
const SUPPLIER_LINE = { accountType: "factorySupplier", accountId: 21, accountName: "EUR Supplier", amount: "100" };
const FX_WALLET = {
  wallet: { id: 4, ledgerAccountId: 13, accountName: "Access Cash" },
  state: { eur: "500", usd: "550", totalBookUsd: "550" },
  synchronized: true,
};
const fxProps = (overrides: Record<string, unknown> = {}) => ({
  fxWallet: FX_WALLET,
  fxPaymentRate: "1.10",
  fxPayoutCurrency: "USD",
  onFxPaymentRateChange: vi.fn(),
  onFxPayoutCurrencyChange: vi.fn(),
  ...overrides,
});

describe("PaymentReceiptTab — receipt, edit and pending states", () => {
  it("labels the receipt tab and its Receive Into account", async () => {
    renderWithProviders(<Harness paymentAccountId={13} entries={[LINE]} extra={{ activeTab: "receipt" }} />);
    expect(await screen.findByText("Receipt Voucher")).toBeInTheDocument();
    expect(screen.getByTestId("card-selected-source")).toHaveTextContent("Receive Into");
    expect(screen.getByTestId("button-save-voucher")).toHaveTextContent("Save Voucher · $100.00");
  });

  it("offers Update in edit mode and says so while it is pending", async () => {
    const { rerender } = renderWithProviders(
      <Harness paymentAccountId={13} entries={[LINE]} extra={{ isEditMode: true, originalTotal: 40 }} />
    );
    expect(await screen.findByTestId("button-save-voucher")).toHaveTextContent("Update Voucher · $100.00");
    rerender(
      <Harness
        paymentAccountId={13}
        entries={[LINE]}
        extra={{ isEditMode: true, originalTotal: 40, isPending: true }}
      />
    );
    expect(screen.getByTestId("button-save-voucher")).toHaveTextContent("Updating…");
    expect(screen.getByTestId("button-save-voucher")).toBeDisabled();
  });

  it("says Saving while a new voucher is pending", async () => {
    renderWithProviders(<Harness paymentAccountId={13} entries={[LINE]} extra={{ isPending: true }} />);
    expect(await screen.findByTestId("button-save-voucher")).toHaveTextContent("Saving…");
  });

  it("saves with Ctrl+Enter only when the voucher can be saved", async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<Harness paymentAccountId={13} entries={[LINE]} extra={{ onSubmit }} />);
    const form = (await screen.findByTestId("button-save-voucher")).closest("form")!;
    fireEvent.keyDown(form, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    const blocked = vi.fn();
    renderWithProviders(<Harness paymentAccountId={0} entries={[LINE]} extra={{ onSubmit: blocked }} />);
    const forms = screen.getAllByTestId("button-save-voucher").map((button) => button.closest("form")!);
    fireEvent.keyDown(forms[forms.length - 1], { key: "Enter", metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(blocked).not.toHaveBeenCalled();
  });
});

describe("PaymentReceiptTab — FX agent payments", () => {
  it("posts a USD payout from the wallet at the agreed rate", async () => {
    renderWithProviders(<Harness paymentAccountId={13} entries={[LINE]} extra={fxProps()} />);
    const save = await screen.findByTestId("button-save-voucher");
    expect(save).toHaveTextContent("Post Payment · USD 100.00");
    expect(save).toBeEnabled();
  });

  it("refuses a USD payout without a rate, beyond the wallet's EUR, or from an unsynchronized wallet", async () => {
    const cases = [
      fxProps({ fxPaymentRate: "0" }),
      fxProps({ fxPaymentRate: "0.10" }), // needs 1,000 EUR; the wallet holds 500
      fxProps({ fxWallet: { ...FX_WALLET, synchronized: false } }),
    ];
    for (const extra of cases) {
      const view = renderWithProviders(<Harness paymentAccountId={13} entries={[LINE]} extra={extra} />);
      expect(await screen.findByTestId("button-save-voucher")).toBeDisabled();
      view.unmount();
    }
  });

  it("refuses FX lines it cannot settle: several lines, or a payment back into the wallet itself", async () => {
    const cases = [[LINE, { ...LINE, accountId: 11 }], [{ ...LINE, accountId: FX_WALLET.wallet.ledgerAccountId }]];
    for (const entries of cases) {
      const view = renderWithProviders(<Harness paymentAccountId={13} entries={entries} extra={fxProps()} />);
      expect(await screen.findByTestId("button-save-voucher")).toBeDisabled();
      view.unmount();
    }
  });

  it("pays a factory supplier directly in EUR only up to its EUR payable", async () => {
    const direct = (fxSupplierEurBalance: number | null) =>
      fxProps({ fxPayoutCurrency: "EUR", fxSupplierEurBalance, fxSupplierEurBasis: "native-ledger" });

    let view = renderWithProviders(<Harness paymentAccountId={13} entries={[SUPPLIER_LINE]} extra={direct(250)} />);
    const save = await screen.findByTestId("button-save-voucher");
    expect(save).toHaveTextContent("Post Payment · EUR 100.00");
    expect(save).toBeEnabled();
    view.unmount();

    for (const [balance, entries] of [
      [50, [SUPPLIER_LINE]],
      [null, [SUPPLIER_LINE]],
      [250, [LINE]],
    ] as const) {
      view = renderWithProviders(
        <Harness paymentAccountId={13} entries={[...entries]} extra={direct(balance as number | null)} />
      );
      expect(await screen.findByTestId("button-save-voucher")).toBeDisabled();
      view.unmount();
    }
  });
});
