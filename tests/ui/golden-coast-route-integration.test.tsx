/**
 * Golden Coast Phase 12 — route and navigation wiring.
 *
 * The Golden Coast hub page is retired (owner decision 6, 2026-11-16). The old
 * /sp/golden-coast URL stays admitted by the authenticated route guard for
 * Supplier Partner companies and nobody else, the sidebar never offered it,
 * and the top-level router now hands it to ERP routes, which redirect it to
 * SP Reports.
 */
import React, { Suspense } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { resolveAuthenticatedAppRoute } from "@/app/authenticatedAppRouteGuard";
import { SUPPLIER_PARTNER_DAILY_ITEMS, SUPPLIER_PARTNER_SECTIONS } from "@/lib/supplier-partner-navigation";

vi.mock("@/routes/ErpRoutes", () => ({ ErpRoutes: () => <div data-testid="erp-routes" /> }));
vi.mock("@/routes/PosRoutes", () => ({ PosRoutes: () => <div data-testid="pos-routes" /> }));

const guardInput = {
  isAdminOwner: false,
  myAccessLoading: false,
  myAccessError: false,
};

describe("Golden Coast route and navigation wiring", () => {
  it("admits /sp/golden-coast for a Supplier Partner company", () => {
    const { decision } = resolveAuthenticatedAppRoute({
      ...guardInput,
      currentLocation: "/sp/golden-coast",
      companyType: "supplier_partner",
    });

    expect(decision).toEqual({ kind: "continue" });
  });

  it("keeps the route closed to companies that are not Supplier Partners", () => {
    const { decision } = resolveAuthenticatedAppRoute({
      ...guardInput,
      currentLocation: "/sp/golden-coast",
      companyType: "factory",
    });

    expect(decision).toEqual({ kind: "redirect", to: "/tracking" });
  });

  it("leaves unknown Supplier Partner routes redirecting to the overview", () => {
    const { decision } = resolveAuthenticatedAppRoute({
      ...guardInput,
      currentLocation: "/sp/golden-coast-typo",
      companyType: "supplier_partner",
    });

    expect(decision).toEqual({ kind: "redirect", to: "/sp" });
  });

  it("offers Golden Coast and Setup in the Supplier Partner navigation", () => {
    expect(SUPPLIER_PARTNER_DAILY_ITEMS.map((item) => item.url)).not.toContain("/sp/golden-coast");

    const setupUrls = SUPPLIER_PARTNER_SECTIONS.flatMap((section) => section.items.map((item) => item.url));
    expect(setupUrls).toContain("/sp/setup");
    expect(setupUrls).not.toContain("/sp/setup?tab=migration");
    expect(setupUrls).not.toContain("/sp/opening-stock");
    expect(setupUrls).not.toContain("/sp/aliases");
  });

  it("hands the retired Golden Coast URL to ERP routes, which redirect it to SP Reports", async () => {
    const { Router } = await import("@/routes/AppRoutes");
    for (const path of ["/sp/golden-coast", "/sp"]) {
      window.history.replaceState({}, "", path);
      const { unmount } = render(
        <Suspense fallback={<div data-testid="route-loading" />}>
          <Router user={{ role: "Developer" }} />
        </Suspense>
      );
      await waitFor(() => expect(screen.getByTestId("erp-routes")).toBeTruthy());
      unmount();
    }
  });
});
