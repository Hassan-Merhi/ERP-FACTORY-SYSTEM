/**
 * The palette does not offer a command that navigates somewhere else.
 *
 * `adminPages` is shown in both the ERP and the factory shell, but the pages it
 * lists are registered in ErpRoutes only. Under a factory-type company the
 * route guard redirects any unprefixed path to the factory default page, so
 * selecting one of those commands silently lands the user somewhere they did
 * not ask for — which is worse than the command not being there, because it
 * looks like the feature is broken rather than absent.
 *
 * Entries carrying `erpShellOnly` are therefore dropped outside the ERP shell.
 * These tests pin both halves: present where it works, absent where it does
 * not. Several older admin entries have the same problem and are not yet
 * marked; that is a pre-existing gap, and the point of this test is that the
 * mechanism for closing it keeps working as entries are verified.
 */
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { AppModeProvider } from "@/contexts/AppModeContext";
import { CommandPalette } from "./CommandPalette";

vi.mock("wouter", () => ({ useLocation: () => ["/", vi.fn()] }));
vi.mock("@/components/AppSidebar", () => ({
  isRetailHiddenErpPath: () => false,
  useErpVisibleSections: () => ({ sections: [], visiblePinnedItems: [], visibleUtilityItems: [] }),
}));
vi.mock("@/contexts/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null }) }));
vi.mock("@/components/FactorySidebar", () => ({ useFactoryVisibleSections: () => ({ sections: [] }) }));
vi.mock("@/components/PropertiesSidebar", () => ({ PROPERTIES_NAV_SECTIONS: [] }));

const CONVERGENCE = "Convergence Reconciliation";

function renderPalette(mode: "erp" | "factory") {
  // Matching each shell's own wiring: FactoryShell passes hasErpAccess={false}
  // and hasFactoryAccess, and renders inside AppModeProvider mode="factory".
  return render(
    <AppModeProvider mode={mode}>
      <CommandPalette
        open
        onOpenChange={vi.fn()}
        isAdminOwner
        hasErpAccess={mode === "erp"}
        hasFactoryAccess={mode === "factory"}
        user={{ role: "Admin" }}
      />
    </AppModeProvider>
  );
}

describe("command palette admin entries by shell", () => {
  it("offers the convergence report in the ERP shell, where its route exists", () => {
    renderPalette("erp");
    expect(screen.getByText(CONVERGENCE)).toBeInTheDocument();
  });

  it("withholds it in the factory shell, where the guard would redirect away", () => {
    renderPalette("factory");
    expect(screen.queryByText(CONVERGENCE)).toBeNull();
  });

  it("still shows the rest of the admin group in the factory shell", () => {
    renderPalette("factory");

    // The filter has to remove one entry, not the group: dropping the whole
    // Admin & Settings heading from the factory palette would be a much larger
    // behaviour change than the defect it is fixing.
    expect(screen.getByText("Deleted Items")).toBeInTheDocument();
  });
});
