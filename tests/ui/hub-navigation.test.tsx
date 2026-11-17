import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: 1, companyType: "erp" } }),
}));
vi.mock("@/pages/StockItems", () => ({ default: () => <div>Stock items content</div> }));
vi.mock("@/pages/StockQuery", () => ({ default: () => <div>Stock query content</div> }));
vi.mock("@/pages/OffloadItemSearch", () => ({ default: () => <div>Offload content</div> }));
vi.mock("@/pages/LocationInventory", () => ({ default: () => <div>Location inventory content</div> }));
vi.mock("@/pages/StockOTW", () => ({ default: () => <div>On the way content</div> }));
vi.mock("@/pages/ContainersPage", () => ({ default: () => <div>Containers content</div> }));

import StockHub from "@/pages/StockHub";
import InventoryHub from "@/pages/InventoryHub";

describe("hub tab navigation", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("replaces StockHub tab state without adding a page transition", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/stock");
    render(<StockHub />);

    // StockHub tabs are lazy-loaded behind a Suspense fallback.
    expect(await screen.findByText("Stock items content")).toBeInTheDocument();
    await user.click(screen.getByTestId("tab-stock-query"));

    expect(window.location.pathname).toBe("/stock");
    expect(window.location.search).toBe("?tab=query");
    expect(await screen.findByText("Stock query content")).toBeInTheDocument();
  });

  it("renders the StockHub tab selected by a valid direct URL", async () => {
    window.history.replaceState({}, "", "/stock?tab=offload");
    render(<StockHub />);

    expect(await screen.findByText("Offload content")).toBeInTheDocument();
    expect(screen.queryByText("Stock items content")).not.toBeInTheDocument();
  });

  it("canonicalizes an unsupported StockHub tab to the default", async () => {
    window.history.replaceState({}, "", "/stock?tab=retired-tab");
    render(<StockHub />);

    expect(screen.getByText("Stock items content")).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe("?tab=items"));
  });

  it("replaces InventoryHub tab state without adding a page transition", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/inventory");
    render(<InventoryHub />);

    expect(screen.getByText("Location inventory content")).toBeInTheDocument();
    await user.click(screen.getByTestId("tab-containers"));

    expect(window.location.pathname).toBe("/inventory");
    expect(window.location.search).toBe("?tab=containers");
    expect(screen.getByText("Containers content")).toBeInTheDocument();
  });

  it("renders the InventoryHub tab selected by a valid direct URL", () => {
    window.history.replaceState({}, "", "/inventory?tab=on-the-way");
    render(<InventoryHub />);

    expect(screen.getByText("On the way content")).toBeInTheDocument();
    expect(screen.queryByText("Location inventory content")).not.toBeInTheDocument();
  });

  it("canonicalizes the retired combined-inventory tab to by-location", async () => {
    window.history.replaceState({}, "", "/inventory?tab=combined");
    render(<InventoryHub />);

    expect(screen.getByText("Location inventory content")).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe("?tab=by-location"));
  });
});
