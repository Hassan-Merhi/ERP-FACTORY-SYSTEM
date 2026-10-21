/**
 * PaymentReceiptTab — FX agent EUR wallet payments and the secondary form affordances.
 *
 * When a payment is made from an FX agent's EUR wallet the tab swaps the normal source
 * card for a wallet summary and either:
 *  - pays a USD recipient at an agreed USD-per-EUR rate (agent EUR = total / rate), or
 *  - pays a factory supplier's EUR payable directly (agent EUR = total, no rate).
 * Save is held back whenever the wallet is out of sync, short of EUR, the supplier's EUR
 * balance is too small, or the recipient is not one the FX posting supports.
 *
 * No network, no DB — the component is driven entirely through props.
 */
import React from "react";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { useForm, useFieldArray } from "react-hook-form";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PaymentReceiptTab, type PaymentReceiptTabProps } from "@/components/vouchers/PaymentReceiptTab";
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

type Entry = { accountType: string; accountId: number; accountName: string; amount: string };

const ACCOUNTS = [
  { id: 11, type: "supplier" as const, name: "AJ DUBAI", code: "S-11", balance: -1683833.84 },
  { id: 12, type: "ledger" as const, name: "Accrued Rent Payable", code: "L-12", balance: -48600 },
  { id: 13, type: "ledger" as const, name: "Access Cash", code: "L-13", balance: 173.86 },
  { id: 14, type: "ledger" as const, name: "Bank Muscat", code: "L-14", balance: "2500" },
];

const WALLET = {
  wallet: { id: 7, ledgerAccountId: 13, accountName: "Access Cash" },
  state: { eur: "5000", usd: "0", totalBookUsd: "5600" },
  synchronized: true,
};

const LEDGER_ROW: Entry = { accountType: "ledger", accountId: 12, accountName: "Accrued Rent Payable", amount: "1140" };
const SUPPLIER_ROW: Entry = {
  accountType: "factorySupplier",
  accountId: 21,
  accountName: "Lyon Textiles",
  amount: "800",
};

type HarnessProps = Partial<PaymentReceiptTabProps> & {
  entries?: Entry[];
  notes?: string;
  onSubmit?: (...args: any[]) => void;
};

/** Mounts the tab with a real react-hook-form instance; any tab prop can be overridden. */
function Harness({ entries = [], notes = "", paymentAccountId = 0, onSubmit = vi.fn(), ...rest }: HarnessProps) {
  const rows = entries.length > 0 ? entries : [{ accountType: "ledger", accountId: 0, accountName: "", amount: "" }];
  const form = useForm<any>({
    defaultValues: {
      voucherDate: new Date("2026-08-01T00:00:00"),
      paymentAccountId,
      paymentAccountType: paymentAccountId > 0 ? "ledger" : "",
      paymentAccountName: paymentAccountId > 0 ? "Access Cash" : "",
      optional: true,
      notes,
      entries: rows,
    },
  });
  const fieldArray = useFieldArray({ control: form.control, name: "entries" });
  const watchedId = form.watch("paymentAccountId");
  const watchedName = form.watch("paymentAccountName");
  const total = rows.reduce((sum, e) => sum + (parseFloat(e.amount || "0") || 0), 0);

  return (
    <TooltipProvider>
      <PaymentReceiptTab
        form={form}
        fieldArray={fieldArray}
        entries={rows}
        total={total}
        paymentAccountId={watchedId}
        paymentAccountType={watchedId > 0 ? "ledger" : ""}
        paymentAccountName={watchedName}
        accountBalance={173.86}
        allAccounts={ACCOUNTS as any}
        payFromAccounts={ACCOUNTS.filter((a) => a.type === "ledger") as any}
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
        onSubmit={onSubmit}
        activeTab="payment"
        activeRowIndex={null}
        setActiveRowIndex={vi.fn()}
        {...rest}
      />
    </TooltipProvider>
  );
}

const fxSection = () => screen.getByTestId("fx-payment-voucher");

describe("PaymentReceiptTab — FX wallet, USD payout at an agreed rate", () => {
  it("replaces the source card with the EUR wallet summary", async () => {
    renderWithProviders(
      <Harness paymentAccountId={13} entries={[LEDGER_ROW]} fxWallet={WALLET} fxPaymentRate="1.14" />
    );
    const source = await screen.findByTestId("fx-payment-source");
    expect(source).toHaveTextContent("Pay from Access Cash (EUR wallet)");
    expect(source).toHaveTextContent(/EUR 5,000\.00 available/);
    expect(screen.queryByTestId("card-selected-source")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByTestId("field-source-picker")).not.toHaveClass("hidden");
    expect(screen.queryByTestId("fx-payment-source")).not.toBeInTheDocument();
  });

  it("converts the USD total to the agent's EUR deduction and enables posting", async () => {
    renderWithProviders(
      <Harness paymentAccountId={13} entries={[LEDGER_ROW]} fxWallet={WALLET} fxPaymentRate="1.14" />
    );
    const section = await screen.findByTestId("fx-payment-voucher");
    expect(section).toHaveTextContent("FX agent payment — recipient gets USD");
    expect(section).toHaveTextContent("Recipient receivesUSD 1140.00");
    expect(section).toHaveTextContent("Agent EUR deductionEUR 1,000.00");
    // A ledger recipient cannot be paid in EUR, so no payout toggle is offered.
    expect(screen.queryByTestId("fx-pay-eur")).not.toBeInTheDocument();

    const save = screen.getByTestId("button-save-voucher");
    expect(save).toBeEnabled();
    expect(save).toHaveTextContent("Post Payment · USD 1140.00");
    expect(screen.getByTestId("text-hero-total")).toHaveTextContent("$1140.00");
  });

  it("reports rate edits to the parent and blocks posting without a rate", async () => {
    const onRate = vi.fn();
    renderWithProviders(
      <Harness paymentAccountId={13} entries={[LEDGER_ROW]} fxWallet={WALLET} onFxPaymentRateChange={onRate} />
    );
    const rate = await screen.findByLabelText("Agreed payment rate — USD per 1 EUR");
    expect(screen.getByTestId("button-save-voucher")).toBeDisabled();
    expect(fxSection()).not.toHaveTextContent("Agent EUR deduction");

    fireEvent.change(rate, { target: { value: "1.2" } });
    expect(onRate).toHaveBeenCalledWith("1.2");
  });

  it("forces the voucher out of Optional while paying from a wallet", async () => {
    renderWithProviders(
      <Harness paymentAccountId={13} entries={[LEDGER_ROW]} fxWallet={WALLET} fxPaymentRate="1.14" />
    );
    const optional = await screen.findByTestId("checkbox-optional");
    expect(optional).toBeDisabled();
    expect(optional).toHaveAttribute("aria-checked", "false");
  });

  it("warns and blocks when the wallet ledger is out of sync or short of EUR", async () => {
    renderWithProviders(
      <Harness
        paymentAccountId={13}
        entries={[LEDGER_ROW]}
        fxWallet={{ ...WALLET, synchronized: false, state: { ...WALLET.state, eur: "500" } }}
        fxPaymentRate="1.14"
      />
    );
    const section = await screen.findByTestId("fx-payment-voucher");
    expect(section).toHaveTextContent("Ledger mismatch: reconcile the FX wallet before paying.");
    expect(section).toHaveTextContent("Insufficient EUR held by this agent.");
    expect(screen.getByTestId("button-save-voucher")).toBeDisabled();
  });

  it("rejects paying the FX agent itself or several recipients at once", async () => {
    const { unmount } = renderWithProviders(
      <Harness
        paymentAccountId={13}
        entries={[{ accountType: "ledger", accountId: 13, accountName: "Access Cash", amount: "100" }]}
        fxWallet={WALLET}
        fxPaymentRate="1.14"
      />
    );
    expect(await screen.findByTestId("fx-payment-voucher")).toHaveTextContent(
      "Use one factory supplier or USD ledger recipient (not the FX agent itself) per payment."
    );
    expect(screen.getByTestId("button-save-voucher")).toBeDisabled();
    unmount();

    renderWithProviders(
      <Harness paymentAccountId={13} entries={[LEDGER_ROW, LEDGER_ROW]} fxWallet={WALLET} fxPaymentRate="1.14" />
    );
    expect(await screen.findByTestId("fx-payment-voucher")).toHaveTextContent("not the FX agent itself");
  });

  it("holds Save while the wallets are still loading", async () => {
    renderWithProviders(<Harness paymentAccountId={13} entries={[LEDGER_ROW]} fxWalletsLoading />);
    expect(await screen.findByText("Loading FX wallet status before payment…")).toBeInTheDocument();
    expect(screen.getByTestId("button-save-voucher")).toBeDisabled();
  });

  it("ignores the wallet when editing an existing voucher", async () => {
    renderWithProviders(
      <Harness
        paymentAccountId={13}
        entries={[LEDGER_ROW]}
        fxWallet={WALLET}
        isEditMode
        originalTotal={1000}
        voucherNumber="PV-0042"
      />
    );
    expect(await screen.findByTestId("badge-editing")).toHaveTextContent("Editing");
    expect(screen.getByTestId("text-voucher-number")).toHaveTextContent("#PV-0042");
    expect(screen.queryByTestId("fx-payment-voucher")).not.toBeInTheDocument();
    expect(screen.getByTestId("card-selected-source")).toBeInTheDocument();
    expect(screen.getByTestId("button-save-voucher")).toHaveTextContent("Update Voucher · $1140.00");
  });
});

describe("PaymentReceiptTab — FX wallet, direct EUR supplier payment", () => {
  it("offers the payout toggle for a factory supplier and reports the choice", async () => {
    const onCurrency = vi.fn();
    renderWithProviders(
      <Harness
        paymentAccountId={13}
        entries={[SUPPLIER_ROW]}
        fxWallet={WALLET}
        fxSupplierEurBalance={1200}
        fxSupplierEurBasis="native-ledger"
        onFxPayoutCurrencyChange={onCurrency}
      />
    );
    const eur = await screen.findByTestId("fx-pay-eur");
    expect(eur).toBeEnabled();
    expect(screen.getByTestId("fx-supplier-eur-balance")).toHaveTextContent("Supplier EUR payable: EUR 1200.00");

    fireEvent.click(eur);
    expect(onCurrency).toHaveBeenLastCalledWith("EUR");
    fireEvent.click(screen.getByTestId("fx-pay-usd"));
    expect(onCurrency).toHaveBeenLastCalledWith("USD");
  });

  it("deducts the same EUR amount from the wallet with no rate", async () => {
    renderWithProviders(
      <Harness
        paymentAccountId={13}
        entries={[SUPPLIER_ROW]}
        fxWallet={WALLET}
        fxPayoutCurrency="EUR"
        fxSupplierEurBalance={1200}
        fxSupplierEurBasis="broker-statement"
      />
    );
    const section = await screen.findByTestId("fx-payment-voucher");
    expect(section).toHaveTextContent("Direct EUR supplier payment");
    expect(screen.getByTestId("fx-direct-eur-details")).toHaveTextContent("No exchange rate needed.");
    expect(screen.queryByLabelText("Agreed payment rate — USD per 1 EUR")).not.toBeInTheDocument();
    expect(screen.getByTestId("fx-supplier-eur-balance")).toHaveTextContent(
      "Broker EUR settlement balance (including OTW): EUR 1200.00"
    );
    expect(section).toHaveTextContent("Recipient receivesEUR 800.00");
    expect(section).toHaveTextContent("Agent EUR deductionEUR 800.00");
    expect(screen.getByTestId("text-hero-total")).toHaveTextContent("EUR 800.00");

    const save = screen.getByTestId("button-save-voucher");
    expect(save).toBeEnabled();
    expect(save).toHaveTextContent("Post Payment · EUR 800.00");
  });

  it("blocks paying more than the supplier's EUR balance", async () => {
    renderWithProviders(
      <Harness
        paymentAccountId={13}
        entries={[SUPPLIER_ROW]}
        fxWallet={WALLET}
        fxPayoutCurrency="EUR"
        fxSupplierEurBalance={500}
      />
    );
    expect(await screen.findByTestId("fx-payment-voucher")).toHaveTextContent("Amount exceeds supplier EUR balance.");
    expect(screen.getByTestId("button-save-voucher")).toBeDisabled();
  });

  it("only pays factory suppliers in EUR", async () => {
    renderWithProviders(
      <Harness
        paymentAccountId={13}
        entries={[LEDGER_ROW]}
        fxWallet={WALLET}
        fxPayoutCurrency="EUR"
        fxSupplierEurBalance={5000}
      />
    );
    expect(await screen.findByTestId("fx-payment-voucher")).toHaveTextContent("not the FX agent itself");
    expect(screen.getByTestId("button-save-voucher")).toBeDisabled();
  });

  it("disables the EUR option while the supplier balance loads", async () => {
    renderWithProviders(
      <Harness paymentAccountId={13} entries={[SUPPLIER_ROW]} fxWallet={WALLET} fxSupplierBalanceLoading />
    );
    expect(await screen.findByText("Loading supplier EUR balance…")).toBeInTheDocument();
    expect(screen.getByTestId("fx-pay-eur")).toBeDisabled();
    expect(screen.queryByTestId("fx-supplier-eur-balance")).not.toBeInTheDocument();
  });
});

describe("PaymentReceiptTab — keyboard save", () => {
  it("submits on Ctrl+Enter once the voucher is complete", async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<Harness paymentAccountId={13} entries={[LEDGER_ROW]} onSubmit={onSubmit} />);
    const notesToggle = await screen.findByTestId("button-toggle-notes");
    fireEvent.keyDown(notesToggle, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ paymentAccountId: 13, paymentAccountName: "Access Cash" });
  });

  it("does nothing on Ctrl+Enter while Save would be disabled", async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<Harness onSubmit={onSubmit} />);
    const notesToggle = await screen.findByTestId("button-toggle-notes");
    fireEvent.keyDown(notesToggle, { key: "Enter", metaKey: true });
    fireEvent.keyDown(notesToggle, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 20));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("PaymentReceiptTab — header actions", () => {
  it("reveals the effective date on demand and reports changes", async () => {
    const onEff = vi.fn();
    renderWithProviders(<Harness onEffectiveDateChange={onEff} />);
    fireEvent.click(await screen.findByTestId("button-show-effective-date"));
    const input = screen.getByTestId("input-effective-date");
    fireEvent.change(input, { target: { value: "2026-08-15" } });
    expect(onEff).toHaveBeenCalledWith("2026-08-15");
  });

  it("opens straight to the effective date when the voucher already has one", async () => {
    renderWithProviders(<Harness effectiveDate="2026-07-31" onEffectiveDateChange={vi.fn()} />);
    expect(await screen.findByTestId("input-effective-date")).toHaveValue("2026-07-31");
    expect(screen.queryByTestId("button-show-effective-date")).not.toBeInTheDocument();
  });

  it("disables Export until there is something to export", async () => {
    renderWithProviders(<Harness handleExportVoucher={vi.fn()} />);
    expect(await screen.findByTestId("button-export")).toBeDisabled();
    expect(screen.getByTestId("button-print")).toBeDisabled();
  });

  it("enables Print and Export for a complete voucher", async () => {
    const onPrint = vi.fn();
    renderWithProviders(
      <Harness paymentAccountId={13} entries={[LEDGER_ROW]} handlePrint={onPrint} handleExportVoucher={vi.fn()} />
    );
    fireEvent.click(await screen.findByTestId("button-print"));
    expect(onPrint).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("button-export")).toBeEnabled();
  });

  it("changes the entry date through the date input", async () => {
    renderWithProviders(<Harness />);
    const date = await screen.findByTestId("input-date-picker");
    expect(date).toHaveValue("2026-08-01");
    fireEvent.change(date, { target: { value: "2026-09-10" } });
    expect(date).toHaveValue("2026-09-10");
  });
});

describe("PaymentReceiptTab — notes", () => {
  it("opens the notes automatically when the voucher already has notes", async () => {
    renderWithProviders(<Harness notes="Paid against invoice 77" />);
    expect(await screen.findByTestId("input-notes")).toHaveValue("Paid against invoice 77");
  });

  it("keeps empty notes collapsed until toggled", async () => {
    renderWithProviders(<Harness />);
    const toggle = await screen.findByTestId("button-toggle-notes");
    expect(screen.queryByTestId("input-notes")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(await screen.findByTestId("input-notes")).toBeInTheDocument();
  });
});

describe("PaymentReceiptTab — mobile pickers", () => {
  it("picks the Pay From account from the mobile sheet, limited to pay-from accounts", async () => {
    renderWithProviders(<Harness />);
    fireEvent.click(await screen.findByTestId("input-pay-from-mobile-card"));

    expect(await screen.findByTestId("pay-from-mobile-option-14")).toHaveTextContent("Bank Muscat");
    expect(screen.getByTestId("pay-from-mobile-option-14")).toHaveTextContent("$2500.00");
    // Suppliers are not eligible as a payment source.
    expect(screen.queryByTestId("pay-from-mobile-option-11")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("input-pay-from-mobile-search"), { target: { value: "bank mus" } });
    expect(screen.queryByTestId("pay-from-mobile-option-13")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("pay-from-mobile-option-14"));
    const card = await screen.findByTestId("card-selected-source");
    expect(card).toHaveTextContent("Bank Muscat");
  });

  it("says so when the mobile search matches nothing", async () => {
    renderWithProviders(<Harness />);
    fireEvent.click(await screen.findByTestId("input-pay-from-mobile-card"));
    fireEvent.change(await screen.findByTestId("input-pay-from-mobile-search"), { target: { value: "zzz" } });
    expect(screen.getByText("No accounts match your search")).toBeInTheDocument();
  });

  it("opens the accounts drawer for entry rows", async () => {
    renderWithProviders(<Harness activeRowIndex={0} />);
    const trigger = await screen.findByTestId("button-open-accounts-drawer");
    expect(trigger).toHaveTextContent("— Row 1");
    fireEvent.click(trigger);
    expect(await screen.findByTestId("sheet-accounts-drawer")).toHaveTextContent("Accounts — Row 1");
  });
});

describe("PaymentReceiptTab — receipt mode", () => {
  it("labels the source as Receive Into and does not offer FX wallet payment", async () => {
    renderWithProviders(<Harness activeTab="receipt" fxWallet={WALLET} />);
    expect(await screen.findByText("Receipt Voucher")).toBeInTheDocument();
    expect(screen.getByTestId("text-save-hint")).toHaveTextContent("Select a Receive Into account to save");
    expect(screen.queryByTestId("fx-payment-voucher")).not.toBeInTheDocument();
  });
});
