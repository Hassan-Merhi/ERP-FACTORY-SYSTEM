import React from "react";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapPin } from "lucide-react";

import { SidebarProvider } from "@/components/ui/sidebar";
import { PosSidebar } from "@/app/PosSidebar";
import { PosCartCell, PosCartGrid, PosCartRow, PosCartSummary } from "@/pages/pos/pos-components/PosCartGrid";
import { PosCheckoutField, PosCheckoutPanel } from "@/pages/pos/pos-components/PosCheckoutPanel";
import { PosSaleHeader, PosSaleSubmitButton } from "@/pages/pos/pos-components/PosSaleHeader";
import { PosSaleNotes, PosSaleScreen } from "@/pages/pos/pos-components/PosSaleLayout";
import { renderWithProviders } from "./helpers";
import { pageState, resetPageState, stubFetchRoutes } from "./pageMocks";

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/contexts/ConnectivityContext", async () => (await import("./pageMocks")).connectivityMock);

beforeEach(() => {
  resetPageState();
  stubFetchRoutes();
});
afterEach(cleanup);

const columns = [
  { key: "item", label: "Item", width: "flex-1" },
  { key: "amount", label: "Amt", width: "w-24", headerClassName: "justify-end" },
];

describe("shared POS sale components", () => {
  it("renders the cart grid with headers, numbered lines and the totals passed in", () => {
    renderWithProviders(
      <PosCartGrid
        columns={columns}
        minWidthClassName="min-w-[300px]"
        summary={<PosCartSummary itemCount={2} quantity={3} total="$ 45.00" />}
      >
        {["Blue Shirt", "Red Shirt"].map((name, index) => (
          <PosCartRow key={name} index={index} data-testid="cart-line">
            <PosCartCell width="flex-1">{name}</PosCartCell>
            <PosCartCell width="w-24">{index === 0 ? "20.00" : "25.00"}</PosCartCell>
          </PosCartRow>
        ))}
      </PosCartGrid>
    );

    expect(screen.getByText("Item")).toBeInTheDocument();
    const lines = screen.getAllByTestId("cart-line");
    expect(lines).toHaveLength(2);
    expect(within(lines[1]).getByText("2")).toBeInTheDocument();
    expect(screen.getByTestId("pos-cart-item-count")).toHaveTextContent("2");
    expect(screen.getByTestId("pos-cart-quantity")).toHaveTextContent("3.00");
    // The grid shows the screen's total as given; it never re-adds the lines.
    expect(document.querySelector("[data-pos-grand-total]")).toHaveTextContent("$ 45.00");
  });

  it("shows the empty line only when a message is given", () => {
    renderWithProviders(
      <PosCartGrid
        columns={columns}
        minWidthClassName="min-w-[300px]"
        emptyMessage="Scan an item"
        summary={<PosCartSummary itemCount={0} quantity={0} total="0" />}
      >
        {null}
      </PosCartGrid>
    );
    expect(screen.getByText("Scan an item")).toBeInTheDocument();
  });

  it("submit button shows its pending label and keeps the screen's handler and disabled rule", () => {
    const onClick = vi.fn();
    const { rerender } = renderWithProviders(
      <PosSaleSubmitButton label="Save" pending={false} pendingLabel="Saving…" onClick={onClick} data-testid="save" />
    );
    fireEvent.click(screen.getByTestId("save"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("save")).toHaveTextContent("Save");

    rerender(<PosSaleSubmitButton label="Save" pending pendingLabel="Saving…" disabled data-testid="save" />);
    expect(screen.getByTestId("save")).toHaveTextContent("Saving…");
    expect(screen.getByTestId("save")).toBeDisabled();
  });

  it("header, checkout fields and notes render inside the shared sale frame", () => {
    const onNotes = vi.fn();
    renderWithProviders(
      <PosSaleScreen variant="retail">
        <PosSaleHeader title="Point of Sale" subtitle="Sell" actions={<button type="button">Return</button>} />
        <PosCheckoutPanel ariaLabel="Sale settings">
          <PosCheckoutField field="location" icon={MapPin} label="Location" htmlFor="loc">
            <input id="loc" readOnly value="Main" />
          </PosCheckoutField>
        </PosCheckoutPanel>
        <PosSaleNotes
          id="notes"
          label="Notes"
          optionalLabel="(optional)"
          placeholder="Add a note"
          value=""
          onChange={onNotes}
          testId="notes"
        />
      </PosSaleScreen>
    );

    expect(document.querySelector('[data-pos-sale-screen="retail"]')).toHaveAttribute(
      "data-pos-modern-workspace",
      "true"
    );
    expect(screen.getByRole("heading", { name: "Point of Sale" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sale settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("Location")).toHaveValue("Main");
    fireEvent.change(screen.getByTestId("notes"), { target: { value: "gift wrap" } });
    expect(onNotes).toHaveBeenCalledWith("gift wrap");
  });
});

describe("POS sidebar on the shared shell", () => {
  const user = { id: 1, username: "cashier", role: "POS", canAccessCustomers: true } as any;

  function renderSidebar() {
    return renderWithProviders(
      <SidebarProvider>
        <PosSidebar
          user={user}
          posImportEnabled={false}
          chatUnread={undefined}
          onLogout={vi.fn()}
          identity={<span>Station</span>}
        />
      </SidebarProvider>
    );
  }

  it("keeps the POS role's own items, test ids and active state", () => {
    pageState.location = "/";
    renderSidebar();
    expect(screen.getByTestId("button-pos-tab")).toHaveAttribute("href", "/pos");
    expect(screen.getByTestId("button-daybook-tab")).toBeInTheDocument();
    // "/" opens Containers OTW for POS users, so that link is the current page.
    expect(screen.getByTestId("button-pos-containers-tab")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByTestId("button-pos-import-tab")).not.toBeInTheDocument();
    // Secondary tools stay behind "More tools" until opened.
    expect(screen.queryByTestId("button-customers-tab")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-pos-more-tools"));
    expect(screen.getByTestId("button-customers-tab")).toHaveAttribute("href", "/pos-customers");
  });

  it("opens More tools when a tool page is the current page", () => {
    pageState.location = "/my-settings";
    renderSidebar();
    expect(screen.getByTestId("button-pos-my-settings-tab")).toHaveAttribute("href", "/my-settings");
  });

  it("shows only the retail POS items for retail companies", () => {
    pageState.companyType = "retail";
    pageState.location = "/retail/pos";
    renderSidebar();
    expect(screen.getByTestId("button-pos-tab")).toHaveAttribute("href", "/retail/pos");
    expect(screen.queryByTestId("button-daybook-tab")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-pos-more-tools"));
    expect(screen.getByTestId("button-pos-my-settings-tab")).toBeInTheDocument();
    expect(screen.getByTestId("button-pos-help-training-tab")).toBeInTheDocument();
  });
});
