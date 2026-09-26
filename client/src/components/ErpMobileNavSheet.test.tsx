import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { ErpMobileNavSheet } from "./ErpMobileNavSheet";

vi.mock("@/contexts/ApplicationLanguageContext", () => ({
  useApplicationLanguage: () => ({ t: (key: string) => key, language: "en" }),
}));
vi.mock("@/components/ApplicationInterfaceTranslator", () => ({
  translateApprovedInterfaceText: () => null,
}));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: 1, companyType: "erp" } }),
}));
vi.mock("@/contexts/ConnectivityContext", () => ({
  useConnectivity: () => ({ conflictCount: 0 }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
}));
vi.mock("@/components/ErpMobileBottomNav", () => ({
  useErpPrimaryDestinations: () => ["/tracking", "/inventory", "/pos", "/accounts"],
}));

const hiddenUrls = new Set(["/payroll"]);
vi.mock("@/components/AppSidebar", async () => {
  const actual = await vi.importActual<typeof import("@/components/AppSidebar")>("@/components/AppSidebar");
  return {
    ...actual,
    useErpVisibleSections: () => ({
      isItemVisible: (item: { url: string }) => !hiddenUrls.has(item.url),
    }),
  };
});

afterEach(cleanup);

function renderSheet(onOpenChange = vi.fn(), path = "/daybook") {
  const { hook } = memoryLocation({ path });
  render(
    <Router hook={hook}>
      <ErpMobileNavSheet user={{ username: "u", role: "Admin" }} open onOpenChange={onOpenChange} />
    </Router>
  );
  return onOpenChange;
}

describe("ErpMobileNavSheet", () => {
  it("groups every remaining page under headings and leaves out bottom-nav destinations", () => {
    renderSheet();
    const sheet = screen.getByTestId("erp-mobile-nav-sheet");
    const accounting = within(sheet).getByTestId("erp-mobile-nav-group-accounting");
    expect(within(accounting).getByText("Daybook")).toBeInTheDocument();
    expect(within(accounting).getByText("Agent Ledger")).toBeInTheDocument();
    expect(within(sheet).getByTestId("erp-mobile-nav-group-inventory")).toHaveTextContent("Stock");
    // Bottom navigation already opens these pages directly.
    expect(within(sheet).queryByTestId("erp-mobile-nav-link-/accounts")).toBeNull();
    expect(within(sheet).queryByTestId("erp-mobile-nav-link-/tracking")).toBeNull();
    expect(within(sheet).queryByTestId("erp-mobile-nav-link-/inventory")).toBeNull();
    // Permission-hidden pages stay hidden.
    expect(within(sheet).queryByTestId("erp-mobile-nav-link-/payroll")).toBeNull();
    // Each page appears once.
    expect(within(sheet).getAllByText("Daybook")).toHaveLength(1);
  });

  it("marks the current page and closes after navigation", () => {
    const onOpenChange = renderSheet();
    const daybook = screen.getByTestId("erp-mobile-nav-link-/daybook");
    expect(daybook).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByTestId("erp-mobile-nav-link-/vouchers"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("filters pages by name", () => {
    renderSheet();
    fireEvent.change(screen.getByTestId("erp-mobile-nav-search"), { target: { value: "vouch" } });
    expect(screen.getByTestId("erp-mobile-nav-link-/vouchers")).toBeInTheDocument();
    expect(screen.getByTestId("erp-mobile-nav-link-/optional-vouchers")).toBeInTheDocument();
    expect(screen.queryByTestId("erp-mobile-nav-link-/daybook")).toBeNull();
    fireEvent.change(screen.getByTestId("erp-mobile-nav-search"), { target: { value: "zzzz" } });
    expect(screen.getByTestId("erp-mobile-nav-empty")).toBeInTheDocument();
  });
});
