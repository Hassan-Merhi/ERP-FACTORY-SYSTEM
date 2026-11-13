import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

describe("Properties first-route JavaScript load budget", () => {
  it("does not fetch the global command palette or Agent Ledger before the requested route", () => {
    const shell = read("client/src/app/PropertiesShell.tsx");
    expect(shell).not.toContain('import { CommandPalette } from "@/components/CommandPalette"');
    expect(shell).toContain('import("@/components/CommandPalette")');
    expect(shell).toContain("paletteOpen && (");
    expect(shell).not.toContain('void import("@/pages/Agents")');
  });

  it("does not load Rentals before the visitor actually opens Properties Rentals", () => {
    const routes = read("client/src/app/PropertiesRoutes.tsx");
    expect(routes).not.toContain('import PropertiesRentalsHub from "@/pages/properties/PropertiesRentalsHub"');
    expect(routes).toContain('lazy(() => import("@/pages/properties/PropertiesRentalsHub"))');
  });

  it("only downloads the selected rental tab, keeping a local loading indicator", () => {
    const hub = read("client/src/pages/properties/PropertiesRentalsHub.tsx");
    expect(hub).toContain('lazy(() => import("./PropertiesRentalWarehouses"))');
    expect(hub).toContain('lazy(() => import("./PropertiesRentalShops"))');
    expect(hub).toContain('lazy(() => import("./PropertiesRentalPayments"))');
    expect(hub).toContain("<Suspense");
    expect(hub).toContain("fallback={");
  });

  it("only downloads the active Stock tab while retaining the existing shared pages", () => {
    const hub = read("client/src/pages/StockHub.tsx");
    for (const path of ["StockItems", "StockQuery", "OffloadItemSearch", "StockOTW"]) {
      expect(hub).toContain('lazy(() => import("@/pages/' + path + '"))');
      expect(hub).toContain("<" + path + " />");
    }
    expect(hub).toContain("<Suspense");
    expect(hub).toContain("fallback={");
  });

  it("still uses client-side routing, not a full document navigation, for the sidebar", () => {
    const sidebar = read("client/src/components/sidebar/sidebarPrimitives.tsx");
    expect(sidebar).toContain("<Link");
    expect(sidebar).toContain("href={item.url}");
  });
});
