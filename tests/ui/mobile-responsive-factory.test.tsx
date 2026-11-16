import React, { createRef } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FactoryMobileActionBar,
  FactoryMobileHeader,
  FactoryMobileHeaderActions,
  FactoryMobilePage,
  FactoryMobileScannerPanel,
  FactoryMobileStatus,
  FactoryMobileWorkflowGrid,
} from "@/components/ui/factory-mobile";
import { StockEntryScanner } from "@/pages/factory/bale-stock-entry/StockEntryScanner";
import { renderWithProviders } from "./helpers";
import { pageState, resetPageState, stubFetchRoutes } from "./pageMocks";

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/AppModeContext", async () => (await import("./pageMocks")).appModeMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/contexts/CurrencyContext", async () => (await import("./pageMocks")).currencyMock);
vi.mock("@/contexts/DateFormatContext", async () => (await import("./pageMocks")).dateFormatMock);
vi.mock("@/contexts/ConnectivityContext", async () => (await import("./pageMocks")).connectivityMock);
vi.mock("@/contexts/LocationContext", async () => (await import("./pageMocks")).locationContextMock);
vi.mock("@/contexts/CursorNavContext", async () => (await import("./pageMocks")).cursorNavMock);

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/** Phase 7 contract for the Factory phone workflows, checked on rendered output. */
beforeEach(() => {
  resetPageState();
  pageState.appMode = "factory";
  pageState.companyType = "factory";
  stubFetchRoutes();
});
afterEach(cleanup);

describe("Mobile responsiveness Phase 7 Factory workflows", () => {
  it("renders the Factory mobile workflow primitives with their landmarks", () => {
    render(
      <FactoryMobilePage data-testid="page">
        <FactoryMobileHeader data-testid="header">
          <h1>Bale Stock Entry</h1>
          <FactoryMobileHeaderActions data-testid="actions">
            <button type="button">Print Settings</button>
          </FactoryMobileHeaderActions>
        </FactoryMobileHeader>
        <FactoryMobileWorkflowGrid data-testid="workflow">
          <FactoryMobileScannerPanel data-testid="scanner">
            <input aria-label="Scan" />
          </FactoryMobileScannerPanel>
          <FactoryMobileStatus data-testid="status">Ready</FactoryMobileStatus>
        </FactoryMobileWorkflowGrid>
        <FactoryMobileActionBar data-testid="bar">
          <button type="button">Confirm</button>
        </FactoryMobileActionBar>
      </FactoryMobilePage>
    );

    expect(screen.getByTestId("page")).toHaveAttribute("data-factory-mobile-page", "true");
    expect(screen.getByTestId("header")).toHaveAttribute("data-factory-mobile-header", "true");
    expect(screen.getByTestId("actions")).toHaveAttribute("data-factory-mobile-actions", "true");
    expect(screen.getByTestId("workflow")).toHaveAttribute("data-factory-mobile-workflow", "true");
    expect(screen.getByTestId("scanner")).toHaveAttribute("data-factory-mobile-scanner", "true");
    expect(screen.getByTestId("status")).toHaveAttribute("data-factory-mobile-status", "true");
    const bar = screen.getByTestId("bar");
    expect(bar).toHaveAttribute("data-factory-mobile-action-bar", "true");
    // The action bar stays above the home indicator and the page leaves room for it.
    expect(bar.className).toContain("env(safe-area-inset-bottom)");
    expect(screen.getByTestId("page").className).toContain("env(safe-area-inset-bottom)");
    expect(screen.getByTestId("actions").className).toMatch(/min-\[360px\]:grid-cols-2/);
  });

  it("keeps phone containment and touch floors on the Factory workspace", () => {
    // The workspace classes are a module constant applied to #main-content; the shell itself
    // needs a signed-in user and routes, so the constant is checked where it is defined.
    const shell = source("client/src/app/FactoryShell.tsx");
    expect(shell).toContain('data-factory-workspace="true"');
    for (const token of [
      "max-sm:[&_button]:min-h-11",
      "max-sm:[&_input]:min-h-11",
      "max-sm:[&_input]:text-base",
      "[&_form]:max-w-full",
      "**:data-mobile-data-list:max-w-full",
    ]) {
      expect(shell).toContain(token);
    }
  });

  it("mounts bale stock entry on the Factory mobile page with its section tabs", async () => {
    const { default: BaleStockEntry } = await import("@/pages/factory/BaleStockEntry");
    renderWithProviders(<BaleStockEntry />);

    expect(await screen.findByTestId("tab-stock-entry")).toBeInTheDocument();
    expect(screen.getByTestId("tab-ground-scan")).toBeInTheDocument();
    expect(document.querySelector("[data-factory-mobile-page]")).not.toBeNull();
    expect(screen.getByRole("tablist", { name: "Bale stock entry sections" })).toBeInTheDocument();
    expect(document.querySelector("[data-factory-daily-summary]")).not.toBeNull();
  });

  it("makes the scanner an accessible combobox with a keyboard-driven listbox", () => {
    const onSelectProduct = vi.fn();
    const onScanKeyDown = vi.fn();
    const products = [
      { id: 1, articleCode: "A1", name: "Alpha" },
      { id: 2, articleCode: "B2", name: "Beta" },
    ] as any[];
    render(
      <StockEntryScanner
        scanRef={createRef<HTMLInputElement>()}
        scanInput="a"
        onScanInputChange={vi.fn()}
        onScanKeyDown={onScanKeyDown}
        scanError="No product matches that code"
        showDropdown
        filteredProducts={products}
        onSelectProduct={onSelectProduct}
      />
    );

    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(2);
    for (const option of options) expect(option).toHaveAttribute("type", "button");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);
    fireEvent.click(options[1]);
    expect(onSelectProduct).toHaveBeenCalledWith(products[1]);
    expect(input).toHaveAttribute("enterkeyhint", "done");
    // The scan error is a status line tied to the input.
    const status = document.querySelector("[data-factory-mobile-status]") as HTMLElement;
    expect(status).toHaveTextContent("No product matches that code");
    expect(input.getAttribute("aria-describedby") ?? "").toContain(status.id);
  });

  it("keeps the stock-entry cart's card list on landscape phones and the table on desktop", () => {
    const cart = source("client/src/pages/factory/bale-stock-entry/StockEntryCart.tsx");
    // The phone list hides from md but comes back on short coarse-pointer landscape phones.
    expect(cart).toContain('className="md:hidden phone-land:block"');
    expect(cart).toContain("md:block phone-land:hidden");
    expect(cart).toContain('scrollLabel="Bales ready for stock entry"');
    expect(cart).toContain('inputMode="numeric"');
    expect(cart).toContain('inputMode="decimal"');
    const sidebar = source("client/src/pages/factory/bale-stock-entry/StockEntrySidebar.tsx");
    expect(sidebar).toContain("FactoryMobileActionBar");
    expect(sidebar).toContain('data-testid="button-confirm-stock-entry"');
  });

  it("keeps shared Factory layout primitives free from business behaviour", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(
      <FactoryMobilePage>
        <FactoryMobileWorkflowGrid>
          <FactoryMobileScannerPanel>scan</FactoryMobileScannerPanel>
        </FactoryMobileWorkflowGrid>
      </FactoryMobilePage>
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
