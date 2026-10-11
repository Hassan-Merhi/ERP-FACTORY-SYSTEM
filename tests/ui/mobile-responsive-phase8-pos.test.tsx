import React, { createRef } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POSHeader } from "@/pages/pos/pos-components/POSHeader";
import { PosMobileLayout } from "@/pages/pos/pos-components/PosMobileLayout";
import { renderWithProviders } from "./helpers";
import { resetPageState, stubFetchRoutes } from "./pageMocks";

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/AppModeContext", async () => (await import("./pageMocks")).appModeMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/contexts/CurrencyContext", async () => (await import("./pageMocks")).currencyMock);
vi.mock("@/contexts/DateFormatContext", async () => (await import("./pageMocks")).dateFormatMock);
vi.mock("@/contexts/ConnectivityContext", async () => (await import("./pageMocks")).connectivityMock);
vi.mock("@/contexts/LocationContext", async () => (await import("./pageMocks")).locationContextMock);
vi.mock("@/contexts/CursorNavContext", async () => (await import("./pageMocks")).cursorNavMock);

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const location = { id: 1, name: "Main Shop" } as any;
const item = (id: number, name: string) =>
  ({
    id,
    stockItemId: id,
    name,
    itemName: name,
    stockName: name,
    quantity: 5,
    rate: 10,
    price: 10,
    barcode: `B${id}`,
  }) as any;

function mobileProps(overrides: Partial<React.ComponentProps<typeof PosMobileLayout>> = {}) {
  return {
    posUser: null,
    activeLocation: location,
    allLocations: [location],
    posAssignedLocations: [location],
    posSelectedLocation: location,
    setPosSelectedLocation: vi.fn(),
    setSelectedLocation: vi.fn(),
    saleDate: "2026-10-11",
    setSaleDate: vi.fn(),
    paymentAccountType: "cash",
    setPaymentAccountType: vi.fn(),
    paymentAccountId: null,
    setPaymentAccountId: vi.fn(),
    bankAccounts: [],
    cashLedgerAccounts: [],
    isCreditSale: false,
    setIsCreditSale: vi.fn(),
    mobileCustomerComboOpen: false,
    setMobileCustomerComboOpen: vi.fn(),
    selectedCustomerId: "",
    setSelectedCustomerId: vi.fn(),
    customerAccounts: [],
    searchTerm: "",
    setSearchTerm: vi.fn(),
    mobileSearchInputRef: createRef<HTMLInputElement>(),
    inventory: [item(1, "Blue Shirt"), item(2, "Red Shirt")],
    selectItem: vi.fn(),
    ensureItemSellable: () => true,
    resolveItemRate: () => ({ rate: 10, referenceRate: 10 }) as any,
    rows: [],
    setRows: vi.fn(),
    updateRow: vi.fn(),
    notes: "",
    setNotes: vi.fn(),
    saveMutation: { isPending: false } as any,
    hasValidItems: false,
    handleSaveSale: vi.fn(),
    formatDisplayAmount: (v: number) => v.toFixed(2),
    ...overrides,
  } as React.ComponentProps<typeof PosMobileLayout>;
}

beforeEach(() => {
  resetPageState();
  stubFetchRoutes();
});
afterEach(cleanup);

describe("Mobile responsiveness Phase 8 POS", () => {
  it("hardens the POS shell for phone and tablet workspaces", () => {
    // The shell needs a signed-in user and the POS routes; its phone contract is the workspace
    // class list and the two landmarks, checked where they are defined.
    const shell = source("client/src/app/PosShell.tsx");
    for (const token of [
      'data-pos-shell="true"',
      'data-pos-workspace="true"',
      "max-sm:[&_button]:min-h-11",
      "max-sm:[&_input]:text-base",
      "pt-[max(0.5rem,env(safe-area-inset-top))]",
      "pb-[max(0.5rem,env(safe-area-inset-bottom))]",
    ]) {
      expect(shell).toContain(token);
    }
  });

  it("renders one desktop header that only shows from lg", () => {
    renderWithProviders(
      <POSHeader
        activeLocation={location}
        showPosImport={false}
        onExportInventory={vi.fn()}
        onImportClick={vi.fn()}
        onShowStockReport={vi.fn()}
        navigate={vi.fn()}
      />
    );
    const header = document.querySelector("[data-pos-desktop-header]") as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.className).toContain("hidden");
    expect(header.className).toContain("lg:block");
  });

  it("gives the mobile sale screen an accessible product search and a pinned checkout bar", () => {
    const setSearchTerm = vi.fn();
    renderWithProviders(<PosMobileLayout {...mobileProps({ searchTerm: "shirt", setSearchTerm })} />);

    const page = document.querySelector("[data-pos-mobile-page]") as HTMLElement;
    expect(page).not.toBeNull();
    const search = screen.getByRole("combobox", { name: "Add an item" });
    expect(search).toHaveAttribute("aria-autocomplete", "list");
    const listbox = screen.getByRole("listbox", { name: "Matching stock items" });
    expect(search).toHaveAttribute("aria-controls", listbox.id);
    expect(listbox.className).toContain("max-h-[min(22rem,48dvh)]");
    const options = within(listbox).getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) expect(option.className).toMatch(/\bmin-h-14\b/);
    fireEvent.change(search, { target: { value: "blue" } });
    expect(setSearchTerm).toHaveBeenCalledWith("blue");

    const checkout = document.querySelector("[data-pos-mobile-checkout]") as HTMLElement;
    expect(checkout).not.toBeNull();
    expect(checkout.className).toContain("sticky");
    expect(checkout.className).toContain("bottom-0");
    expect(checkout.className).toContain("env(safe-area-inset-bottom)");
    expect(within(checkout).getByTestId("button-mobile-checkout")).toBeDisabled();
  });

  it("edits cart rows on the phone through the shared updateRow contract", () => {
    const updateRow = vi.fn();
    const handleSaveSale = vi.fn();
    const rows = [
      { stockItemId: 1, itemName: "Blue Shirt", quantity: 2, rate: 10, amount: 20 },
      { stockItemId: 2, itemName: "Red Shirt", quantity: 1, rate: 15, amount: 15 },
    ] as any[];
    renderWithProviders(<PosMobileLayout {...mobileProps({ rows, updateRow, handleSaveSale, hasValidItems: true })} />);

    const qty = screen.getByTestId("input-mobile-qty-0") as HTMLInputElement;
    fireEvent.change(qty, { target: { value: "3" } });
    expect(updateRow).toHaveBeenCalledWith(0, "quantity", expect.anything());
    const rate = screen.getByTestId("input-mobile-rate-1") as HTMLInputElement;
    fireEvent.change(rate, { target: { value: "12" } });
    expect(updateRow).toHaveBeenCalledWith(1, "rate", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity for Blue Shirt" }));
    expect(updateRow).toHaveBeenCalledWith(0, "quantity", "3");
    fireEvent.click(screen.getByTestId("button-mobile-checkout"));
    expect(handleSaveSale).toHaveBeenCalled();
  });

  it("mounts POS transfer orders with phone filters and paired row actions", async () => {
    stubFetchRoutes({
      "/api/stock-transfers/list": {
        items: [
          {
            voucherId: 9,
            voucherNo: "ST-9",
            date: "2026-10-01",
            status: "pending",
            fromLocation: "A",
            toLocation: "B",
          },
        ],
        total: 1,
      },
    });
    const { default: PosTransferOrders } = await import("@/pages/pos/PosTransferOrders");
    renderWithProviders(<PosTransferOrders />);

    expect(await screen.findByTestId("input-date-filter")).toBeInTheDocument();
    const filters = screen.getByRole("search", { name: "Transfer order filters" });
    expect(filters.className).toContain("grid-cols-1");
    expect(filters.className).toContain("sm:grid-cols-2");
    expect(document.querySelector("[data-pos-transfer-orders]")).not.toBeNull();
  });

  it("keeps the mobile layout free from POS mutations", () => {
    const mobile = source("client/src/pages/pos/pos-components/PosMobileLayout.tsx");
    expect(mobile).not.toContain("apiRequest(");
    expect(mobile).not.toContain("useMutation(");
  });
});
