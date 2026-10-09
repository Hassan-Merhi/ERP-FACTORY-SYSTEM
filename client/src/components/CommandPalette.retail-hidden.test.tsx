/**
 * Retail companies hide Sales Tools from ERP navigation, and the palette's hub
 * tab entries ("Stock Transfers", "Price List") must not bring it back through
 * Ctrl/Cmd+K. Other hub tabs stay available.
 */
import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppModeProvider } from "@/contexts/AppModeContext";
import { CommandPalette } from "./CommandPalette";

const companyState = vi.hoisted(() => ({ companyType: "erp" }));

vi.mock("wouter", () => ({ useLocation: () => ["/", vi.fn()] }));
vi.mock("@/components/AppSidebar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/AppSidebar")>();
  return {
    isRetailHiddenErpPath: actual.isRetailHiddenErpPath,
    useErpVisibleSections: () => ({ sections: [], visiblePinnedItems: [], visibleUtilityItems: [] }),
  };
});
vi.mock("@/components/FactorySidebar", () => ({ useFactoryVisibleSections: () => ({ sections: [] }) }));
vi.mock("@/components/PropertiesSidebar", () => ({ PROPERTIES_NAV_SECTIONS: [] }));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: 1, companyType: companyState.companyType } }),
}));

function renderPalette() {
  return render(
    <AppModeProvider mode="erp">
      <CommandPalette open onOpenChange={vi.fn()} isAdminOwner hasErpAccess user={{ role: "Admin" }} />
    </AppModeProvider>
  );
}

describe("command palette hub tabs for retail companies", () => {
  beforeEach(() => {
    companyState.companyType = "erp";
  });

  it("offers the Sales Tools tabs to non-retail companies", () => {
    renderPalette();
    expect(screen.getByText("Stock Transfers")).toBeInTheDocument();
    expect(screen.getByText("Price List")).toBeInTheDocument();
  });

  it("withholds the Sales Tools tabs from retail companies but keeps other hub tabs", () => {
    companyState.companyType = "retail";
    renderPalette();
    expect(screen.queryByText("Stock Transfers")).toBeNull();
    expect(screen.queryByText("Price List")).toBeNull();
    expect(screen.getByText("Suppliers")).toBeInTheDocument();
  });
});
