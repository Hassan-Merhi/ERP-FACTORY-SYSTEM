import React from "react";
import { act, screen, waitFor } from "@testing-library/react";
import { renderWithProviders, stubFetch } from "./helpers";

const navigate = vi.fn();
vi.mock("wouter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wouter")>()),
  useLocation: () => [window.location.pathname, navigate],
}));
const company = { selectedCompany: { id: 1, name: "Test Co", companyType: "properties", role: "Developer" } };
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => company,
  useOptionalCompany: () => company,
}));
vi.mock("@/pages/properties/PropertiesRentalWarehouses", () => ({ default: () => <div>Warehouses panel</div> }));
vi.mock("@/pages/properties/PropertiesRentalShops", () => ({ default: () => <div>Shops panel</div> }));
vi.mock("@/pages/properties/PropertiesRentalPayments", () => ({ default: () => <div>Payments panel</div> }));

import PropertiesRentalsHub from "@/pages/properties/PropertiesRentalsHub";
import { RentalsHub, RoutedRentalsHub } from "@/pages/properties/RentalsHub";
import { rentalSectionHref } from "@/properties/config/rentalSections";
import RentalPaymentsLog from "@/pages/properties/RentalPaymentsLog";
import PropertyRentalPage from "@/pages/properties/PropertyRentalPage";

describe("Phase 9f rentals hub", () => {
  beforeEach(() => {
    navigate.mockReset();
    window.history.replaceState({}, "", "/");
  });

  it("keeps the Properties section in ?tab= and opens old tab links", async () => {
    window.history.replaceState({}, "", "/properties/rentals?tab=shops");
    renderWithProviders(<PropertiesRentalsHub />);

    expect(await screen.findByText("Shops panel")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Shops" })).toHaveAttribute("data-state", "active");

    act(() => screen.getByRole("tab", { name: "Payments" }).click());
    expect(await screen.findByText("Payments panel")).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe("?tab=payments"));

    act(() => screen.getByRole("tab", { name: "Warehouses" }).click());
    expect(await screen.findByText("Warehouses panel")).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("moves ERP and Factory tabs between their existing routes", () => {
    window.history.replaceState({}, "", "/erp/rental/shops");
    renderWithProviders(
      <RoutedRentalsHub module="ERP" section="shops">
        <div>ERP shops</div>
      </RoutedRentalsHub>
    );

    expect(screen.getByText("ERP shops")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Warehouses", "Shops", "Payments"]);
    act(() => screen.getByRole("tab", { name: "Payments" }).click());
    expect(navigate).toHaveBeenCalledWith("/erp/rental/payments");
  });

  it("shows only the sections the user may open and hides a single-tab row", () => {
    const { rerender } = renderWithProviders(
      <RentalsHub module="FACTORY" value="shops" sections={["shops", "payments"]} onValueChange={vi.fn()}>
        <div>Factory shops</div>
      </RentalsHub>
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Shops", "Payments"]);

    rerender(
      <RentalsHub module="FACTORY" value="shops" sections={[]} onValueChange={vi.fn()}>
        <div>Factory shops</div>
      </RentalsHub>
    );
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByText("Factory shops")).toBeInTheDocument();
  });

  it("resolves every section to the route that already existed", () => {
    expect(rentalSectionHref("PROPERTIES", "warehouses")).toBe("/properties/rentals");
    expect(rentalSectionHref("PROPERTIES", "payments")).toBe("/properties/rentals?tab=payments");
    expect(rentalSectionHref("ERP", "warehouses")).toBe("/erp/rental/warehouses");
    expect(rentalSectionHref("FACTORY", "payments")).toBe("/factory/rental/payments");
  });

  it.each(["ERP", "FACTORY", "PROPERTIES"] as const)(
    "draws one PageHeader with the export menu for %s payments",
    async (module) => {
      stubFetch();
      renderWithProviders(<RentalPaymentsLog rentalModule={module} testIdPrefix="t" />);
      expect(await screen.findByTestId("text-page-title")).toHaveTextContent(/^Rental Payments Log$/);
      expect(screen.getByTestId("button-t-payments-export")).toHaveTextContent("Export");
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    }
  );

  it.each(["ERP", "FACTORY", "PROPERTIES"] as const)("uses the same unit-page header for %s", async (module) => {
    stubFetch();
    renderWithProviders(<PropertyRentalPage rentalModule={module} unitType="WAREHOUSE" testIdPrefix="u" />);
    expect(await screen.findByTestId("text-page-title")).toHaveTextContent(/^Warehouse Rentals$/);
    expect(screen.getByTestId("button-u-add-unit")).toHaveTextContent("Add Warehouse");
  });
});
