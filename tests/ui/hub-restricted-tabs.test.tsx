import React from "react";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";

vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: 1, companyType: "erp" } }),
}));
vi.mock("@/pages/StockItems", () => ({ default: () => <div>Stock items content</div> }));
vi.mock("@/pages/StockQuery", () => ({ default: () => <div>Stock query content</div> }));
vi.mock("@/pages/OffloadItemSearch", () => ({ default: () => <div>Offload content</div> }));
vi.mock("@/pages/LocationInventory", () => ({ default: () => <div>Location inventory content</div> }));
vi.mock("@/pages/StockOTW", () => ({ default: () => <div>On the way content</div> }));
vi.mock("@/pages/ContainersPage", () => ({ default: () => <div>Containers content</div> }));
vi.mock("@/contexts/ApplicationLanguageContext", () => ({
  useApplicationLanguage: () => ({ t: (key: string) => key }),
}));

import StockHub from "@/pages/StockHub";
import InventoryHub from "@/pages/InventoryHub";
import { useHubQueryState } from "@/hooks/use-hub-query-state";

const access = (pageKeys: string[]) => ({ fullAccess: false, pageKeys });

describe("hub tabs restricted by ERP page access", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("shows the restricted state when no StockHub tab is permitted", () => {
    window.history.replaceState({}, "", "/stock?tab=items");
    render(<StockHub access={access(["accounts"])} />);

    expect(screen.getByTestId("restricted-tabs-state")).toBeInTheDocument();
    expect(screen.queryByTestId("tab-stock-items")).not.toBeInTheDocument();
    expect(screen.queryByText("Stock items content")).not.toBeInTheDocument();
  });

  it("falls back from a restricted StockHub tab to the first permitted one", async () => {
    window.history.replaceState({}, "", "/stock?tab=items");
    render(<StockHub access={access(["stock_query"])} />);

    expect(await screen.findByText("Stock query content")).toBeInTheDocument();
    expect(screen.queryByTestId("tab-stock-items")).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe("?tab=query"));
  });

  it("shows Stock Items, Stock Query, Offload Search, and On The Way in the same Stock workspace", async () => {
    window.history.replaceState({}, "", "/stock?tab=items");
    render(<StockHub access={access(["stock_items", "stock_query", "stock_otw"])} />);

    expect(screen.getByRole("tab", { name: "Stock Items" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Stock Query" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Offload Search" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "On The Way" })).toBeInTheDocument();
    expect(await screen.findByText("Stock items content")).toBeInTheDocument();

    act(() => screen.getByRole("tab", { name: "On The Way" }).click());
    expect(await screen.findByText("On the way content")).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe("?tab=otw"));

    act(() => screen.getByRole("tab", { name: "Stock Query" }).click());
    expect(await screen.findByText("Stock query content")).toBeInTheDocument();

    act(() => screen.getByRole("tab", { name: "Offload Search" }).click());
    expect(await screen.findByText("Offload content")).toBeInTheDocument();
  });

  it("allows OTW-only grants into Stock without exposing Stock item management", async () => {
    window.history.replaceState({}, "", "/stock?tab=items");
    render(<StockHub access={access(["stock_otw"])} />);

    expect(await screen.findByText("On the way content")).toBeInTheDocument();
    expect(screen.getByTestId("tab-stock-otw")).toBeInTheDocument();
    expect(screen.queryByTestId("tab-stock-items")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tab-stock-offload")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tab-stock-query")).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe("?tab=otw"));
  });

  it("retains On The Way in Inventory for existing bookmarks", () => {
    window.history.replaceState({}, "", "/inventory?tab=on-the-way");
    render(<InventoryHub access={access(["stock_otw"])} />);
    expect(screen.getByText("On the way content")).toBeInTheDocument();
    expect(screen.getByTestId("tab-on-the-way")).toBeInTheDocument();
    expect(screen.getByTestId("link-inventory-stock-hub")).toHaveAttribute("href", "/stock?tab=otw");
  });

  it("links Inventory to Stock Query when stock search is allowed without Stock Items", () => {
    window.history.replaceState({}, "", "/inventory?tab=on-the-way");
    render(<InventoryHub access={access(["stock_query", "stock_otw"])} />);
    expect(screen.getByTestId("link-inventory-stock-hub")).toHaveAttribute("href", "/stock?tab=query");
  });

  it("shows the restricted state when no InventoryHub tab is permitted", () => {
    window.history.replaceState({}, "", "/inventory");
    render(<InventoryHub access={access(["accounts"])} />);

    expect(screen.getByTestId("restricted-tabs-state")).toBeInTheDocument();
    expect(screen.queryByText("Location inventory content")).not.toBeInTheDocument();
  });

  it("falls back from a restricted InventoryHub tab to the first permitted one", async () => {
    window.history.replaceState({}, "", "/inventory?tab=by-location");
    render(<InventoryHub access={access(["containers"])} />);

    expect(screen.getByText("Containers content")).toBeInTheDocument();
    expect(screen.queryByTestId("tab-by-location")).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe("?tab=containers"));
  });
});

describe("useHubQueryState URL canonicalization", () => {
  const known = ["alpha", "beta", "gamma"] as const;
  type Tab = (typeof known)[number];

  beforeEach(() => {
    window.history.replaceState({}, "", "/hub");
  });

  it("adopts a recognized legacy hash and scrubs it from the URL", () => {
    window.history.replaceState({}, "", "/hub#beta");
    const { result } = renderHook(() =>
      useHubQueryState<Tab>({ key: "tab", allowedValues: known, defaultValue: "alpha" })
    );

    expect(result.current[0]).toBe("beta");
    expect(window.location.search).toBe("?tab=beta");
    expect(window.location.hash).toBe("");
  });

  it("reads keyed legacy hashes and ignores the skip-link target", () => {
    window.history.replaceState({}, "", "/hub#tab=gamma");
    const keyed = renderHook(() => useHubQueryState<Tab>({ key: "tab", allowedValues: known, defaultValue: "alpha" }));
    expect(keyed.result.current[0]).toBe("gamma");
    keyed.unmount();

    window.history.replaceState({}, "", "/hub#main-content");
    const skip = renderHook(() => useHubQueryState<Tab>({ key: "tab", allowedValues: known, defaultValue: "alpha" }));
    expect(skip.result.current[0]).toBe("alpha");
    expect(window.location.hash).toBe("#main-content");
  });

  it("scrubs a legacy hash for a known but restricted value and falls back", () => {
    window.history.replaceState({}, "", "/hub#gamma");
    const { result } = renderHook(() =>
      useHubQueryState<Tab>({
        key: "tab",
        allowedValues: ["alpha", "beta"],
        knownValues: known,
        defaultValue: "alpha",
      })
    );

    expect(result.current[0]).toBe("alpha");
    expect(window.location.hash).toBe("");
  });

  it("omits the default value and removes the key when nothing is allowed", () => {
    window.history.replaceState({}, "", "/hub?section=alpha");
    const omitted = renderHook(() =>
      useHubQueryState<Tab>({ key: "section", allowedValues: known, defaultValue: "alpha", omitDefault: true })
    );
    expect(omitted.result.current[0]).toBe("alpha");
    expect(window.location.search).toBe("");
    omitted.unmount();

    window.history.replaceState({}, "", "/hub?section=beta");
    renderHook(() => useHubQueryState<Tab>({ key: "section", allowedValues: [], defaultValue: "alpha" }));
    expect(window.location.search).toBe("");
  });

  it("clears companion keys and rejects values the user cannot see", () => {
    window.history.replaceState({}, "", "/hub?tab=alpha&page=3");
    const { result } = renderHook(() =>
      useHubQueryState<Tab>({
        key: "tab",
        allowedValues: ["alpha", "beta"],
        knownValues: known,
        defaultValue: "alpha",
        clearKeys: ["page"],
        omitDefault: true,
      })
    );

    act(() => result.current[1]("beta"));
    expect(result.current[0]).toBe("beta");
    expect(window.location.search).toBe("?tab=beta");

    act(() => result.current[1]("alpha"));
    expect(window.location.search).toBe("");

    act(() => result.current[1]("gamma"));
    expect(result.current[0]).toBe("alpha");
  });

  it("follows browser history navigation", () => {
    const { result } = renderHook(() =>
      useHubQueryState<Tab>({ key: "tab", allowedValues: known, defaultValue: "alpha" })
    );

    act(() => {
      window.history.replaceState({}, "", "/hub?tab=gamma");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current[0]).toBe("gamma");
  });
});
